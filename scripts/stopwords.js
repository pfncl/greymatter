#!/usr/bin/env node
'use strict';
require('../lib/resolve-deps');

// Stopword management CLI for greymatter memory.db search filtering.
// Terms promoted to stopwords are excluded from FTS5 queries in searchConversations.
//
// Usage:
//   node greymatter/scripts/stopwords.js --noise "term1,term2"
//   node greymatter/scripts/stopwords.js --relevant "term"
//   node greymatter/scripts/stopwords.js --demote "term"
//   node greymatter/scripts/stopwords.js --list

const path = require('path');
const os = require('os');
const { MemoryDB } = require('../lib/memory-db');
const { MemoryQueries } = require('../lib/memory-queries');

const DEFAULT_DB = path.join(os.homedir(), '.claude', 'greymatter', 'memory.db');

const args = process.argv.slice(2);

function flag(name) {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

function hasFlag(name) {
  return args.includes(name);
}

const dbPath = flag('--db') || DEFAULT_DB;

if (args.length === 0 || hasFlag('--help') || hasFlag('-h')) {
  console.log(`Usage: node greymatter/scripts/stopwords.js <command>

Commands:
  --noise "term1,term2"   Flag terms as noise (auto-promote at noise_count >= 5)
  --relevant "term"       Flag term as relevant (resets noise streak, demotes if promoted)
  --demote "term"         Pull a promoted term back to non-promoted
  --list                  Show all stopword candidates with counts and status
  --db <path>             Path to memory.db (default: ~/.claude/greymatter/memory.db)`);
  process.exit(0);
}

let db, queries;
try {
  db = new MemoryDB(dbPath);
  queries = new MemoryQueries(db);
} catch (err) {
  console.error('Failed to open memory.db: ' + err.message);
  process.exit(1);
}

try {
  if (hasFlag('--noise')) {
    const val = flag('--noise');
    if (!val) { console.error('--noise requires a value'); process.exit(1); }
    const terms = val.split(',').map(t => t.trim()).filter(Boolean);
    queries.flagNoise(terms);
    console.log('Flagged as noise: ' + terms.join(', '));
    // Show newly promoted terms
    const promoted = queries.listStopwords().filter(s => s.promoted && terms.includes(s.term));
    if (promoted.length > 0) {
      console.log('Auto-promoted: ' + promoted.map(s => s.term).join(', '));
    }
  } else if (hasFlag('--relevant')) {
    const val = flag('--relevant');
    if (!val) { console.error('--relevant requires a value'); process.exit(1); }
    const terms = val.split(',').map(t => t.trim()).filter(Boolean);
    queries.flagRelevant(terms);
    console.log('Flagged as relevant: ' + terms.join(', '));
  } else if (hasFlag('--demote')) {
    const val = flag('--demote');
    if (!val) { console.error('--demote requires a value'); process.exit(1); }
    queries.demoteStopword(val.trim());
    console.log('Demoted: ' + val.trim());
  } else if (hasFlag('--list')) {
    const rows = queries.listStopwords();
    if (rows.length === 0) {
      console.log('No stopword candidates recorded.');
    } else {
      console.log('Stopword candidates:\n');
      console.log('  term                     noise  relevant  promoted  last_seen');
      console.log('  ' + '─'.repeat(70));
      for (const r of rows) {
        const term = r.term.padEnd(24);
        const noise = String(r.noise_count).padStart(5);
        const relevant = String(r.relevant_count).padStart(8);
        const promoted = r.promoted ? '  ✓' : '   ';
        const lastSeen = r.last_seen ? r.last_seen.slice(0, 10) : '';
        console.log(`  ${term} ${noise}  ${relevant}  ${promoted}    ${lastSeen}`);
      }
    }
  } else {
    console.error('Unknown command. Use --help for usage.');
    process.exit(1);
  }
} finally {
  db.close();
}
