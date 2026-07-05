#!/usr/bin/env node
'use strict';
require('../lib/resolve-deps');

const path = require('path');
const { MemoryDB } = require('../lib/memory-db');
const { MemoryQueries } = require('../lib/memory-queries');
const { loadConfig, getDataDir } = require('../lib/config');

function getMemoryDbPath() {
  const dataDir = getDataDir();
  return path.join(dataDir, 'memory.db');
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: node search.js "term1,term2" "term3" --limit 5');
    console.log('Each argument is a cluster. Terms within a cluster are comma-separated (OR).');
    console.log('Multiple clusters are AND\'d together.');
    console.log('Options: --limit N  (max results, default 10)');
    process.exit(0);
  }

  let limit = 10;
  const clusterArgs = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[++i], 10);
    } else {
      clusterArgs.push(args[i]);
    }
  }

  const clusters = clusterArgs.map(arg =>
    arg.toLowerCase().split(',').map(t => t.trim()).filter(Boolean)
  );

  console.log('greymatter search');
  console.log('Clusters: ' + clusters.map(c => '[' + c.join(', ') + ']').join(' + '));
  console.log('='.repeat(60));

  const dbPath = getMemoryDbPath();
  let db;
  try {
    db = new MemoryDB(dbPath);
  } catch (err) {
    console.error('Could not open memory.db: ' + err.message);
    console.error('Run session-start hook first to ingest conversations.');
    process.exit(1);
  }

  // Auto-rebuild FTS5 if empty but windows exist
  const ftsCount = db.db.prepare('SELECT COUNT(*) as c FROM search_index').get().c;
  const winCount = db.db.prepare('SELECT COUNT(*) as c FROM windows').get().c;
  if (ftsCount === 0 && winCount > 0) {
    console.log('Search index empty — rebuilding from stored content...');
    db.rebuildSearchIndex();
    console.log('Rebuilt index for ' + winCount + ' windows.\n');
  }

  const queries = new MemoryQueries(db);
  const results = queries.searchConversations(clusters, limit);

  if (results.length === 0) {
    console.log('\nNo results found.');
  } else {
    for (const r of results) {
      const sessionShort = r.session_id.length > 8 ? r.session_id.slice(0, 8) + '...' : r.session_id;
      console.log('\n[' + sessionShort + '] seq=' + r.seq + '  ' + (r.end_time || '').slice(0, 10) + '  scope: ' + (r.scope || 'unknown'));
      if (r.decisions && r.decisions.length > 0) {
        const decSummaries = r.decisions.map(d => d.summary).join(' | ');
        console.log('  Decisions: ' + decSummaries);
      }
      console.log('  Score: ' + r.score);
    }
  }

  console.log('\n' + results.length + ' result' + (results.length === 1 ? '' : 's'));
  db.close();
}

main();
