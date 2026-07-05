'use strict';
// Self-sufficient dependency resolution for cache-installed plugin entrypoints.
//
// Claude Code installs the plugin into a cache dir WITHOUT node_modules and
// substitution/env behavior for ${CLAUDE_PLUGIN_DATA} varies across versions
// (observed live: MCP server and hooks spawned with the literal, unexpanded
// string → "Cannot find module 'better-sqlite3'"). So entrypoints must not
// rely on NODE_PATH being injected from the outside at all: require this file
// FIRST and it finds a usable node_modules tree itself.
//
// Uses only node core modules — must never require anything from node_modules.
const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');

const candidates = [
  // repo checkout / any install that ships its own node_modules
  path.join(__dirname, '..', 'node_modules'),
  // explicit plugin data dir when the env var IS provided and expanded
  process.env.CLAUDE_PLUGIN_DATA && !process.env.CLAUDE_PLUGIN_DATA.includes('${')
    ? path.join(process.env.CLAUDE_PLUGIN_DATA, 'node_modules')
    : null,
  // canonical plugin data location (marketplace "greymatter", plugin "greymatter")
  path.join(os.homedir(), '.claude', 'plugins', 'data', 'greymatter-greymatter', 'node_modules'),
];

for (const c of candidates) {
  if (!c) continue;
  // better-sqlite3 is the canary: native, required by every DB-touching entrypoint
  if (fs.existsSync(path.join(c, 'better-sqlite3', 'package.json'))) {
    if (!Module.globalPaths.includes(c)) {
      process.env.NODE_PATH = process.env.NODE_PATH
        ? `${c}${path.delimiter}${process.env.NODE_PATH}`
        : c;
      Module._initPaths();
    }
    break;
  }
}
