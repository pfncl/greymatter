#!/usr/bin/env node
'use strict';
require('../lib/resolve-deps');

// Pre-tool-use hook: fires before Edit/Write/MultiEdit/Bash.
// Three responsibilities:
//   1. Hypothalamus policy classification — block/ask/warn/inform.
//   2. Lazy orientation — on first Edit/Write/MultiEdit touching a project this
//      session, surface project-scoped behavioral signals.
//   3. Pre-write signals — on Edit/Write/MultiEdit, surface signals whose
//      trigger = 'pre_write' and whose file_pattern matches the target file.
// Errors are swallowed — the hook must not interrupt the session.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadConfig } = require('../lib/config');
const { GraphDB } = require('../lib/graph-db');
const { GraphQueries } = require('../lib/graph-queries');
const { MemoryDB } = require('../lib/memory-db');
const { MemoryQueries } = require('../lib/memory-queries');
const { classifyFile, formatAlert } = require('../lib/policy-engine');

const DATA_DIR = path.join(os.homedir(), '.claude', 'greymatter');
const GRAPH_DB_PATH = path.join(DATA_DIR, 'graph.db');
const MEMORY_DB_PATH = path.join(DATA_DIR, 'memory.db');
const ORIENTED_PATH = path.join(DATA_DIR, 'tmp', 'oriented-projects.json');

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

// Emit a PreToolUse hook JSON envelope.
function outputJson(content, eventName) {
  process.stdout.write(JSON.stringify({
    additional_context: content,
    hookSpecificOutput: {
      hookEventName: eventName || 'PreToolUse',
      additionalContext: content,
    },
  }) + '\n');
}

// Load the set of projects already oriented this session.
function loadOriented() {
  try {
    const raw = fs.readFileSync(ORIENTED_PATH, 'utf-8');
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

// Persist the oriented-projects set to tmp (created on first write).
function saveOriented(set) {
  try {
    fs.mkdirSync(path.dirname(ORIENTED_PATH), { recursive: true });
    fs.writeFileSync(ORIENTED_PATH, JSON.stringify([...set]), { mode: 0o600 });
  } catch { /* best effort — hook must not fail */ }
}

// Normalize stdin payload into { toolName, filePath }. Supports both the
// modern envelope ({tool_name, tool_input}) and the flat shape.
function parseInvocation() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(0, 'utf-8'));
  } catch {
    return null;
  }
  const toolName = raw.tool_name || raw.toolName || null;
  const input = raw.tool_input || raw.toolInput || raw;
  const filePath = input.file_path || input.path || null;
  return { toolName, filePath };
}

// Render a single signal as an output line.
function formatSignal(sig) {
  const polarityChar = sig.polarity === '+' ? '✓' : '✗';
  const desc = sig.description ? ' — ' + sig.description : '';
  return `${polarityChar} [${sig.weight}] ${sig.label}${desc}`;
}

// Resolve which graph-db project contains the target file.
function resolveProject(graphDb, filePath) {
  const workspace = process.env.CLAUDE_WORKSPACE || process.cwd();
  const projectRows = graphDb.db.prepare(
    'SELECT DISTINCT project FROM nodes ORDER BY project'
  ).all();
  for (const { project } of projectRows) {
    const candidateDir = path.join(workspace, project);
    try {
      const rel = path.relative(candidateDir, filePath);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        return { projectName: project, relPath: rel };
      }
    } catch { /* not under this project dir */ }
  }
  return { projectName: null, relPath: filePath };
}

function main() {
  const invocation = parseInvocation();
  if (!invocation || !invocation.filePath) process.exit(0);
  const { toolName, filePath } = invocation;

  try { fs.accessSync(GRAPH_DB_PATH); } catch { process.exit(0); }

  let config;
  try { config = loadConfig(); } catch { process.exit(0); }

  let graphDb, graphQueries;
  try {
    graphDb = new GraphDB(GRAPH_DB_PATH);
    graphQueries = new GraphQueries(graphDb);
  } catch {
    process.exit(0);
  }

  try {
    const { projectName, relPath } = resolveProject(graphDb, filePath);
    const classification = classifyFile(relPath, graphQueries, config, projectName);
    graphDb.close();

    // ── Signal surfacing (lazy orientation + pre_write) ────────────────────
    // Only Edit/Write/MultiEdit surface write-time signals. When toolName is
    // unknown (legacy invocations), assume write-intent to preserve behavior.
    const isWriteIntent = toolName === null || WRITE_TOOLS.has(toolName);

    const orientationSignals = [];
    const preWriteSignals = [];
    const emittedIds = new Set();

    if (isWriteIntent) {
      let memDb = null;
      try {
        fs.accessSync(MEMORY_DB_PATH);
        memDb = new MemoryDB(MEMORY_DB_PATH);
        const mq = new MemoryQueries(memDb);

        // Orientation: first touch of this project this session.
        if (projectName) {
          const oriented = loadOriented();
          if (!oriented.has(projectName)) {
            for (const sig of mq.getSignalsForProject(projectName)) {
              orientationSignals.push(sig);
              emittedIds.add(sig.id);
            }
            oriented.add(projectName);
            saveOriented(oriented);
          }
        }

        // For `Write` to a non-existent path, "prefer Edit over Write" signals
        // don't apply — Write is the only option for new files. Suppress them
        // to avoid noise on every greenfield file creation.
        let fileExists = true;
        try { fs.accessSync(filePath); } catch { fileExists = false; }
        const isNewFileWrite = toolName === 'Write' && !fileExists;
        const isEditOverWriteSignal = (sig) => {
          const text = `${sig.label || ''} ${sig.description || ''}`.toLowerCase();
          return /\btargeted edits?\b|\bwhole-file rewrite|\bprefer\b.{0,30}\bedit\b/.test(text);
        };

        // Pre-write: dedupe against orientation emissions.
        for (const sig of mq.getPreWriteSignalsForFile(filePath)) {
          if (emittedIds.has(sig.id)) continue;
          // Edit tool operates with explicit old/new strings — it IS a targeted
          // edit by definition. Whole-file-rewrite reminders (e.g. seed signal
          // "Prefer targeted edits over whole-file rewrites") apply only to
          // Write, not Edit/MultiEdit. Skip them on Edit/MultiEdit to avoid
          // banner noise on every surgical change.
          if ((toolName === 'Edit' || toolName === 'MultiEdit')
              && /targeted edits|whole-file rewrites/i.test(sig.label || '')) {
            continue;
          }
          // Same signal on Write of a NEW file is also redundant — Edit isn't
          // possible against a non-existent path, Write is the only option.
          if (isNewFileWrite && isEditOverWriteSignal(sig)) continue;
          preWriteSignals.push(sig);
          emittedIds.add(sig.id);
        }
      } catch {
        // memory.db missing or unreadable — skip signal surfacing, fail open
      } finally {
        if (memDb) { try { memDb.close(); } catch { /* ignore */ } }
      }
    }

    if (!classification && orientationSignals.length === 0 && preWriteSignals.length === 0) {
      process.exit(0);
    }

    const parts = [];
    if (classification) parts.push(formatAlert(classification));
    if (orientationSignals.length > 0) {
      parts.push(`## Project signals for ${projectName}`);
      for (const sig of orientationSignals) parts.push(formatSignal(sig));
    }
    if (preWriteSignals.length > 0) {
      parts.push(`## Pre-write signals for ${filePath}`);
      for (const sig of preWriteSignals) parts.push(formatSignal(sig));
    }

    outputJson(parts.join('\n'), 'PreToolUse');

    if (classification && (classification.level === 'ask' || classification.level === 'block')) {
      process.exit(2);
    } else {
      process.exit(0);
    }
  } catch (err) {
    process.stderr.write(`greymatter pre-tool-use: ${err.message}\n`);
    try { graphDb.close(); } catch (e) { process.stderr.write(`greymatter pre-tool-use: close: ${e.message}\n`); }
    process.exit(0);
  }
}

if (require.main === module) main();

module.exports = { loadOriented, saveOriented, parseInvocation, formatSignal };
