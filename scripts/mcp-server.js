#!/usr/bin/env node
require('../lib/resolve-deps');
'use strict';

// MCP read-only server for greymatter.
// Meant to be spawned by an MCP client over stdio.
// Run with --help or in a TTY for a usage hint.
//
// SDK import paths (verified against @modelcontextprotocol/sdk@1.29.0 CJS):
//   require('@modelcontextprotocol/sdk/server')          → { Server }
//   require('@modelcontextprotocol/sdk/server/stdio.js') → { StdioServerTransport }
//   require('@modelcontextprotocol/sdk/types.js')        → schema constants

const path = require('path');
const os = require('os');
const fs = require('fs');

const { Server } = require('@modelcontextprotocol/sdk/server');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const { GraphDB } = require('../lib/graph-db');
const { GraphQueries } = require('../lib/graph-queries');
const { grepProject: grepProjectLib } = require('./grep');
const { TOOLS } = require('../lib/mcp/tools');
const { PROMPTS } = require('../lib/mcp/prompts');
const { McpError, GraphUnavailableError, BadRequestError } = require('../lib/mcp/errors');
const { loadConfig } = require('../lib/config');
const { loadPolicy } = require('../lib/exclusion');

const DEFAULT_DB = path.join(os.homedir(), '.claude', 'greymatter', 'graph.db');
const VERSION = '0.1.0';

// Per-request policy cache — keyed by (projectRoot, source-file mtimes).
// Invalidates automatically when .gitignore or .greymatterignore mtime changes.
const policyCache = new Map();

function getFileMtime(filePath) {
  try { return fs.statSync(filePath).mtimeMs; } catch { return null; }
}

// Returns a project → policy resolver function with mtime-keyed caching.
// Exported for testing.
function makePolicyResolver(graphDb, config) {
  return function resolvePolicy(project) {
    const root = graphDb ? graphDb.getProjectRoot(project) : null;
    if (!root) return null;
    const mtimes = {
      gitignore: getFileMtime(path.join(root, '.gitignore')),
      greymatterignore: getFileMtime(path.join(root, '.greymatterignore')),
    };
    const key = JSON.stringify({ root, mtimes });
    if (policyCache.has(key)) return policyCache.get(key);
    const policy = loadPolicy(root, config);
    policyCache.set(key, policy);
    return policy;
  };
}

async function main() {
  if (process.argv[2] === '--help' || process.stdout.isTTY) {
    process.stdout.write(
      'greymatter-mcp is meant to be spawned by an MCP client over stdio.\n' +
      'See docs/mcp-server.md for client configuration.\n'
    );
    process.exit(0);
  }

  let config;
  try { config = loadConfig(); } catch { config = {}; }

  const dbPath = process.env.GREYMATTER_GRAPH_DB || config.graph_db_path || DEFAULT_DB;

  let graphDb = null;
  let queries = null;
  let dbError = null;

  // better-sqlite3 creates the file on open, so check existence first.
  // A new empty file is not a valid graph.db — treat as missing.
  if (!fs.existsSync(dbPath)) {
    dbError = `graph.db not found at ${dbPath}`;
  } else {
    try {
      graphDb = new GraphDB(dbPath);
      queries = new GraphQueries(graphDb);
    } catch (e) {
      dbError = e.message;
    }
  }

  // Resolve log path from config; null disables file logging
  const logPath = config.mcp_server_log_path !== undefined
    ? config.mcp_server_log_path
    : path.join(os.homedir(), '.claude', 'greymatter', 'tmp', 'mcp-server.log');

  function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    process.stderr.write(line);
    if (logPath) {
      try {
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.appendFileSync(logPath, line);
      } catch { /* non-fatal */ }
    }
  }

  const serverInfo = {
    name: 'greymatter-mcp',
    version: VERSION,
    started_at: new Date().toISOString(),
  };

  const deps = {
    graphDb,
    queries,
    grepProject: (project, pattern, opts) => grepProjectLib(graphDb, project, pattern, opts),
    policy: makePolicyResolver(graphDb, config),
    serverInfo,
    dbError,
    dbPath,
    config,
  };

  const server = new Server(
    { name: 'greymatter-mcp', version: VERSION },
    { capabilities: { tools: {}, prompts: {} } }
  );

  // tools/list
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));

  // tools/call
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const toolName = req.params.name;
    const tool = TOOLS.find(t => t.name === toolName);
    if (!tool) {
      const err = new Error(`Unknown tool: ${toolName}`);
      err.code = -32602;
      throw err;
    }

    // All tools except get_status require a live DB
    if (dbError && toolName !== 'get_status') {
      const mcpErr = new GraphUnavailableError(dbError);
      const err = new Error(mcpErr.message);
      err.code = mcpErr.jsonRpcCode;
      err.data = { error_code: mcpErr.code };
      throw err;
    }

    log(`tool call: ${toolName}`);

    try {
      const result = tool.handler(req.params.arguments || {}, deps);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (e) {
      if (e instanceof McpError) {
        log(`tool error: ${toolName}: ${e.code}: ${e.message}`);
        const err = new Error(e.message);
        err.code = e.jsonRpcCode;
        err.data = { error_code: e.code };
        throw err;
      }
      log(`tool internal error: ${toolName}: ${e.message}`);
      throw e;
    }
  });

  // prompts/list
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS.map(p => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments,
    })),
  }));

  // prompts/get
  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const promptName = req.params.name;
    const prompt = PROMPTS.find(p => p.name === promptName);
    if (!prompt) {
      const err = new Error(`Unknown prompt: ${promptName}`);
      err.code = -32602;
      throw err;
    }
    try {
      const text = prompt.handler(req.params.arguments || {});
      return {
        messages: [{ role: 'user', content: { type: 'text', text } }],
      };
    } catch (e) {
      if (e instanceof McpError) {
        const err = new Error(e.message);
        err.code = e.jsonRpcCode;
        err.data = { error_code: e.code };
        throw err;
      }
      throw e;
    }
  });

  log(`greymatter-mcp ${VERSION} starting (db: ${dbPath}${dbError ? ` [ERROR: ${dbError}]` : ''})`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`greymatter-mcp fatal: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { makePolicyResolver, policyCache };
