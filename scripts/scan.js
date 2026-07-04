'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { GraphDB } = require('../lib/graph-db');
const { MemoryDB } = require('../lib/memory-db');
const { ExtractorRegistry, runDetectorsForNode } = require('../lib/extractor-registry');
const { SEED_EDGE_TYPES } = require('../lib/edge-types');
const { loadConfig } = require('../lib/config');
const { buildProjectContext } = require('../lib/reorientation');
const bodyHash = require('../lib/body-hash');
const { loadPolicy, isExcluded, purgeExcluded, policyChangedSince } = require('../lib/exclusion');

const SKIP_DIRS = new Set(['node_modules', '.git', '.svelte-kit', 'dist', 'build', 'coverage']);
const SKIP_EXTENSIONS = new Set(['.db', '.db-wal', '.db-shm']);
const PROJECT_MARKERS = ['package.json', 'go.mod', 'setup.py', 'Cargo.toml', 'pubspec.yaml'];

function hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function walkDir(dir, projectDir, registry, results, policy) {
  if (!results) results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // Directory unreadable — skip
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (policy && isExcluded(fullPath, policy)) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkDir(fullPath, projectDir, registry, results, policy);
    } else {
      const ext = path.extname(entry.name);
      if (SKIP_EXTENSIONS.has(ext)) continue;
      if (registry.getExtractor(ext)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

function resolveImportPath(sourceFile, importTarget, projectDir) {
  // sourceFile is project-relative (e.g. "lib/server.js")
  // importTarget is like "./lib/utils" or "../foo"
  const sourceDirAbs = path.dirname(path.join(projectDir, sourceFile));
  const resolvedAbs = path.resolve(sourceDirAbs, importTarget);
  return path.relative(projectDir, resolvedAbs);
}

// extractFiles — the core two-pass extraction engine.
// forceFiles: optional Set of project-relative paths to re-extract even if the hash is unchanged.
// When null/undefined, behaves identically to the original scanProject (hash-based incremental).
// extractorsDir: optional path to a custom extractors directory (used in tests).
function extractFiles({ db, project, rootPath, forceFiles = null, forceAll = false, extractorsDir, config }) {
  if (config == null) {
    throw new Error('extractFiles: config is required (load via loadConfig() at integration boundary)');
  }
  const registry = extractorsDir ? new ExtractorRegistry(extractorsDir) : new ExtractorRegistry();
  const forceSet = forceFiles ? new Set(forceFiles) : null;
  const policy = loadPolicy(rootPath, config);

  let result;
  const txn = db.db.transaction(() => {
    if (policyChangedSince(db, project, policy)) {
      purgeExcluded(db, project, policy);
    }

    // Seed baseline edge types
    for (const et of SEED_EDGE_TYPES) {
      db.registerEdgeType(et);
    }

    const files = walkDir(rootPath, rootPath, registry, undefined, policy);
    let filesScanned = 0;
    let filesSkipped = 0;
    let nodesCreated = 0;
    let edgesCreated = 0;
    let labelsWritten = 0;
    const detectorsFired = new Set();

    // fileNodeMaps: projectRelPath → Map(nodeName → nodeId)
    // Built during first pass for all files (both changed and unchanged).
    // Used in second pass for edge target resolution.
    const fileNodeMaps = new Map();
    const filesToProcess = []; // files that need edge insertion

    // First pass: insert nodes, build fileNodeMaps
    for (const absPath of files) {
      const relPath = path.relative(rootPath, absPath);
      const forced = forceAll || (forceSet !== null && forceSet.has(relPath));

      // Defense in depth: never extract a forced-but-excluded file
      if (isExcluded(absPath, policy)) continue;

      let content;
      try {
        content = fs.readFileSync(absPath, 'utf8');
      } catch {
        // File unreadable (permissions, binary) — skip
        continue;
      }

      const hash = hashContent(content);
      const existingHash = forced ? null : db.getFileHash(project, relPath);

      if (!forced && existingHash === hash) {
        filesSkipped++;
        // Load existing node map from DB for edge resolution
        const existingNodes = db.db.prepare(
          'SELECT name, id FROM nodes WHERE project = ? AND file = ? ORDER BY id'
        ).all(project, relPath);
        const nameMap = new Map();
        for (const n of existingNodes) nameMap.set(n.name, n.id);
        fileNodeMaps.set(relPath, nameMap);
        continue;
      }

      filesScanned++;
      const extracted = registry.extractFile(content, relPath, project);

      // Register edge types declared by this extractor
      for (const et of extracted.edge_types || []) {
        db.registerEdgeType(et);
      }

      // Clear stale nodes/edges
      db.deleteFileEdges(project, relPath);
      db.deleteFileNodes(project, relPath);

      // Insert new nodes; build name→id map for this file
      const nameMap = new Map();
      const fileExt = path.extname(relPath);
      const extractorMod = registry.getExtractor(fileExt);
      for (const node of extracted.nodes) {
        const id = db.upsertNode(node);
        if (!nameMap.has(node.name)) nameMap.set(node.name, id);
        nodesCreated++;

        // Compute and store body_hash; follow-up UPDATE acceptable for v1 simplicity
        const body = extractorMod && typeof extractorMod.extractBody === 'function'
          ? extractorMod.extractBody(content, node)
          : null;
        node.body = body; // in-memory transient; not persisted to DB
        const hash = bodyHash(body);
        db.setNodeBodyHash(id, hash);

        // Run heuristic detectors and write labels
        const nodeLabels = runDetectorsForNode(extractorMod || {}, node, { project, filePath: relPath, content });
        for (const label of nodeLabels) {
          db.upsertLabel({
            nodeId: id,
            detectorId: label.detectorId,
            term: label.term,
            category: label.category,
            descriptors: label.descriptors,
            confidence: label.confidence,
            source: 'heuristic',
            bodyHashAtLabel: hash,
          });
          labelsWritten++;
          detectorsFired.add(label.detectorId);
        }
      }
      fileNodeMaps.set(relPath, nameMap);
      filesToProcess.push({ relPath, hash, extracted });
    }

    // Second pass: insert edges now that all fileNodeMaps are populated
    for (const { relPath, hash, extracted } of filesToProcess) {
      const fileNodeMap = fileNodeMaps.get(relPath) || new Map();

      for (const edge of extracted.edges) {
        // Resolve source node ID
        let sourceId = fileNodeMap.get(edge.source);
        if (sourceId == null) {
          // Fall back to module node (first entry = lowest id)
          const first = fileNodeMap.values().next();
          sourceId = first.done ? null : first.value;
        }
        if (sourceId == null) continue;

        // Resolve target node ID
        let targetId = null;

        if (edge.type === 'imports') {
          // target is a relative path like './lib/utils'
          const resolved = resolveImportPath(relPath, edge.target, rootPath);
          // TS node16/nodenext specifiers reference the EMITTED file ('./foo.js')
          // while the on-disk source is foo.ts/.tsx — without the suffix swap every
          // lookup misses and imports collapse into phantom .js stub nodes
          // (empty imported_by across whole TS projects).
          const candidates = [resolved];
          const stem = resolved.replace(/\.(js|mjs|cjs)$/, '');
          if (stem !== resolved) {
            candidates.push(stem + '.ts', stem + '.tsx', stem + '.mts', stem + '.cts');
          } else {
            candidates.push(
              resolved + '.js', resolved + '.ts', resolved + '.tsx',
              path.join(resolved, 'index.js'), path.join(resolved, 'index.ts'), path.join(resolved, 'index.tsx')
            );
          }

          for (const candidate of candidates) {
            const targetMap = fileNodeMaps.get(candidate);
            if (targetMap && targetMap.size > 0) {
              targetId = targetMap.values().next().value;
              break;
            }
          }

          if (targetId == null) {
            // Create a stub module node for unresolvable import
            const targetFile = resolved.endsWith('.js') ? resolved : resolved + '.js';
            const stubName = path.basename(targetFile);
            targetId = db.upsertNode({
              project,
              file: targetFile,
              name: stubName,
              type: 'module',
              line: 1,
            });
            if (!fileNodeMaps.has(targetFile)) fileNodeMaps.set(targetFile, new Map());
            if (!fileNodeMaps.get(targetFile).has(stubName)) {
              fileNodeMaps.get(targetFile).set(stubName, targetId);
            }
          }
        } else {
          // Look up target in current file first
          targetId = fileNodeMap.get(edge.target);

          // `exports` edges target current-file symbols by definition. Falling
          // back to a global name lookup creates phantom cross-file edges when
          // multiple files export the same name (e.g. every Astro page exports
          // `prerender`/`GET` — global lookup binds them all to the first match).
          if (targetId == null && edge.type !== 'exports') {
            // Search all files in this project
            for (const [, nodeMap] of fileNodeMaps) {
              if (nodeMap.has(edge.target)) {
                targetId = nodeMap.get(edge.target);
                break;
              }
            }
          }

          if (targetId == null) {
            // Create a stub node
            const stubType = edge.type === 'queries_table' ? 'table' : 'stub';
            targetId = db.upsertNode({
              project,
              file: relPath,
              name: edge.target,
              type: stubType,
              line: null,
            });
            fileNodeMap.set(edge.target, targetId);
          }
        }

        if (targetId == null) continue;

        try {
          db.insertEdge({
            sourceId,
            targetId,
            type: edge.type,
            category: edge.category,
            sourceProject: edge.sourceProject || project,
            sourceFile: edge.sourceFile || relPath,
            data: edge.data || null,
            sequence: edge.sequence || null,
          });
          edgesCreated++;
        } catch {
          // Skip duplicates or constraint errors
        }
      }

      db.setFileHash(project, relPath, hash);
    }

    db.setExclusionState(project, policy.hash);
    result = { filesScanned, filesSkipped, nodesCreated, edgesCreated, labelsWritten, detectorCount: detectorsFired.size };
  });
  txn();
  return result;
}

function scanProject(projectDir, projectName, graphDb, config, { forceAll = false } = {}) {
  return extractFiles({ db: graphDb, project: projectName, rootPath: projectDir, config, forceAll });
}

function discoverProjects(workspaceDir) {
  const SKIP = new Set(['node_modules', '.git', 'marked-for-deletion']);
  const projects = [];

  let entries;
  try {
    entries = fs.readdirSync(workspaceDir, { withFileTypes: true });
  } catch {
    // Workspace directory unreadable — return empty
    return projects;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP.has(entry.name)) continue;
    const dir = path.join(workspaceDir, entry.name);
    const hasMarker = PROJECT_MARKERS.some(m => {
      try { fs.accessSync(path.join(dir, m)); return true; } catch { return false; }
    });
    if (hasMarker) {
      projects.push({ dir, name: entry.name });
    }
  }
  return projects;
}

// Seed aliases from graph.db into memory.db for the given project.
// Adds: project-name alias, file-stem aliases, exported-function aliases.
function seedAliases(projectName, graphDb, memDb) {
  const rows = graphDb.db.prepare(
    'SELECT file, name, type FROM nodes WHERE project = ? ORDER BY file, line'
  ).all(projectName);

  const seen = new Set();

  function addAlias(alias, file) {
    const key = `${alias}|${file || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    try {
      memDb.db.prepare(
        'INSERT OR IGNORE INTO aliases (alias, project, file, source) VALUES (?, ?, ?, ?)'
      ).run(alias, projectName, file || null, 'seed');
    } catch { /* ignore constraint errors */ }
  }

  // Project name → project alias (no file)
  addAlias(projectName, null);

  // Group nodes by file
  const byFile = new Map();
  for (const row of rows) {
    if (!byFile.has(row.file)) byFile.set(row.file, []);
    byFile.get(row.file).push(row);
  }

  for (const [file, nodes] of byFile) {
    const exportedDefs = nodes.filter(n =>
      n.type === 'function' || n.type === 'class' || n.type === 'interface'
    );
    const lowerFile = file.toLowerCase();
    const isRoutesOrMiddleware = /route|middleware/.test(lowerFile);

    // File stem alias: only when the file is substantive — 3+ exported defs OR
    // it looks like a route/middleware file. Keeps the alias surface meaningful.
    if (exportedDefs.length >= 3 || isRoutesOrMiddleware) {
      const stem = path.basename(file, path.extname(file));
      if (stem && stem !== 'index') {
        addAlias(stem, file);
      }
    }

    // Per-function aliases are prefixed with project name, lowercased, so
    // identical function names across projects disambiguate automatically.
    for (const node of exportedDefs) {
      const aliasStr = `${projectName} ${node.name}`.toLowerCase();
      addAlias(aliasStr, file);
    }
  }
}

// Scan watch_directories (external doc directories) into graph.db with synthetic project names.
function scanWatchDirectories(watchDirs, graphDb) {
  if (!watchDirs || watchDirs.length === 0) return;

  const registry = new ExtractorRegistry();
  const globModule = (() => {
    try { return require('glob'); } catch { return null; }
  })();

  for (const dirPattern of watchDirs) {
    // Resolve ~ home dir
    const expanded = dirPattern.replace(/^~/, os.homedir());

    // Determine which dirs to walk: if pattern ends with glob chars, try to expand.
    // Fallback: treat as literal path.
    let dirs = [];
    if (globModule && (expanded.includes('*') || expanded.includes('?'))) {
      try { dirs = globModule.sync(expanded); } catch { dirs = []; }
    } else {
      dirs = [expanded];
    }

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;

      // Synthetic project name from path: use last two path segments
      const parts = dir.replace(/\/$/, '').split(path.sep).filter(Boolean);
      const projectName = parts.slice(-2).join('-') || parts[parts.length - 1] || 'watch';

      // Walk for .md files
      const files = walkDir(dir, dir, registry);
      for (const absPath of files) {
        const relPath = path.relative(dir, absPath);
        let content;
        try { content = fs.readFileSync(absPath, 'utf8'); } catch { continue; }

        const hash = hashContent(content);
        const existingHash = graphDb.getFileHash(projectName, relPath);
        if (existingHash === hash) continue;

        const extracted = registry.extractFile(content, relPath, projectName);
        for (const et of extracted.edge_types || []) graphDb.registerEdgeType(et);
        graphDb.deleteFileEdges(projectName, relPath);
        graphDb.deleteFileNodes(projectName, relPath);
        for (const node of extracted.nodes) graphDb.upsertNode(node);
        // Edges for watch dirs: insert without resolution (stubs for unresolvable targets)
        for (const edge of extracted.edges) {
          const sourceRow = graphDb.db.prepare(
            'SELECT id FROM nodes WHERE project = ? AND file = ? AND name = ? LIMIT 1'
          ).get(projectName, relPath, edge.source);
          if (!sourceRow) continue;
          let targetId = graphDb.db.prepare(
            'SELECT id FROM nodes WHERE project = ? AND name = ? LIMIT 1'
          ).get(projectName, edge.target)?.id;
          if (!targetId) {
            targetId = graphDb.upsertNode({ project: projectName, file: relPath, name: edge.target, type: 'stub', line: null });
          }
          try {
            graphDb.insertEdge({
              sourceId: sourceRow.id, targetId,
              type: edge.type, category: edge.category,
              sourceProject: projectName, sourceFile: relPath,
              data: null, sequence: null,
            });
          } catch { /* skip duplicates */ }
        }
        graphDb.setFileHash(projectName, relPath, hash);
      }
    }
  }
}

function main() {
  const args = process.argv.slice(2);

  function flag(name) {
    const idx = args.indexOf(name);
    if (idx === -1 || idx + 1 >= args.length) return null;
    return args[idx + 1];
  }

  const DEFAULT_DB = path.join(os.homedir(), '.claude', 'greymatter', 'graph.db');
  const DEFAULT_MEMORY_DB = path.join(os.homedir(), '.claude', 'greymatter', 'memory.db');
  const dbPath = flag('--db') || DEFAULT_DB;
  const memDbPath = flag('--memory-db') || DEFAULT_MEMORY_DB;
  const seedAliasesFlag = args.includes('--seed-aliases');
  // --force is documented in README/docs since the beginning but was never
  // wired into the CLI — hashes always short-circuited re-extraction.
  const forceAll = args.includes('--force');
  const pairs = [];

  if (args.includes('--dir')) {
    const dir = path.resolve(flag('--dir'));
    const name = flag('--name') || path.basename(dir);
    pairs.push({ dir, name });
  } else if (args.includes('--workspace')) {
    const ws = path.resolve(flag('--workspace'));
    pairs.push(...discoverProjects(ws));
  } else {
    pairs.push(...discoverProjects(process.cwd()));
  }

  if (pairs.length === 0) {
    process.stderr.write('No projects found. Use --dir <path> [--name <name>] or --workspace <path>.\n');
    process.exit(1);
  }

  const dbDir = path.dirname(dbPath);
  fs.mkdirSync(dbDir, { recursive: true });

  const db = new GraphDB(dbPath);
  let totalScanned = 0, totalSkipped = 0, totalNodes = 0, totalEdges = 0;

  const config = loadConfig();

  for (const { dir, name } of pairs) {
    process.stdout.write(`Scanning ${name} (${dir})...\n`);
    const stats = scanProject(dir, name, db, config, { forceAll });
    db.setProjectRoot(name, dir);
    process.stdout.write(`  ${stats.filesScanned} scanned, ${stats.filesSkipped} skipped, ${stats.nodesCreated} nodes, ${stats.edgesCreated} edges\n`);
    if (stats.labelsWritten > 0) {
      process.stdout.write(`  labels: ${name} — ${stats.labelsWritten} labels written via ${stats.detectorCount} detectors\n`);
    }
    totalScanned += stats.filesScanned;
    totalSkipped += stats.filesSkipped;
    totalNodes += stats.nodesCreated;
    totalEdges += stats.edgesCreated;
  }

  // Reuse the already-loaded config for watch_directories.
  const watchDirs = config.watch_directories || [];
  if (watchDirs.length > 0) {
    process.stdout.write(`\nScanning ${watchDirs.length} watch director${watchDirs.length === 1 ? 'y' : 'ies'}...\n`);
    scanWatchDirectories(watchDirs, db);
  }

  // Seed aliases into memory.db if requested
  if (seedAliasesFlag) {
    process.stdout.write('\nSeeding aliases into memory.db...\n');
    let memDb;
    try {
      memDb = new MemoryDB(memDbPath);
      for (const { name } of pairs) {
        seedAliases(name, db, memDb);
        process.stdout.write(`  Seeded aliases for ${name}\n`);
      }
    } catch (err) {
      process.stderr.write(`Warning: alias seeding failed: ${err.message}\n`);
    } finally {
      if (memDb) try { memDb.close(); } catch {}
    }
  }

  db.close();
  process.stdout.write(`\nTotal: ${totalScanned} scanned, ${totalSkipped} skipped, ${totalNodes} nodes, ${totalEdges} edges\n`);

  // Build reorientation context from memory.db
  // Runs after db.close() — buildProjectContext opens its own handles
  try {
    if (fs.existsSync(memDbPath)) {
      process.stdout.write('\nBuilding reorientation context...\n');
      const result = buildProjectContext(memDbPath, dbPath);
      process.stdout.write(`  ${result.projectCount} projects, ${result.sessionCount} sessions\n`);
    }
  } catch (err) {
    process.stderr.write(`Warning: reorientation build failed: ${err.message}\n`);
  }
}

if (require.main === module) main();

module.exports = { extractFiles, scanProject, discoverProjects, seedAliases };
