#!/usr/bin/env node
'use strict';
require('../lib/resolve-deps');

const fs = require('fs');
const path = require('path');
const os = require('os');

const { MemoryDB } = require('../lib/memory-db');
const { loadConfig } = require('../lib/config');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const LESSONS_PATH = path.join(PLUGIN_ROOT, 'seed', 'starter-lessons.json');
const FORCES_PATH = path.join(PLUGIN_ROOT, 'seed', 'starter-forces.json');

function getDefaultDataDir() {
  return path.join(os.homedir(), '.claude', 'greymatter');
}

function readSeeds() {
  const lessons = JSON.parse(fs.readFileSync(LESSONS_PATH, 'utf-8'));
  const forces = JSON.parse(fs.readFileSync(FORCES_PATH, 'utf-8'));
  return { lessons, forces };
}

function countRows(db, table) {
  return db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

function seed(dataDir = getDefaultDataDir(), opts = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'memory.db');
  // MemoryDB constructor creates the file and initializes schema if missing.
  const db = new MemoryDB(dbPath);
  let signalCount, forceCount;
  try {
    signalCount = countRows(db, 'signals');
    forceCount = countRows(db, 'forces');

    if (signalCount > 0 || forceCount > 0) {
      const msg = `Signals or forces already exist (signals=${signalCount}, forces=${forceCount}). Skipping seed.`;
      if (!opts.quiet) console.log(msg);
      return { seeded: false, reason: 'not_empty', signals: signalCount, forces: forceCount };
    }

    const { lessons, forces } = readSeeds();

    const insertAll = db.db.transaction(() => {
      for (const lesson of lessons) {
        db.insertSignal({
          type: lesson.type,
          weight: lesson.weight,
          polarity: lesson.polarity,
          label: lesson.label,
          description: lesson.description || null,
          context: lesson.context || null,
          filePattern: lesson.file_pattern || null,
          trigger: lesson.trigger || 'passive',
        });
      }
      for (const force of forces) {
        db.insertForce({
          name: force.name,
          description: force.description || null,
          score: force.score,
        });
      }
    });
    insertAll();

    const msg = `Seeded ${lessons.length} starter signals and ${forces.length} forces. Use /dopamine and /oxytocin to customize.`;
    if (!opts.quiet) console.log(msg);
    return { seeded: true, signals: lessons.length, forces: forces.length };
  } finally {
    db.close();
  }
}

function regenerateSignalsMd(dataDir, config) {
  // Delay-load signals.js so seed() can run without pulling the whole signals CLI surface.
  const { cmdGenerate } = require('./signals');
  cmdGenerate(dataDir, config);
}

function seedAndRegenerate(dataDir = getDefaultDataDir(), opts = {}) {
  const result = seed(dataDir, opts);
  if (result.seeded) {
    try {
      const config = opts.config || loadConfig(dataDir);
      regenerateSignalsMd(dataDir, config);
    } catch (err) {
      if (!opts.quiet) process.stderr.write(`seed-signals: rules regen: ${err.message}\n`);
    }
  }
  return result;
}

if (require.main === module) {
  try {
    seedAndRegenerate();
  } catch (err) {
    process.stderr.write(`seed-signals: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { seed, seedAndRegenerate };
