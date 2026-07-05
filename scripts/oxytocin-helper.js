#!/usr/bin/env node
'use strict';
require('../lib/resolve-deps');

// Last-mile validator + persister for /oxytocin. Adds, updates, or reinforces
// a relational force. Looks up existing forces by name for update/reinforce.

const path = require('path');
const os = require('os');

const { MemoryDB } = require('../lib/memory-db');
const { loadConfig } = require('../lib/config');
const { cmdGenerate } = require('./signals');

const VALID_ACTIONS = ['add', 'update', 'reinforce'];
const REINFORCE_DELTA = 5;

function getDefaultDataDir() {
  return path.join(os.homedir(), '.claude', 'greymatter');
}

function validate({ name, score, action }) {
  if (!name || typeof name !== 'string' || name.trim() === '') {
    throw new Error('name is required and must be a non-empty string');
  }
  if (!VALID_ACTIONS.includes(action)) {
    throw new Error(`action must be one of ${VALID_ACTIONS.join(', ')}`);
  }
  if (score != null) {
    const s = Number(score);
    if (!Number.isInteger(s) || s < 0 || s > 100) {
      throw new Error('score must be an integer between 0 and 100');
    }
  }
}

// Find an active (non-archived) force by name — used by update/reinforce paths.
function findForceByName(db, name) {
  return db.db.prepare(
    'SELECT * FROM forces WHERE name = ? AND archived = 0 ORDER BY id DESC LIMIT 1'
  ).get(name);
}

function run(opts, { dataDir, skipGenerate } = {}) {
  const { name, description = null, score = null, action } = opts || {};
  validate({ name, score, action });

  const dir = dataDir || getDefaultDataDir();
  const db = new MemoryDB(path.join(dir, 'memory.db'));
  let row;
  try {
    if (action === 'add') {
      if (score == null) throw new Error('score is required for action=add');
      const id = db.insertForce({ name, description, score });
      row = db.db.prepare('SELECT * FROM forces WHERE id = ?').get(id);
    } else if (action === 'update') {
      const existing = findForceByName(db, name);
      if (!existing) throw new Error(`no active force named "${name}"`);
      if (score != null) db.updateForceScore(existing.id, score);
      if (description != null) {
        db.db.prepare(
          'UPDATE forces SET description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        ).run(description, existing.id);
      }
      row = db.db.prepare('SELECT * FROM forces WHERE id = ?').get(existing.id);
    } else if (action === 'reinforce') {
      const existing = findForceByName(db, name);
      if (!existing) throw new Error(`no active force named "${name}"`);
      // Bump by REINFORCE_DELTA, capped at 100.
      const newScore = Math.min(100, Math.round(existing.score) + REINFORCE_DELTA);
      db.updateForceScore(existing.id, newScore);
      row = db.db.prepare('SELECT * FROM forces WHERE id = ?').get(existing.id);
    }
  } finally {
    db.close();
  }

  if (!skipGenerate) {
    const config = loadConfig(dir);
    cmdGenerate(dir, config);
  }
  return row;
}

function parseFlags(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      opts[a.slice(2)] = argv[++i];
    } else if (a.startsWith('--')) {
      opts[a.slice(2)] = true;
    }
  }
  return opts;
}

function main() {
  const flags = parseFlags(process.argv.slice(2));
  const score = flags.score != null ? parseInt(flags.score, 10) : null;
  try {
    const row = run({
      name: flags.name,
      description: flags.description || null,
      score,
      action: flags.action,
    }, { dataDir: flags['data-dir'] });
    console.log('Force record:');
    console.log(JSON.stringify(row, null, 2));
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { run, validate, findForceByName, REINFORCE_DELTA };
