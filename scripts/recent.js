#!/usr/bin/env node
'use strict';
require('../lib/resolve-deps');

// On-demand query: "what did we do on <project> last time?"
// Returns structured raw material — sessions, files, decisions, optional git log —
// for the assistant to synthesize a live answer from. No heuristic summaries.

const path = require('path');
const { execSync } = require('child_process');
const fs = require('fs');
const { MemoryDB } = require('../lib/memory-db');
const { MemoryQueries } = require('../lib/memory-queries');
const { getDataDir } = require('../lib/config');

function getMemoryDbPath() {
  return path.join(getDataDir(), 'memory.db');
}

// Parse argv into a flag bag.
function parseArgs(argv) {
  const opts = { project: null, limit: 3, noGit: false, json: false, projectRoot: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project' && argv[i + 1]) { opts.project = argv[++i]; }
    else if (a === '--limit' && argv[i + 1]) { opts.limit = parseInt(argv[++i], 10) || 3; }
    else if (a === '--no-git') { opts.noGit = true; }
    else if (a === '--json') { opts.json = true; }
    else if (a === '--project-root' && argv[i + 1]) { opts.projectRoot = argv[++i]; }
  }
  return opts;
}

function usage() {
  console.log('Usage: node recent.js --project <name> [--limit N] [--no-git] [--json] [--project-root <path>]');
}

// Collect git commits whose author-date falls inside the session window.
// Returns an array of { hash, subject, stats: { files, insertions, deletions } }.
function collectGitCommits(projectRoot, startTime, endTime) {
  if (!projectRoot || !fs.existsSync(path.join(projectRoot, '.git'))) return null;
  if (!startTime || !endTime) return [];
  try {
    const out = execSync(
      `git log --since="${startTime}" --until="${endTime}" --shortstat --format="%H%n%s"`,
      { cwd: projectRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return parseGitLog(out);
  } catch {
    return [];
  }
}

// Parse `git log --shortstat --format="%H%n%s"` into structured commits.
function parseGitLog(raw) {
  const commits = [];
  const lines = raw.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^[0-9a-f]{7,40}$/.test(line.trim())) {
      const hash = line.trim();
      const subject = lines[i + 1] || '';
      let stats = { files: 0, insertions: 0, deletions: 0 };
      let j = i + 2;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j < lines.length && /files? changed/.test(lines[j])) {
        stats = parseShortstatLine(lines[j]);
        j++;
      }
      commits.push({ hash, subject, stats });
      i = j;
    } else {
      i++;
    }
  }
  return commits;
}

function parseShortstatLine(line) {
  const m = {
    files: (line.match(/(\d+) files? changed/) || [0, 0])[1],
    insertions: (line.match(/(\d+) insertions?\(\+\)/) || [0, 0])[1],
    deletions: (line.match(/(\d+) deletions?\(-\)/) || [0, 0])[1],
  };
  return { files: +m.files, insertions: +m.insertions, deletions: +m.deletions };
}

// Render a session block in human-readable text format.
function formatSessionText(session, commits) {
  const lines = [];
  lines.push(`SESSION ${session.session_id} · ${session.start_time || '?'} → ${session.end_time || '?'}`);
  lines.push(`  files (${session.files.length} touched):`);
  for (const f of session.files.slice(0, 25)) {
    lines.push(`    ${f.file_path}`);
  }
  if (session.files.length > 25) lines.push(`    ...and ${session.files.length - 25} more`);
  lines.push(`  decisions:`);
  if (session.decisions.length === 0) {
    lines.push(`    (none)`);
  } else {
    for (const d of session.decisions) {
      lines.push(`    - ${d.summary}`);
    }
  }
  if (commits === null) {
    lines.push(`  commits: (not a git repo)`);
  } else if (commits.length === 0) {
    lines.push(`  commits: (none in window)`);
  } else {
    lines.push(`  commits (${commits.length}):`);
    for (const c of commits) {
      lines.push(`    ${c.hash.slice(0, 10)} ${c.subject}`);
      if (c.stats.files) {
        lines.push(`      +${c.stats.insertions} -${c.stats.deletions} across ${c.stats.files} files`);
      }
    }
  }
  return lines.join('\n');
}

function run(opts) {
  if (!opts.project) {
    usage();
    process.exit(opts.project === null ? 1 : 0);
  }

  let db;
  try {
    db = new MemoryDB(getMemoryDbPath());
  } catch (err) {
    const msg = `Could not open memory.db: ${err.message}`;
    if (opts.json) {
      console.log(JSON.stringify({ error: msg, sessions: [] }));
    } else {
      console.error(msg);
    }
    process.exit(1);
  }

  const queries = new MemoryQueries(db);
  const sessions = queries.getRecentSessionsForProject(opts.project, opts.limit);

  if (sessions.length === 0) {
    if (opts.json) {
      console.log(JSON.stringify([]));
    } else {
      console.log(`no recent sessions for ${opts.project}`);
    }
    db.close();
    return;
  }

  const sessionsWithCommits = sessions.map(s => {
    const commits = opts.noGit ? null : collectGitCommits(opts.projectRoot, s.start_time, s.end_time);
    return { session: s, commits };
  });

  if (opts.json) {
    const out = sessionsWithCommits.map(({ session, commits }) => ({
      session_id: session.session_id,
      start_time: session.start_time,
      end_time: session.end_time,
      files: session.files.map(f => f.file_path),
      decisions: session.decisions.map(d => ({ summary: d.summary, status: d.status })),
      commits: commits === null ? [] : commits,
    }));
    console.log(JSON.stringify(out, null, 2));
  } else {
    for (const { session, commits } of sessionsWithCommits) {
      console.log(formatSessionText(session, commits));
      console.log('');
    }
  }

  db.close();
}

if (require.main === module) {
  run(parseArgs(process.argv.slice(2)));
}

module.exports = { parseArgs, collectGitCommits, parseGitLog, formatSessionText, run };
