#!/usr/bin/env node
'use strict';
require('../lib/resolve-deps');

// Last-mile validator + persister for /dopamine. The slash command drives the
// conversation; this helper validates the collected fields and inserts the
// signal via MemoryDB, then regenerates greymatter-signals.md so the new rule is live.

const path = require('path');
const os = require('os');

const { MemoryDB } = require('../lib/memory-db');
const { loadConfig } = require('../lib/config');
const { cmdGenerate } = require('./signals');

const VALID_TYPES = ['amygdala', 'nucleus_accumbens', 'prefrontal', 'hippocampus'];
const VALID_POLARITIES = ['+', '-'];

// Conventional polarity → type mapping. Mismatches warn but are allowed.
const CONVENTIONAL_TYPE = { '+': 'nucleus_accumbens', '-': 'amygdala' };

function getDefaultDataDir() {
  return path.join(os.homedir(), '.claude', 'greymatter');
}

// Validate fields and throw a clean error if any are bad.
function validate({ label, polarity, type, weight }) {
  if (!label || typeof label !== 'string' || label.trim() === '') {
    throw new Error('label is required and must be a non-empty string');
  }
  if (!VALID_POLARITIES.includes(polarity)) {
    throw new Error(`polarity must be one of ${VALID_POLARITIES.join(', ')}`);
  }
  if (!VALID_TYPES.includes(type)) {
    throw new Error(`type must be one of ${VALID_TYPES.join(', ')}`);
  }
  const w = Number(weight);
  if (!Number.isInteger(w) || w < 0 || w > 100) {
    throw new Error('weight must be an integer between 0 and 100');
  }
}

// Persist a dopamine signal. Returns the inserted row.
function run(opts, { dataDir, skipGenerate } = {}) {
  const {
    label,
    description = null,
    polarity,
    type,
    weight = 75,
    context = null,
    file_pattern = null,
    trigger = 'passive',
  } = opts || {};

  validate({ label, polarity, type, weight });

  // Warn on polarity/type mismatch against convention (still allowed).
  if (CONVENTIONAL_TYPE[polarity] && CONVENTIONAL_TYPE[polarity] !== type) {
    process.stderr.write(
      `warning: unconventional polarity/type combination — ` +
      `'${polarity}' usually pairs with '${CONVENTIONAL_TYPE[polarity]}', got '${type}'\n`
    );
  }

  const dir = dataDir || getDefaultDataDir();
  const db = new MemoryDB(path.join(dir, 'memory.db'));
  let row;
  try {
    const id = db.insertSignal({
      type,
      weight,
      polarity,
      label,
      description,
      context,
      filePattern: file_pattern,
      trigger,
    });
    row = db.db.prepare('SELECT * FROM signals WHERE id = ?').get(id);
  } finally {
    db.close();
  }

  // Regenerate greymatter-signals.md so the new rule takes effect next session.
  if (!skipGenerate) {
    const config = loadConfig(dir);
    cmdGenerate(dir, config);
  }
  return row;
}

// Minimal CLI flag parser (--key value).
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
  const weight = flags.weight != null ? parseInt(flags.weight, 10) : 75;
  try {
    const row = run({
      label: flags.label,
      description: flags.description || null,
      polarity: flags.polarity,
      type: flags.type,
      weight,
      context: flags.context || null,
      file_pattern: flags['file-pattern'] || null,
      trigger: flags.trigger || 'passive',
    }, { dataDir: flags['data-dir'] });
    console.log('Inserted signal:');
    console.log(JSON.stringify(row, null, 2));
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { run, validate };
