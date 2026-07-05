'use strict';

// TypeScript extractor — duplicates JS extractor patterns and adds TS-specific types.
// No runtime dependency on javascript.js: clean boundary between extractors.

const path = require('path');

const BUILTIN_MODULES = new Set([
  'fs', 'path', 'http', 'https', 'url', 'crypto', 'stream', 'events',
  'util', 'os', 'child_process', 'readline', 'net', 'tls', 'dns',
  'assert', 'buffer', 'cluster', 'console', 'dgram', 'domain',
  'module', 'perf_hooks', 'querystring', 'string_decoder',
  'timers', 'tty', 'v8', 'vm', 'worker_threads', 'zlib',
  'node:fs', 'node:path', 'node:test', 'node:assert', 'node:assert/strict',
  'node:crypto', 'node:readline', 'node:url', 'node:http', 'node:https',
  'node:child_process', 'node:events', 'node:stream', 'node:util',
  'node:os', 'node:net', 'node:buffer', 'node:worker_threads', 'node:zlib',
]);

const NOT_METHODS = new Set(['if', 'for', 'while', 'switch', 'catch', 'else', 'constructor']);

const USED_EDGE_TYPES = [
  { name: 'imports', category: 'structural', followsForBlastRadius: true, impliesStaleness: false, description: 'ES/CJS module import' },
  { name: 'exports', category: 'structural', followsForBlastRadius: true, impliesStaleness: false, description: 'Module export declaration' },
  { name: 'attaches', category: 'structural', followsForBlastRadius: true, impliesStaleness: false, description: 'Middleware/handler attachment (app.use, router.get)' },
  { name: 'queries_table', category: 'data_flow', followsForBlastRadius: false, impliesStaleness: false, description: 'SQL table access (SELECT/INSERT/UPDATE/DELETE)' },
];

const SQL_PATTERNS = [
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?(\w+)[`"']?/i,
  /SELECT\s+[\s\S]+?\s+FROM\s+[`"']?(\w+)[`"']?/i,
  /INSERT\s+INTO\s+[`"']?(\w+)[`"']?/i,
  /UPDATE\s+[`"']?(\w+)[`"']?\s+SET/i,
  /DELETE\s+FROM\s+[`"']?(\w+)[`"']?/i,
];

function isRelative(mod) {
  return mod.startsWith('.') || mod.startsWith('/');
}

// Path-alias specifiers are project files behind a mapping, not npm packages —
// emit them as edges; scan.js translates the prefix ($lib -> src/lib, @/ and
// ~/ -> src/). Other $-prefixed ids (SvelteKit virtuals $app/, $env/) stay
// skipped — no file on disk.
function isPathAlias(mod) {
  return mod === '$lib' || mod.startsWith('$lib/') || mod.startsWith('@/') || mod.startsWith('~/');
}

function shouldSkipImport(mod) {
  return !isRelative(mod) && !isPathAlias(mod);
}

function extract(content, filePath, project) {
  const nodes = [];
  const edges = [];
  const seenImports = new Set();

  const moduleName = path.basename(filePath);
  nodes.push({ project, file: filePath, name: moduleName, type: 'module', line: 1 });

  const lines = content.split('\n');
  let braceDepth = 0;

  const scopeStack = [];
  let inClass = false;
  let classStartDepth = 0;

  function currentScope() {
    return scopeStack.length > 0 ? scopeStack[scopeStack.length - 1].name : moduleName;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const lineNum = i + 1;
    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;

    // ── TypeScript: skip import type { ... } from '...' (no runtime edge) ──────
    const importTypeMatch = trimmed.match(/^import\s+type\s+/);
    if (importTypeMatch) {
      braceDepth += opens - closes;
      while (scopeStack.length > 0 && braceDepth <= scopeStack[scopeStack.length - 1].startDepth) {
        scopeStack.pop();
      }
      if (inClass && braceDepth <= classStartDepth) inClass = false;
      continue;
    }

    // ── TypeScript: interface declarations ───────────────────────────────────
    const ifaceMatch = trimmed.match(/^(?:export\s+)?interface\s+(\w+)/);
    if (ifaceMatch) {
      nodes.push({ project, file: filePath, name: ifaceMatch[1], type: 'interface', line: lineNum });
    }

    // ── TypeScript: type alias declarations ──────────────────────────────────
    const typeAliasMatch = trimmed.match(/^(?:export\s+)?type\s+(\w+)\s*(?:<[^>]*>)?\s*=/);
    if (typeAliasMatch) {
      nodes.push({ project, file: filePath, name: typeAliasMatch[1], type: 'type_alias', line: lineNum });
    }

    // ── TypeScript: enum declarations ────────────────────────────────────────
    const enumMatch = trimmed.match(/^(?:export\s+)?(?:const\s+)?enum\s+(\w+)/);
    if (enumMatch) {
      nodes.push({ project, file: filePath, name: enumMatch[1], type: 'enum', line: lineNum });
    }

    // ── Class detection (JS + TS) ────────────────────────────────────────────
    const classMatch = trimmed.match(/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/);
    if (classMatch) {
      nodes.push({ project, file: filePath, name: classMatch[1], type: 'class', line: lineNum });
      inClass = true;
      classStartDepth = braceDepth;
    }

    // ── Function declarations ────────────────────────────────────────────────
    const funcMatch = trimmed.match(/^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+(\w+)\s*[\s(<]/);
    if (funcMatch) {
      nodes.push({ project, file: filePath, name: funcMatch[1], type: 'function', line: lineNum });
      scopeStack.push({ name: funcMatch[1], startDepth: braceDepth });
    }

    if (!funcMatch) {
      // Arrow functions: const foo = (x) => ...
      const arrowMatch = trimmed.match(/^(?:export\s+(?:default\s+)?)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[\w$]+)\s*=>/);
      if (arrowMatch) {
        nodes.push({ project, file: filePath, name: arrowMatch[1], type: 'function', line: lineNum });
        scopeStack.push({ name: arrowMatch[1], startDepth: braceDepth });
      } else {
        // Function expressions: const foo = function() {}
        const exprMatch = trimmed.match(/^(?:export\s+(?:default\s+)?)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function\s*\(/);
        if (exprMatch) {
          nodes.push({ project, file: filePath, name: exprMatch[1], type: 'function', line: lineNum });
          scopeStack.push({ name: exprMatch[1], startDepth: braceDepth });
        }
      }
    }

    // ── Class methods ────────────────────────────────────────────────────────
    if (inClass && braceDepth > classStartDepth) {
      const methodMatch = trimmed.match(/^(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|override\s+)*(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*\S+\s*)?\{/);
      if (methodMatch && !NOT_METHODS.has(methodMatch[1]) && methodMatch[1] !== 'function') {
        nodes.push({ project, file: filePath, name: methodMatch[1], type: 'method', line: lineNum });
      }
    }

    // ── Express routes ───────────────────────────────────────────────────────
    const routeMatch = trimmed.match(/(?:router|app)\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/i);
    if (routeMatch) {
      const routeName = `${routeMatch[1].toUpperCase()} ${routeMatch[2]}`;
      nodes.push({ project, file: filePath, name: routeName, type: 'route', line: lineNum });
      edges.push({
        type: 'attaches', category: 'structural',
        source: currentScope(), target: routeName,
        sourceProject: project, sourceFile: filePath,
      });
    }

    // ── app.use() middleware ─────────────────────────────────────────────────
    const useMatch = trimmed.match(/(?:app|router)\.use\(\s*(?:['"][^'"]*['"]\s*,\s*)?(\w+)/);
    if (useMatch && !routeMatch) {
      edges.push({
        type: 'attaches', category: 'structural',
        source: currentScope(), target: useMatch[1],
        sourceProject: project, sourceFile: filePath,
      });
    }

    // ── require() imports ────────────────────────────────────────────────────
    const requirePattern = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
    let match;
    while ((match = requirePattern.exec(line)) !== null) {
      const mod = match[1];
      if (!shouldSkipImport(mod) && !seenImports.has(mod)) {
        seenImports.add(mod);
        edges.push({
          type: 'imports', category: 'structural',
          source: currentScope(), target: mod,
          sourceProject: project, sourceFile: filePath,
        });
      }
    }

    // ── ES import statements (non-type) ──────────────────────────────────────
    const esImportMatch = trimmed.match(/^import\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"]/);
    if (esImportMatch) {
      const mod = esImportMatch[1];
      if (!shouldSkipImport(mod) && !seenImports.has(mod)) {
        seenImports.add(mod);
        edges.push({
          type: 'imports', category: 'structural',
          source: currentScope(), target: mod,
          sourceProject: project, sourceFile: filePath,
        });
      }
    }

    // ── module.exports = { a, b } ────────────────────────────────────────────
    const moduleExportsDestructured = trimmed.match(/^module\.exports\s*=\s*\{([^}]+)\}/);
    if (moduleExportsDestructured) {
      const keys = moduleExportsDestructured[1]
        .split(',')
        .map(k => k.trim().split(':')[0].trim())
        .filter(Boolean);
      for (const key of keys) {
        edges.push({
          type: 'exports', category: 'structural',
          source: moduleName, target: key,
          sourceProject: project, sourceFile: filePath,
        });
      }
    }

    // ── module.exports = identifier ──────────────────────────────────────────
    if (!moduleExportsDestructured) {
      const moduleExportsDefault = trimmed.match(/^module\.exports\s*=\s*([a-zA-Z_$][\w$]*)\s*;?$/);
      if (moduleExportsDefault) {
        edges.push({
          type: 'exports', category: 'structural',
          source: moduleName, target: moduleExportsDefault[1],
          sourceProject: project, sourceFile: filePath,
        });
      }
    }

    // ── exports.name = ... ───────────────────────────────────────────────────
    const namedExport = trimmed.match(/^exports\.(\w+)\s*=/);
    if (namedExport) {
      edges.push({
        type: 'exports', category: 'structural',
        source: moduleName, target: namedExport[1],
        sourceProject: project, sourceFile: filePath,
      });
    }

    // ── ES export declarations ───────────────────────────────────────────────
    const esExport = trimmed.match(/^export\s+(?:default\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)/);
    if (esExport) {
      edges.push({
        type: 'exports', category: 'structural',
        source: moduleName, target: esExport[1],
        sourceProject: project, sourceFile: filePath,
      });
    }

    // ── SQL table references ─────────────────────────────────────────────────
    const stringPattern = /['"`]([^'"`\n]+)['"`]/g;
    while ((match = stringPattern.exec(line)) !== null) {
      const str = match[1];
      for (const sqlPat of SQL_PATTERNS) {
        const sqlMatch = str.match(sqlPat);
        if (sqlMatch) {
          edges.push({
            type: 'queries_table', category: 'data_flow',
            source: currentScope(), target: sqlMatch[1],
            sourceProject: project, sourceFile: filePath,
          });
          break;
        }
      }
    }

    // ── Update brace depth ───────────────────────────────────────────────────
    braceDepth += opens - closes;

    while (scopeStack.length > 0 && braceDepth <= scopeStack[scopeStack.length - 1].startDepth) {
      scopeStack.pop();
    }

    if (inClass && braceDepth <= classStartDepth) {
      inClass = false;
    }
  }

  return { nodes, edges, edge_types: USED_EDGE_TYPES };
}

const testPairs = {
  isTestFile(relPath) {
    return /\.test\.[mc]?tsx?$|\.spec\.[mc]?tsx?$/.test(relPath)
      || /(^|\/)(test|tests|__tests__|spec)\//.test(relPath);
  },

  candidateTestPaths(sourceRelPath) {
    const ext = path.extname(sourceRelPath);
    const base = sourceRelPath.slice(0, -ext.length);
    const dir = path.dirname(sourceRelPath);
    const name = path.basename(base);
    const candidates = [
      `${base}.test${ext}`,
      `${base}.spec${ext}`,
      path.join(dir, '__tests__', `${name}.test${ext}`),
      path.join(dir, '__tests__', `${name}.spec${ext}`),
      path.join('test', sourceRelPath),
      path.join('tests', sourceRelPath),
      path.join('test', `${name}.test${ext}`),
      path.join('tests', `${name}.test${ext}`),
    ];
    // Flattened-parent convention: lib/foo/bar.ts -> test/foo-bar.test.ts
    // Common when projects keep a single flat test/ dir instead of mirroring structure.
    const parent = dir === '.' ? '' : path.basename(dir);
    if (parent) {
      candidates.push(path.join('test', `${parent}-${name}.test${ext}`));
      candidates.push(path.join('tests', `${parent}-${name}.test${ext}`));
    }
    return candidates;
  },

  parseAnnotations(content) {
    const header = content.split('\n').slice(0, 20).join('\n');
    const matches = [...header.matchAll(/\/\/[ \t]*@tests[ \t]+(\S+)/g)];
    return matches.map(m => m[1]);
  },
};

const { labelDetectors: jsLabelDetectors, extractBody: jsExtractBody } = require('./javascript');

const labelDetectors = jsLabelDetectors;
const extractBody = jsExtractBody;

module.exports = { extensions: ['.ts', '.tsx'], extract, testPairs, labelDetectors, extractBody };
