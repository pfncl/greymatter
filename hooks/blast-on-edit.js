#!/usr/bin/env node
'use strict';
require('../lib/resolve-deps');

// PostToolUse hook for Edit/Write/MultiEdit — runs greymatter blast-radius +
// textual reference grep on the changed file and injects the result back into
// the session as additional context. Goal: hand Claude the dependency picture
// without him having to remember to ask for it.
//
// Wired in hooks/hooks.json:
//   "PostToolUse": [
//     { "matcher": "Edit|Write|MultiEdit",
//       "hooks": [{ "type": "command",
//                   "command": "node '${CLAUDE_PLUGIN_ROOT}/hooks/blast-on-edit.js'" }] }
//   ]
//
// Silent (exit 0, no output) when:
//   - file is not under a known greymatter project root
//   - file path matches a SKIP_PATH_PATTERNS entry (planning docs, project
//     .claude/ dirs, agent memory) — these are cross-referenced everywhere
//     by design and produce false-positive textual hits
//   - file basename is in GENERIC_BASENAMES (package.json, README.md, etc.) →
//     textual grep skipped (mentioned in every project's docs/instructions);
//     blast-radius (code graph) still runs
//   - blast-radius and grep both return empty
//   - greymatter scripts missing or error out
//   - file size is zero
//
// History (this file): migrated 2026-05-13 from user-level
// /root/.claude/hooks/greymatter-blast-on-edit.js into pefen-stack fork. Adds
// GENERIC_BASENAMES + SKIP_PATH_PATTERNS filters to reduce noise on planning
// markdown and generic config filenames.
//
// 2026-05-25 (v0.1.1): per-session dedup cache. Identical (file, blast, grep)
// shape only emitted once per session — repeated edits to same file that don't
// change the dependency picture silent-skip. Cache dir per session under
// tmpdir, 24h TTL purge on each call. Reason: 4× Edit to same skill file was
// firing 4× identical blast-radius output, just noise after the first hit.

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');
const QUERY = path.join(PLUGIN_ROOT, 'scripts/query.js');
const GREP = path.join(PLUGIN_ROOT, 'scripts/grep.js');
const TIMEOUT_MS = 4000;
const MAX_CONTEXT_CHARS = 1200;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;  // 24h — purge stale session dirs

// Generic config / convention filenames that appear in every project's docs
// and skill instructions. Textual grep on these produces noise (e.g. "use
// package.json", "see README.md"). Blast-radius (code-graph) still runs to
// catch real consumers.
const GENERIC_BASENAMES = new Set([
  'package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock',
  'tsconfig.json', 'tsconfig.base.json',
  'wrangler.jsonc', 'wrangler.toml',
  'README.md', 'CLAUDE.md', 'MEMORY.md',
  '.gitignore', '.npmrc', '.env.example',
  'index.ts', 'index.js',
]);

// Paths that are planning artifacts / agent context — cross-referenced by
// design, not source dependencies. Skip the dependency check entirely.
const SKIP_PATH_PATTERNS = [
  /\/docs\//,
  /\/sprints\//,
  /\.done\.md$/,
  /\/\.claude\//,
  /\/memory\//,
];

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

// Per-session dedup: identical (file, blast, grep) shape only emitted once.
// Cache file = sha256(rel + blast + grep). Subsequent edits to same file that
// don't change the dependency picture silent-skip — agent already has it.
// Cache dir per session under tmpdir; opportunistic 24h TTL purge.
function cacheHitAndMark(sessionId, rel, blast, grep) {
  if (!sessionId) return false;  // no session id → no dedup, original behavior
  const cacheDir = path.join(os.tmpdir(), `greymatter-blast-cache-${sessionId}`);
  try { fs.mkdirSync(cacheDir, { recursive: true }); } catch { return false; }

  // Opportunistic purge of stale sibling session dirs (cheap, runs on each call
  // but fs.readdirSync of tmpdir is fast and we only stat our prefix).
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (!name.startsWith('greymatter-blast-cache-')) continue;
      const p = path.join(os.tmpdir(), name);
      try {
        const st = fs.statSync(p);
        if (now - st.mtimeMs > CACHE_TTL_MS) fs.rmSync(p, { recursive: true, force: true });
      } catch {}
    }
  } catch {}

  const key = crypto.createHash('sha256')
    .update(`${rel}\n${blast || ''}\n${grep || ''}`)
    .digest('hex').slice(0, 16);
  const cacheFile = path.join(cacheDir, key);
  if (fs.existsSync(cacheFile)) return true;
  try { fs.writeFileSync(cacheFile, ''); } catch {}
  return false;
}

function safeRun(args) {
  try {
    return execFileSync('node', args, {
      timeout: TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      maxBuffer: 256 * 1024
    });
  } catch { return null; }
}

function listProjectRoots() {
  const out = safeRun([QUERY, '--list-projects']);
  if (!out) return [];
  const rows = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^(\S+)\s+→\s+(\/\S+)\s*$/);
    if (m) rows.push({ name: m[1], root: m[2] });
  }
  return rows.sort((a, b) => b.root.length - a.root.length);
}

function resolveProject(absFile, projects) {
  for (const p of projects) {
    if (absFile === p.root || absFile.startsWith(p.root + path.sep)) return p;
  }
  return null;
}

function summarizeBlastRadius(text) {
  if (!text) return null;
  const lines = text.split('\n').map(l => l.trimEnd()).filter(Boolean);
  if (!lines.length) return null;
  return lines.slice(0, 20).join('\n');
}

function summarizeGrep(text, selfRel) {
  if (!text) return null;
  const lines = text.split('\n').filter(Boolean);
  const filtered = lines.filter(l => !l.includes(selfRel));
  if (!filtered.length) return null;
  return filtered.slice(0, 20).join('\n');
}

function main() {
  let event;
  try { event = JSON.parse(readStdin() || '{}'); } catch { return; }

  const tool = event.tool_name;
  if (!['Edit', 'Write', 'MultiEdit'].includes(tool)) return;

  const file = event.tool_input && event.tool_input.file_path;
  if (!file || !path.isAbsolute(file)) return;

  // Only act on files inside known greymatter projects.
  const projects = listProjectRoots();
  if (!projects.length) return;
  const proj = resolveProject(file, projects);
  if (!proj) return;

  const rel = path.relative(proj.root, file);
  if (!rel || rel.startsWith('..')) return;

  // Skip planning docs / project .claude/ dirs / agent memory — cross-refs by
  // design, not real dependencies. Silent return.
  if (SKIP_PATH_PATTERNS.some(re => re.test(rel) || re.test(file))) return;

  // Skip very small / lock-style files.
  try {
    const st = fs.statSync(file);
    if (st.size === 0) return;
  } catch { return; }

  const blast = summarizeBlastRadius(safeRun([QUERY, '--blast-radius', rel, '--project', proj.name]));

  // Textual reference grep — basename only. Catches slash commands, READMEs,
  // plan docs, rules files that mention the file by path or name.
  // Skip grep entirely for generic basenames (false-positive heavy).
  const base = path.basename(file);
  let grep = null;
  if (!GENERIC_BASENAMES.has(base)) {
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    grep = summarizeGrep(safeRun([GREP, escaped, '--project', proj.name, '--context', '0', '--max-per-file', '3']), rel);
  }

  if (!blast && !grep) return;

  // Dedup: silent skip if this exact (file, blast, grep) shape was already
  // emitted in this session. Editing same file multiple times without changing
  // its dependency picture = no value in re-injecting identical context.
  const sessionId = event.session_id || process.env.CLAUDE_SESSION_ID || null;
  if (cacheHitAndMark(sessionId, rel, blast, grep)) return;

  const parts = [];
  parts.push(`greymatter: post-edit dependency check on \`${proj.name}/${rel}\``);
  if (blast) parts.push('\n[blast-radius]\n' + blast);
  if (grep) parts.push('\n[textual references]\n' + grep);
  parts.push('\nIf this edit changes contracts (renames, signature changes, deletions), the dependents above may break or drift.');

  let body = parts.join('\n');
  if (body.length > MAX_CONTEXT_CHARS) {
    body = body.slice(0, MAX_CONTEXT_CHARS - 20) + '\n…(truncated)';
  }

  const payload = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: body
    }
  };
  process.stdout.write(JSON.stringify(payload));
}

main();
