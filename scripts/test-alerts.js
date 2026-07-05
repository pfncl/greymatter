#!/usr/bin/env node
'use strict';
require('../lib/resolve-deps');

// Scan driver for test-alerts. The CLI wrapper (shebang, parseArgs, usage,
// cli, require.main === module) is added in Chunk 5. This chunk keeps the
// file import-safe and export-only.

const fs = require('fs');
const path = require('path');
const os = require('os');

const { loadConfig, getConfigPath } = require('../lib/config');
const { GraphDB } = require('../lib/graph-db');
const { MemoryDB } = require('../lib/memory-db');
const { ExtractorRegistry } = require('../lib/extractor-registry');
const {
  buildAnnotationMap,
  invertAnnotationMap,
  resolvePair,
  isTestFile,
} = require('../lib/test-alerts/pairing');
const {
  isGitRepo, getCurrentHead, getChangedFiles, fileExists,
} = require('../lib/test-alerts/git');
const { reconcile } = require('../lib/test-alerts/reconcile');
const { renderReport, writeReport, expandHome } = require('../lib/test-alerts/output');

const DATA_DIR_DEFAULT = path.join(os.homedir(), '.claude', 'greymatter');

function buildScan({ projectRoot, project, mode, graphDb, registry, config, logger }) {
  const headSha = getCurrentHead(projectRoot);
  if (!headSha) return null;

  const scanState = graphDb.getScanState(project);
  const lastSha = scanState && scanState.last_scan_sha;
  const existingOpen = graphDb.getOpenFindings(project);

  let changedPaths = null;
  let deletedPaths = null;
  if (mode === 'incremental') {
    if (!lastSha) {
      return {
        headSha,
        currentFindings: [],
        resolvedRows: [],
        baseline: true,
      };
    }
    try {
      const diff = getChangedFiles(projectRoot, lastSha, headSha);
      changedPaths = new Set([...diff.modified, ...diff.added]);
      deletedPaths = new Set(diff.deleted);
    } catch (err) {
      logger.warn(`git diff failed for ${project} (${lastSha}..${headSha}): ${err.message}; resetting baseline`);
      return { headSha, currentFindings: [], resolvedRows: [], baseline: true };
    }
  }

  let testFilesForAnnotations;
  if (mode === 'incremental') {
    testFilesForAnnotations = new Set(
      [...changedPaths].filter(p => isTestFile(p, registry))
    );
    for (const r of existingOpen) {
      if (r.test_file) testFilesForAnnotations.add(r.test_file);
    }
  } else {
    const rows = graphDb.getFileHashRowsForProject(project);
    testFilesForAnnotations = new Set(
      rows.map(r => r.file).filter(f => isTestFile(f, registry))
    );
  }
  const annMap = buildAnnotationMap(projectRoot, registry, [...testFilesForAnnotations]);
  const inv = invertAnnotationMap(annMap);

  const currentFindings = [];
  if (mode === 'incremental') {
    const changedSources = [...changedPaths].filter(p => !isTestFile(p, registry));
    for (const S of changedSources) {
      const pairs = resolvePair(S, projectRoot, registry, inv);
      if (pairs.length === 0) {
        if (config.test_alerts.check_missing_tests && hasPairingExtractor(S, registry)) {
          currentFindings.push({ source_file: S, kind: 'missing_test', test_file: null });
        }
      } else {
        if (config.test_alerts.check_stale_pairs) {
          for (const T of pairs) {
            if (!changedPaths.has(T)) {
              currentFindings.push({ source_file: S, kind: 'stale_pair', test_file: T });
            }
          }
        }
      }
    }
  } else {
    const rows = graphDb.getFileHashRowsForProject(project);
    const byFile = new Map(rows.map(r => [r.file, r]));
    for (const r of rows) {
      if (isTestFile(r.file, registry)) continue;
      if (!hasPairingExtractor(r.file, registry)) continue;
      const pairs = resolvePair(r.file, projectRoot, registry, inv);
      if (pairs.length === 0) {
        if (config.test_alerts.check_missing_tests) {
          currentFindings.push({ source_file: r.file, kind: 'missing_test', test_file: null });
        }
      } else {
        if (config.test_alerts.check_stale_pairs) {
          for (const T of pairs) {
            const tRow = byFile.get(T);
            if (!tRow) continue;
            if (new Date(r.updated_at) > new Date(tRow.updated_at)) {
              currentFindings.push({ source_file: r.file, kind: 'stale_pair', test_file: T });
            }
          }
        }
      }
    }
  }

  const currentSet = new Set(currentFindings.map(f =>
    `${f.source_file}\u0000${f.kind}\u0000${f.test_file || ''}`));
  const resolvedRows = [];
  for (const row of existingOpen) {
    const key = `${row.source_file}\u0000${row.kind}\u0000${row.test_file || ''}`;
    if (mode === 'incremental') {
      if (deletedPaths.has(row.source_file)) {
        resolvedRows.push(row); continue;
      }
      if (row.kind === 'stale_pair' && row.test_file && changedPaths.has(row.test_file)) {
        resolvedRows.push(row); continue;
      }
      if (row.kind === 'missing_test') {
        const nowPairs = resolvePair(row.source_file, projectRoot, registry, inv);
        if (nowPairs.length > 0) { resolvedRows.push(row); continue; }
      }
    } else {
      if (!currentSet.has(key)) { resolvedRows.push(row); continue; }
      if (!fileExists(projectRoot, row.source_file)) { resolvedRows.push(row); continue; }
    }
  }

  return { headSha, currentFindings, resolvedRows, baseline: false };
}

function hasPairingExtractor(relPath, registry) {
  const ext = path.extname(relPath);
  const e = registry.getExtractor(ext);
  return Boolean(e && e.testPairs);
}

function runScan({ project, mode, dataDir, projectRoot, config, memoryDbPath, graphDbPath, logger }) {
  dataDir = dataDir || DATA_DIR_DEFAULT;
  graphDbPath = graphDbPath || path.join(dataDir, 'graph.db');
  memoryDbPath = memoryDbPath || path.join(dataDir, 'memory.db');
  config = config || loadConfig(dataDir);
  logger = logger || {
    info: m => process.stdout.write(m + '\n'),
    warn: m => process.stderr.write(m + '\n'),
  };

  if (!fs.existsSync(graphDbPath)) {
    logger.warn(`greymatter test-alerts: ${graphDbPath} missing; skipping ${project}`);
    return { skipped: true, reason: 'no_graph_db' };
  }
  if (!fs.existsSync(projectRoot)) {
    logger.warn(`greymatter test-alerts: project ${project} not found at ${projectRoot}; skipping`);
    return { skipped: true, reason: 'no_project_dir' };
  }
  if (!isGitRepo(projectRoot)) {
    logger.warn(`greymatter test-alerts: ${project} is not a git repo; skipping`);
    return { skipped: true, reason: 'not_git' };
  }

  const graphDb = new GraphDB(graphDbPath);
  const registry = new ExtractorRegistry();

  let built;
  try {
    built = buildScan({ projectRoot, project, mode, graphDb, registry, config, logger });
  } catch (err) {
    logger.warn(`greymatter test-alerts: ${project} build failed: ${err.message}`);
    graphDb.close();
    return { skipped: true, reason: 'build_failed' };
  }
  if (!built) {
    graphDb.close();
    return { skipped: true, reason: 'no_head' };
  }

  let result;
  try {
    result = reconcile({
      graphDb, project, headSha: built.headSha, mode,
      currentFindings: built.currentFindings,
      resolvedRows: built.resolvedRows,
    });
  } catch (err) {
    logger.warn(`greymatter test-alerts: ${project} reconcile failed: ${err.message}`);
    graphDb.close();
    return { skipped: true, reason: 'reconcile_failed' };
  }

  const markdown = renderReport({
    project,
    headSha: built.headSha,
    ranAt: new Date().toISOString(),
    mode,
    open: result.open,
    newlyResolved: result.newlyResolved,
  });

  let outputPath;
  try {
    outputPath = writeReport(config.test_alerts.alert_output_dir, project, markdown);
  } catch (err) {
    logger.warn(`greymatter test-alerts: write failed for ${project}: ${err.message}`);
    graphDb.close();
    return { skipped: true, reason: 'write_failed' };
  }

  try {
    if (fs.existsSync(memoryDbPath)) {
      const memDb = new MemoryDB(memoryDbPath);
      try {
        const findingsJson = JSON.stringify({
          open: result.open,
          resolved_this_run: result.newlyResolved,
        });
        memDb.insertTestAlertRun({
          project,
          sha: built.headSha,
          mode,
          findingsJson,
          openCount: result.open.length,
          resolvedCount: result.newlyResolved.length,
        });
      } finally {
        memDb.close();
      }
    }
  } catch (err) {
    logger.warn(`greymatter test-alerts: ${project} memory snapshot failed: ${err.message}`);
  }

  graphDb.close();
  return {
    skipped: false,
    baseline: built.baseline,
    outputPath,
    openCount: result.open.length,
    resolvedCount: result.newlyResolved.length,
  };
}

function parseArgs(argv) {
  const out = { audit: false, project: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--audit') out.audit = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--project') { out.project = argv[++i]; }
    else if (a.startsWith('--project=')) { out.project = a.slice('--project='.length); }
  }
  return out;
}

function usage() {
  return [
    'Usage: node scripts/test-alerts.js [--audit] [--project <name>]',
    '',
    '  --audit            Full mtime-based sweep (incremental by default).',
    '  --project <name>   Scope to one project from test_alerts.enabled_projects.',
    '',
    'With no --project, iterates every name in enabled_projects.',
  ].join('\n');
}

function cli(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(usage() + '\n');
    return 0;
  }
  const dataDir = DATA_DIR_DEFAULT;
  const config = loadConfig(dataDir);
  const enabled = (config.test_alerts && config.test_alerts.enabled_projects) || [];
  if (enabled.length === 0) {
    process.stderr.write('greymatter test-alerts: test_alerts.enabled_projects is empty; nothing to scan.\n');
    return 0;
  }

  let targets;
  if (args.project) {
    if (!enabled.includes(args.project)) {
      process.stderr.write(
        `greymatter test-alerts: --project ${args.project} is not in enabled_projects.\n`
        + `  Config: ${getConfigPath(dataDir)} -> test_alerts.enabled_projects\n`
        + `  Current: ${JSON.stringify(enabled)}\n`
        + `  To enable: add "${args.project}" to that array and rerun.\n`
      );
      return 2;
    }
    targets = [args.project];
  } else {
    targets = enabled;
  }

  const mode = args.audit ? 'audit' : 'incremental';
  const graphDbPath = path.join(dataDir, 'graph.db');
  const rootLookup = fs.existsSync(graphDbPath) ? new GraphDB(graphDbPath) : null;
  try {
    for (const project of targets) {
      let projectRoot = rootLookup ? rootLookup.getProjectRoot(project) : null;
      if (!projectRoot) {
        projectRoot = path.join(process.cwd(), project);
        process.stderr.write(
          `greymatter test-alerts: no stored root_path for ${project}; falling back to CWD-join (${projectRoot}). `
          + `Rescan with scripts/scan.js --dir <path> --project ${project} to record the root.\n`
        );
      }
      const t0 = Date.now();
      const result = runScan({ project, mode, dataDir, projectRoot, config });
      const ms = Date.now() - t0;
      if (result.skipped) {
        process.stdout.write(`${project}: skipped (${result.reason}) [${ms}ms]\n`);
      } else if (result.baseline) {
        process.stdout.write(`${project}: baseline seeded at HEAD. Run --audit for a full sweep. [${ms}ms]\n`);
      } else {
        process.stdout.write(`${project}: ${result.openCount} open, ${result.resolvedCount} resolved → ${result.outputPath} [${ms}ms]\n`);
      }
    }
  } finally {
    if (rootLookup) rootLookup.close();
  }
  return 0;
}

if (require.main === module) {
  try {
    const code = cli(process.argv.slice(2));
    process.exit(code);
  } catch (err) {
    process.stderr.write(`greymatter test-alerts: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { runScan, buildScan, hasPairingExtractor, parseArgs, usage, cli };
