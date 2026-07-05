'use strict';
require('../lib/resolve-deps');

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { GraphDB } = require('../lib/graph-db');
const { loadConfig, getDataDir } = require('../lib/config');

const DEFAULT_DB = path.join(os.homedir(), '.claude', 'greymatter', 'graph.db');

// ── Severity helpers ─────────────────────────────────────────────────────────

function error(msg, file, line) {
  return { severity: 'error', msg, file: file || null, line: line || null };
}

function warn(msg, file, line) {
  return { severity: 'warning', msg, file: file || null, line: line || null };
}

function formatItem(item) {
  const loc = item.file
    ? (item.line != null ? `  ${item.file}:${item.line}` : `  ${item.file}`)
    : '';
  return `  ${item.msg}${loc ? '\n' + loc : ''}`;
}

// ── Audit checks ─────────────────────────────────────────────────────────────

function checkOrphanedNodes(db, project) {
  const findings = [];
  const clause = project ? 'AND n.project = ?' : '';
  const params = project ? [project] : [];

  const rows = db.prepare(`
    SELECT n.id, n.project, n.file, n.name, n.type, n.line
    FROM nodes n
    WHERE NOT EXISTS (
      SELECT 1 FROM edges e WHERE e.source_id = n.id OR e.target_id = n.id
    )
    ${clause}
    ORDER BY n.project, n.file, n.line
  `).all(...params);

  for (const row of rows) {
    findings.push(warn(
      `Orphaned node: ${row.project}/${row.file} "${row.name}" (${row.type}) — no edges`,
      row.file, row.line
    ));
  }
  return findings;
}

function checkNodesWithoutFileHashes(db, project) {
  const findings = [];
  const clause = project ? 'AND n.project = ?' : '';
  const params = project ? [project] : [];

  const rows = db.prepare(`
    SELECT DISTINCT n.project, n.file
    FROM nodes n
    LEFT JOIN file_hashes fh ON fh.project = n.project AND fh.file = n.file
    WHERE fh.file IS NULL
    ${clause}
    ORDER BY n.project, n.file
  `).all(...params);

  for (const row of rows) {
    findings.push(warn(
      `Node rows without paired file_hashes row: ${row.project}/${row.file}`,
      row.file
    ));
  }
  return findings;
}

function checkStaleDocumentaryEdges(db, project, workspace) {
  const findings = [];
  const clause = project ? 'AND e.source_project = ?' : '';
  const params = project ? [project] : [];

  // Edges of documentary category where the source file doesn't exist on disk
  const rows = db.prepare(`
    SELECT DISTINCT e.id, e.source_project, e.source_file, e.type, e.target_id,
           tn.file AS target_file, tn.name AS target_name
    FROM edges e
    JOIN edge_types et ON e.type = et.name
    LEFT JOIN nodes tn ON e.target_id = tn.id
    WHERE et.category IN ('documentary', 'informational')
    ${clause}
    ORDER BY e.source_project, e.source_file
  `).all(...params);

  for (const row of rows) {
    if (!row.target_file) continue;
    // Resolve path: absolute paths used as-is, relative paths resolved via workspace + project
    const absPath = row.target_file.startsWith('/')
      ? row.target_file
      : path.join(workspace || process.cwd(), row.source_project || '', row.target_file);
    if (!fs.existsSync(absPath)) {
      findings.push(error(
        `Stale documentary edge "${row.type}": target file "${row.target_file}" no longer exists`,
        row.source_file
      ));
    }
  }
  return findings;
}

function checkMissingEdgeTypeRegistrations(db, project) {
  const findings = [];
  const clause = project ? 'WHERE e.source_project = ?' : '';
  const params = project ? [project] : [];

  const rows = db.prepare(`
    SELECT DISTINCT e.type
    FROM edges e
    ${clause}
    ORDER BY e.type
  `).all(...params);

  const knownTypes = new Set(
    db.prepare('SELECT name FROM edge_types').all().map(r => r.name)
  );

  for (const row of rows) {
    if (!knownTypes.has(row.type)) {
      findings.push(error(
        `Edge type "${row.type}" is used in edges but not registered in edge_types table`
      ));
    }
  }
  return findings;
}

function checkOrphanedAnnotations(db) {
  const findings = [];
  // Annotations cascade-delete with nodes, but check for any that slipped through
  const rows = db.prepare(`
    SELECT a.id, a.node_id, a.content
    FROM annotations a
    WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = a.node_id)
    ORDER BY a.id
  `).all();

  for (const row of rows) {
    findings.push(error(
      `Orphaned annotation id=${row.id} — references missing node_id=${row.node_id}`
    ));
  }
  return findings;
}

function checkFileHashMismatches(db, project, workspaceDir) {
  const findings = [];
  if (!workspaceDir) return findings;

  const clause = project ? 'WHERE project = ?' : '';
  const params = project ? [project] : [];

  const rows = db.prepare(`
    SELECT project, file, hash FROM file_hashes ${clause} ORDER BY project, file
  `).all(...params);

  for (const row of rows) {
    const absPath = path.join(workspaceDir, row.project, row.file);
    if (!fs.existsSync(absPath)) {
      // File was deleted — graph is stale
      findings.push(warn(
        `Stale hash: ${row.project}/${row.file} no longer exists on disk (graph not re-scanned)`,
        row.file
      ));
      continue;
    }
    let content;
    try {
      content = fs.readFileSync(absPath);
    } catch {
      continue;
    }
    const actualHash = crypto.createHash('sha256').update(content).digest('hex');
    if (actualHash !== row.hash) {
      findings.push(warn(
        `Hash mismatch: ${row.project}/${row.file} changed since last scan`,
        row.file
      ));
    }
  }
  return findings;
}

function checkStaleFileHashes(db, project, workspaceDir) {
  const findings = [];
  if (!workspaceDir) return findings;

  const clause = project ? 'WHERE project = ?' : '';
  const params = project ? [project] : [];

  const rows = db.prepare(`
    SELECT project, file FROM file_hashes ${clause} ORDER BY project, file
  `).all(...params);

  for (const row of rows) {
    const absPath = path.join(workspaceDir, row.project, row.file);
    if (!fs.existsSync(absPath)) {
      findings.push(warn(
        `Stale hash: ${row.project}/${row.file} no longer exists on disk`,
        row.file
      ));
    }
  }
  return findings;
}

function checkOrphanedDocumentation(db, project) {
  const findings = [];
  const clause = project ? 'AND n.project = ?' : '';
  const params = project ? [project] : [];

  // doc_section nodes whose source file references other files that don't exist in graph
  const rows = db.prepare(`
    SELECT n.project, n.file, n.name, n.line
    FROM nodes n
    WHERE n.type = 'doc_section'
    ${clause}
    ORDER BY n.project, n.file, n.line
  `).all(...params);

  // For each doc_section, find its outbound documentary edges and check targets
  const checkTargetStmt = db.prepare(`
    SELECT tn.file AS target_file, tn.project AS target_project
    FROM edges e
    JOIN nodes sn ON e.source_id = sn.id
    JOIN nodes tn ON e.target_id = tn.id
    JOIN edge_types et ON e.type = et.name
    WHERE sn.project = ? AND sn.file = ? AND sn.name = ? AND sn.type = 'doc_section'
      AND et.category IN ('documentary')
    ORDER BY tn.file
  `);

  for (const row of rows) {
    const targets = checkTargetStmt.all(row.project, row.file, row.name);
    for (const t of targets) {
      // Check if target still exists in graph for same project
      const exists = db.prepare(`
        SELECT 1 FROM nodes WHERE project = ? AND file = ? LIMIT 1
      `).get(t.target_project || row.project, t.target_file);
      if (!exists) {
        findings.push(warn(
          `Orphaned doc reference: "${row.name}" in ${row.file} references "${t.target_file}" which is not in graph`,
          row.file, row.line
        ));
      }
    }
  }
  return findings;
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  function flag(name) {
    const idx = args.indexOf(name);
    if (idx === -1 || idx + 1 >= args.length) return null;
    return args[idx + 1];
  }

  function hasFlag(name) {
    return args.includes(name);
  }

  const project = flag('--project');
  const dbPath = flag('--db') || DEFAULT_DB;
  const workspaceDir = flag('--workspace');
  const repair = hasFlag('--repair');
  const yes = hasFlag('--yes');

  if (!fs.existsSync(dbPath)) {
    console.error(`graph.db not found at ${dbPath}`);
    console.error('Run `node scan.js` first to build the graph.');
    process.exit(1);
  }

  let graphDb;
  let db;
  try {
    graphDb = new GraphDB(dbPath);
    db = graphDb.db;
  } catch (err) {
    console.error(`Failed to open database: ${err.message}`);
    process.exit(1);
  }

  if (repair) {
    const projects = project
      ? [project]
      : db.prepare(
          'SELECT DISTINCT project FROM nodes UNION SELECT DISTINCT project FROM file_hashes'
        ).all().map(r => r.project);

    const plan = {};
    for (const p of projects) {
      plan[p] = {
        orphans: checkNodesWithoutFileHashes(db, p),
        stale: checkStaleFileHashes(db, p, workspaceDir),
      };
    }

    if (!yes) {
      console.log('# Plan only — re-run with --yes to apply.');
      for (const p of projects) {
        console.log(`\n${p}:`);
        console.log(`  orphans: ${plan[p].orphans.length}`);
        console.log(`  stale_hashes: ${plan[p].stale.length}`);
      }
      graphDb.close();
      process.exit(0);
    }

    for (const p of projects) {
      let orphansPurged = 0;
      let staleHashesPurged = 0;
      for (const f of plan[p].orphans) {
        graphDb.purgeFile(p, f.file);
        orphansPurged++;
      }
      for (const f of plan[p].stale) {
        graphDb.purgeFile(p, f.file);
        staleHashesPurged++;
      }
      console.log(`${p}:`);
      console.log(`  orphans_purged: ${orphansPurged}`);
      console.log(`  stale_hashes_purged: ${staleHashesPurged}`);
    }
    graphDb.close();
    process.exit(0);
  }

  // ── Default report path (existing behavior unchanged) ──
  const allFindings = [
    ...checkMissingEdgeTypeRegistrations(db, project),
    ...checkOrphanedAnnotations(db),
    ...checkStaleDocumentaryEdges(db, project, workspaceDir),
    ...checkOrphanedNodes(db, project),
    ...checkFileHashMismatches(db, project, workspaceDir),
    ...checkOrphanedDocumentation(db, project),
  ];

  const errors = allFindings.filter(f => f.severity === 'error');
  const warnings = allFindings.filter(f => f.severity === 'warning');

  if (allFindings.length === 0) {
    console.log('No issues found.');
    process.exit(0);
  }

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const f of errors) {
      console.log(formatItem(f));
    }
  }

  if (warnings.length > 0) {
    console.log(`\nWarnings (${warnings.length}):`);
    for (const f of warnings) {
      console.log(formatItem(f));
    }
  }

  console.log(`\n${errors.length} error(s), ${warnings.length} warning(s)`);

  // Exit 1 if there are errors
  if (errors.length > 0) process.exit(1);
}

if (require.main === module) main();

module.exports = {
  checkOrphanedNodes,
  checkNodesWithoutFileHashes,
  checkStaleDocumentaryEdges,
  checkStaleFileHashes,
  checkMissingEdgeTypeRegistrations,
  checkOrphanedAnnotations,
  checkFileHashMismatches,
  checkOrphanedDocumentation,
  formatItem,
};
