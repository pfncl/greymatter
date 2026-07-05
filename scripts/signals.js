#!/usr/bin/env node
'use strict';
require('../lib/resolve-deps');

const path = require('path');
const fs = require('fs');
const os = require('os');

const { MemoryDB } = require('../lib/memory-db');
const { MemoryQueries } = require('../lib/memory-queries');
const { loadConfig } = require('../lib/config');
const { detectOverlaps, consolidationSuggestion } = require('./lessons');

function getDataDir() {
  return path.join(os.homedir(), '.claude', 'greymatter');
}

function openMemoryDb(dataDir) {
  const dbPath = path.join(dataDir, 'memory.db');
  return new MemoryDB(dbPath);
}

function getThreshold(config) {
  return (config && config.signals && config.signals != null)
    ? (typeof config.signals === 'object' ? (config.signals.threshold != null ? config.signals.threshold : 75) : 75)
    : 75;
}

// --generate: regenerate greymatter-signals.md. Defaults to ~/.claude/rules/greymatter-signals.md;
// callers can override via rulesDir (used by session-start for test injection).
function cmdGenerate(dataDir, config, rulesDir) {
  const db = openMemoryDb(dataDir);
  const queries = new MemoryQueries(db);
  const threshold = getThreshold(config);
  try {
    const md = queries.generateSignalsMd(threshold);
    const destDir = rulesDir || path.join(os.homedir(), '.claude', 'rules');
    const signalsPath = path.join(destDir, 'greymatter-signals.md');
    fs.mkdirSync(path.dirname(signalsPath), { recursive: true });
    fs.writeFileSync(signalsPath, md, { mode: 0o644 });
    // Count active signals/forces above threshold
    const signals = queries.getActiveSignals('passive', threshold);
    const allSignals = queries.getAllSignals().filter(s => !s.archived && s.weight >= threshold);
    const forces = queries.getActiveForces(threshold);
    console.log(`Generated greymatter-signals.md (${allSignals.length} signals, ${forces.length} forces)`);
  } finally {
    db.close();
  }
}

// --review: show all signals grouped by type with weight, token cost estimate, overlap detection
function cmdReview(dataDir) {
  const db = openMemoryDb(dataDir);
  const queries = new MemoryQueries(db);
  try {
    const signals = queries.getAllSignals();
    const forces = queries.getAllForces();

    const TYPES = ['amygdala', 'nucleus_accumbens', 'prefrontal', 'hippocampus'];
    let totalTokens = 0;

    console.log('\n=== Signal Review ===\n');

    for (const type of TYPES) {
      const group = signals.filter(s => s.type === type && !s.archived);
      if (group.length === 0) continue;
      group.sort((a, b) => b.weight - a.weight);
      const tokens = group.reduce((sum, s) => {
        const words = [s.label, s.description || ''].join(' ').split(/\s+/).filter(Boolean).length;
        return sum + Math.ceil(words * 1.3);
      }, 0);
      totalTokens += tokens;
      console.log(`[${type}] — ${group.length} signals (~${tokens} tokens)`);
      for (const s of group) {
        const archived = s.archived ? ' [ARCHIVED]' : '';
        const desc = s.description ? ` — ${s.description}` : '';
        console.log(`  ${s.id}. [${s.weight}] (${s.polarity}) ${s.label}${desc}${archived}`);
      }
      // Overlap detection via lessons.js: transitive clusters by label-similarity or file_pattern
      const clusters = detectOverlaps(group);
      if (clusters.length > 0) {
        console.log(`  ⚠ Possible overlaps (${clusters.length} cluster${clusters.length === 1 ? '' : 's'}):`);
        for (const cluster of clusters) {
          const ids = cluster.map(s => `#${s.id}`).join(', ');
          console.log(`    [${ids}]`);
          for (const s of cluster) {
            console.log(`      #${s.id} [${s.weight}] "${s.label}"`);
          }
          const merged = consolidationSuggestion(cluster);
          if (merged) {
            console.log(`      → suggested merge: [${merged.weight}] "${merged.label}"`);
          }
        }
      }
      console.log('');
    }

    // Archived signals summary
    const archived = signals.filter(s => s.archived);
    if (archived.length > 0) {
      console.log(`[archived] — ${archived.length} archived signals (not loaded)`);
      console.log('');
    }

    if (forces.length > 0) {
      const fTokens = forces.filter(f => !f.archived).reduce((sum, f) => {
        const words = [f.name, f.description || ''].join(' ').split(/\s+/).filter(Boolean).length;
        return sum + Math.ceil(words * 1.3);
      }, 0);
      totalTokens += fTokens;
      console.log(`[forces] — ${forces.filter(f => !f.archived).length} active forces (~${fTokens} tokens)`);
      for (const f of forces.filter(f => !f.archived)) {
        const desc = f.description ? ` — ${f.description}` : '';
        console.log(`  ${f.id}. [${f.score}] ${f.name}${desc}`);
      }
      console.log('');
    }

    console.log(`Total estimated tokens: ~${totalTokens}`);
  } finally {
    db.close();
  }
}

// --migrate: import from existing ~/.claude/brain/signals.db
function cmdMigrate(dataDir) {
  const srcPath = path.join(os.homedir(), '.claude', 'brain', 'signals.db');
  if (!fs.existsSync(srcPath)) {
    console.error(`No signals.db found at ${srcPath}`);
    process.exit(1);
  }

  // Use better-sqlite3 to open old db
  const Database = require('better-sqlite3');
  const srcDb = new Database(srcPath, { readonly: true });
  const destDb = openMemoryDb(dataDir);
  const destQueries = new MemoryQueries(destDb);

  let migratedSignals = 0;
  let migratedForces = 0;

  try {
    // Migrate lessons → signals
    let lessons = [];
    try {
      lessons = srcDb.prepare('SELECT * FROM lessons WHERE status != ?').all('archived');
    } catch { /* table may not exist */ }

    for (const lesson of lessons) {
      // Map old fields to new schema
      const polarity = lesson.polarity === 'positive' ? '+' : '-';
      const weight = lesson.initial_weight != null ? lesson.initial_weight : 50;
      // Best-effort type mapping: negative → amygdala, positive → nucleus_accumbens
      const type = polarity === '+' ? 'nucleus_accumbens' : 'amygdala';
      const label = lesson.title || lesson.summary || 'Migrated signal';
      const description = lesson.entry_text || lesson.correction_text || null;

      destDb.insertSignal({ type, weight, polarity, label, description, trigger: 'passive' });
      migratedSignals++;
    }

    // Migrate forces
    let forces = [];
    try {
      forces = srcDb.prepare('SELECT * FROM forces WHERE status != ?').all('archived');
    } catch { /* table may not exist */ }

    for (const force of forces) {
      const name = force.title || force.name || 'Migrated force';
      const description = force.description || force.summary || null;
      const score = force.score != null ? force.score : 50;
      destDb.insertForce({ name, description, score });
      migratedForces++;
    }

    console.log(`Migrated ${migratedSignals} signals + ${migratedForces} forces`);
  } finally {
    srcDb.close();
    destDb.close();
  }
}

// Signal add command
function cmdAddSignal(dataDir, config, args) {
  const opts = parseFlags(args);
  const type = opts['--type'];
  const polarity = opts['--polarity'];
  const label = opts['--label'];
  const weight = opts['--weight'] != null ? parseFloat(opts['--weight']) : 75;
  const trigger = opts['--trigger'] || 'passive';
  const description = opts['--description'] || null;
  const filePattern = opts['--file-pattern'] || null;

  if (!type || !polarity || !label) {
    console.error('Usage: signals.js add --type <type> --polarity <+|-> --label <label> [--weight N] [--trigger <trigger>] [--description <text>]');
    process.exit(1);
  }

  const db = openMemoryDb(dataDir);
  try {
    const id = db.insertSignal({ type, weight, polarity, label, description, filePattern, trigger });
    console.log(`Added signal #${id}: "${label}"`);
  } finally {
    db.close();
  }
  cmdGenerate(dataDir, config);
}

// Signal update command
function cmdUpdateSignal(dataDir, config, id, args) {
  const opts = parseFlags(args);
  const db = openMemoryDb(dataDir);
  try {
    if (opts['--weight'] != null) {
      db.updateSignalWeight(parseInt(id), parseFloat(opts['--weight']));
      console.log(`Updated signal #${id} weight to ${opts['--weight']}`);
    } else {
      console.error('Nothing to update. Use --weight <N>');
      process.exit(1);
    }
  } finally {
    db.close();
  }
  cmdGenerate(dataDir, config);
}

// Signal archive command
function cmdArchiveSignal(dataDir, config, id) {
  const db = openMemoryDb(dataDir);
  try {
    db.archiveSignal(parseInt(id));
    console.log(`Archived signal #${id}`);
  } finally {
    db.close();
  }
  cmdGenerate(dataDir, config);
}

// Force add command
function cmdAddForce(dataDir, config, args) {
  const opts = parseFlags(args);
  const name = opts['--name'];
  const description = opts['--description'] || null;
  const score = opts['--score'] != null ? parseFloat(opts['--score']) : 75;

  if (!name) {
    console.error('Usage: signals.js add-force --name <name> [--description <text>] [--score N]');
    process.exit(1);
  }

  const db = openMemoryDb(dataDir);
  try {
    const id = db.insertForce({ name, description, score });
    console.log(`Added force #${id}: "${name}"`);
  } finally {
    db.close();
  }
  cmdGenerate(dataDir, config);
}

// Force update command
function cmdUpdateForce(dataDir, config, id, args) {
  const opts = parseFlags(args);
  const db = openMemoryDb(dataDir);
  try {
    if (opts['--score'] != null) {
      db.updateForceScore(parseInt(id), parseFloat(opts['--score']));
      console.log(`Updated force #${id} score to ${opts['--score']}`);
    } else {
      console.error('Nothing to update. Use --score <N>');
      process.exit(1);
    }
  } finally {
    db.close();
  }
  cmdGenerate(dataDir, config);
}

// Simple flag parser: --key value pairs
function parseFlags(args) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && i + 1 < args.length && !args[i + 1].startsWith('--')) {
      opts[args[i]] = args[i + 1];
      i++;
    } else if (args[i].startsWith('--')) {
      opts[args[i]] = true;
    }
  }
  return opts;
}

function main() {
  const args = process.argv.slice(2);
  const dataDir = getDataDir();
  const config = loadConfig(dataDir);

  const cmd = args[0];

  if (cmd === '--generate') {
    cmdGenerate(dataDir, config);
  } else if (cmd === '--review') {
    cmdReview(dataDir);
  } else if (cmd === '--migrate') {
    cmdMigrate(dataDir);
  } else if (cmd === 'add') {
    cmdAddSignal(dataDir, config, args.slice(1));
  } else if (cmd === 'update') {
    const id = args[1];
    cmdUpdateSignal(dataDir, config, id, args.slice(2));
  } else if (cmd === 'archive') {
    const id = args[1];
    cmdArchiveSignal(dataDir, config, id);
  } else if (cmd === 'add-force') {
    cmdAddForce(dataDir, config, args.slice(1));
  } else if (cmd === 'update-force') {
    const id = args[1];
    cmdUpdateForce(dataDir, config, id, args.slice(2));
  } else {
    console.error([
      'Usage:',
      '  signals.js add --type <type> --polarity <+|-> --label <label> [--weight N] [--trigger <trigger>]',
      '  signals.js update <id> --weight <N>',
      '  signals.js archive <id>',
      '  signals.js add-force --name <name> [--score N] [--description <text>]',
      '  signals.js update-force <id> --score <N>',
      '  signals.js --review',
      '  signals.js --generate',
      '  signals.js --migrate',
    ].join('\n'));
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { cmdGenerate, cmdReview, cmdMigrate };
