'use strict';

const Database = require('better-sqlite3');

const SCHEMA_VERSION = '3.2.0';

class GraphDB {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this._initSchema();
    this._prepareStatements();
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        file TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        line INTEGER,
        metadata_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME
      );

      CREATE TABLE IF NOT EXISTS edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        target_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        category TEXT NOT NULL,
        source_project TEXT NOT NULL,
        source_file TEXT NOT NULL,
        data_json TEXT,
        sequence INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME
      );

      CREATE TABLE IF NOT EXISTS edge_types (
        name TEXT PRIMARY KEY,
        category TEXT NOT NULL CHECK(category IN ('structural', 'data_flow', 'documentary', 'informational')),
        follows_for_blast_radius BOOLEAN DEFAULT 0,
        implies_staleness BOOLEAN DEFAULT 0,
        description TEXT
      );

      CREATE TABLE IF NOT EXISTS file_hashes (
        project TEXT NOT NULL,
        file TEXT NOT NULL,
        hash TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME,
        PRIMARY KEY (project, file)
      );

      CREATE TABLE IF NOT EXISTS annotations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        author TEXT DEFAULT 'human',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME
      );

      CREATE TABLE IF NOT EXISTS project_context (
        project TEXT PRIMARY KEY,
        context_json TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_unique
        ON nodes(project, file, name, type, COALESCE(line, -1));
      CREATE INDEX IF NOT EXISTS idx_nodes_project_file ON nodes(project, file);
      CREATE INDEX IF NOT EXISTS idx_nodes_project_type ON nodes(project, type);
      CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
      CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(type);
      CREATE INDEX IF NOT EXISTS idx_edges_category ON edges(category);
      CREATE INDEX IF NOT EXISTS idx_edges_source_file ON edges(source_project, source_file);
      CREATE INDEX IF NOT EXISTS idx_annotations_node ON annotations(node_id);

      CREATE TABLE IF NOT EXISTS test_findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        source_file TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('stale_pair', 'missing_test')),
        first_seen_sha TEXT NOT NULL,
        last_seen_sha TEXT NOT NULL,
        last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        seen_count INTEGER NOT NULL DEFAULT 1,
        resolved_at DATETIME,
        resolved_sha TEXT,
        test_file TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_test_findings_unique_open
        ON test_findings(project, source_file, kind, COALESCE(test_file, ''))
        WHERE resolved_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_test_findings_open
        ON test_findings(project, resolved_at);

      CREATE TABLE IF NOT EXISTS project_scan_state (
        project TEXT PRIMARY KEY,
        last_scan_sha TEXT,
        last_scan_at DATETIME,
        last_scan_mode TEXT CHECK(last_scan_mode IN ('incremental', 'audit')),
        root_path TEXT
      );
    `);

    // Idempotent migration: add root_path to pre-existing databases that were
    // created before this column existed. SQLite has no ADD COLUMN IF NOT EXISTS,
    // so probe table_info and skip if already present.
    const cols = this.db.prepare(`PRAGMA table_info(project_scan_state)`).all();
    if (!cols.some(c => c.name === 'root_path')) {
      this.db.exec(`ALTER TABLE project_scan_state ADD COLUMN root_path TEXT`);
    }

    try {
      this.db.exec(`ALTER TABLE nodes ADD COLUMN body_hash TEXT;`);
    } catch (e) {
      if (!/duplicate column name/i.test(e.message)) throw e;
    }

    try {
      this.db.exec(`ALTER TABLE project_scan_state ADD COLUMN exclusion_policy_hash TEXT;`);
    } catch (e) {
      if (!/duplicate column name/i.test(e.message)) throw e;
    }
    try {
      this.db.exec(`ALTER TABLE project_scan_state ADD COLUMN exclusion_purged_at DATETIME;`);
    } catch (e) {
      if (!/duplicate column name/i.test(e.message)) throw e;
    }
    // last_full_scan_at — timestamp of the last WHOLE-PROJECT scan (scan.js).
    // Distinct from last_scan_at, which the test-alerts git-diff pass owns and
    // overwrites. Only a full scan runs the two-pass import resolution that
    // populates reverse-import edges, so blast-radius can only trust
    // "nothing depends on X" for nodes not touched since this timestamp.
    if (!cols.some(c => c.name === 'last_full_scan_at')) {
      this.db.exec(`ALTER TABLE project_scan_state ADD COLUMN last_full_scan_at DATETIME`);
      // Backfill on first upgrade: snapshot each existing project's current
      // graph as its full-scan baseline. Without this, every project's column
      // is NULL and blast-radius would flag EVERY empty result as "maybe stale"
      // until the next full scan — a false-positive flood that trains the agent
      // to ignore the warning. Trusting the already-indexed graph and only
      // warning on nodes edited AFTER the upgrade is the honest default; a
      // genuinely never-scanned project added later stays NULL and does warn.
      this.db.exec(
        `UPDATE project_scan_state SET last_full_scan_at = CURRENT_TIMESTAMP WHERE last_full_scan_at IS NULL`
      );
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS code_labels (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
          detector_id TEXT NOT NULL,
          term TEXT NOT NULL,
          category TEXT NOT NULL,
          descriptors_json TEXT,
          role_summary TEXT,
          confidence REAL NOT NULL,
          source TEXT NOT NULL CHECK(source IN ('heuristic','llm','manual')),
          model_id TEXT,
          body_hash_at_label TEXT,
          is_stale INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME
      );
      CREATE INDEX IF NOT EXISTS idx_code_labels_node
          ON code_labels(node_id);
      CREATE INDEX IF NOT EXISTS idx_code_labels_node_source
          ON code_labels(node_id, source);
      CREATE INDEX IF NOT EXISTS idx_code_labels_stale
          ON code_labels(is_stale);
      CREATE INDEX IF NOT EXISTS idx_code_labels_category
          ON code_labels(category);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_code_labels_unique
          ON code_labels(node_id, detector_id, source);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      );
    `);
    this.db.prepare(`
      INSERT INTO meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run('schema_version', SCHEMA_VERSION);
  }

  _prepareStatements() {
    this._stmtInsertNode = this.db.prepare(`
      INSERT OR IGNORE INTO nodes (project, file, name, type, line, metadata_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
    this._stmtUpdateNode = this.db.prepare(`
      UPDATE nodes SET metadata_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE project = ? AND file = ? AND name = ? AND type = ? AND COALESCE(line, -1) = ?
    `);
    this._stmtGetNodeId = this.db.prepare(`
      SELECT id FROM nodes
      WHERE project = ? AND file = ? AND name = ? AND type = ? AND COALESCE(line, -1) = ?
    `);
    this._stmtInsertEdge = this.db.prepare(`
      INSERT INTO edges (source_id, target_id, type, category, source_project, source_file, data_json, sequence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this._stmtRegisterEdgeType = this.db.prepare(`
      INSERT OR IGNORE INTO edge_types (name, category, follows_for_blast_radius, implies_staleness, description)
      VALUES (?, ?, ?, ?, ?)
    `);
    this._stmtSetFileHash = this.db.prepare(`
      INSERT INTO file_hashes (project, file, hash, updated_at)
      VALUES (?, ?, ?, strftime('%Y-%m-%d %H:%M:%f','now'))
      ON CONFLICT(project, file) DO UPDATE SET
        hash = excluded.hash,
        updated_at = strftime('%Y-%m-%d %H:%M:%f','now')
    `);
    this._stmtGetFileHash = this.db.prepare(`
      SELECT hash FROM file_hashes WHERE project = ? AND file = ?
    `);
    this._stmtDeleteFileNodes = this.db.prepare(`
      DELETE FROM nodes WHERE project = ? AND file = ?
    `);
    this._stmtDeleteFileEdges = this.db.prepare(`
      DELETE FROM edges WHERE source_project = ? AND source_file = ?
    `);
    this._stmtAddAnnotation = this.db.prepare(`
      INSERT INTO annotations (node_id, content, author) VALUES (?, ?, ?)
    `);
    this._stmtSelectOpenFindings = this.db.prepare(`
      SELECT id, project, source_file, kind, test_file,
             first_seen_sha, last_seen_sha, seen_count
      FROM test_findings
      WHERE project = ? AND resolved_at IS NULL
    `);
    this._stmtInsertFinding = this.db.prepare(`
      INSERT INTO test_findings
        (project, source_file, kind, test_file,
         first_seen_sha, last_seen_sha, seen_count)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `);
    this._stmtBumpFinding = this.db.prepare(`
      UPDATE test_findings
         SET last_seen_sha = ?, last_seen_at = CURRENT_TIMESTAMP,
             seen_count = seen_count + 1
       WHERE project = ? AND source_file = ? AND kind = ?
         AND COALESCE(test_file, '') = COALESCE(?, '')
         AND resolved_at IS NULL
    `);
    this._stmtResolveFinding = this.db.prepare(`
      UPDATE test_findings
         SET resolved_at = CURRENT_TIMESTAMP, resolved_sha = ?
       WHERE id = ?
    `);
    this._stmtGetScanState = this.db.prepare(`
      SELECT last_scan_sha, last_scan_at, last_scan_mode, root_path, last_full_scan_at
      FROM project_scan_state WHERE project = ?
    `);
    this._stmtSetFullScanAt = this.db.prepare(`
      INSERT INTO project_scan_state (project, last_full_scan_at)
      VALUES (?, CURRENT_TIMESTAMP)
      ON CONFLICT(project) DO UPDATE SET last_full_scan_at = CURRENT_TIMESTAMP
    `);
    this._stmtGetFileNewestNodeTime = this.db.prepare(`
      SELECT MAX(COALESCE(updated_at, created_at)) AS t
      FROM nodes WHERE project = ? AND file = ?
    `);
    this._stmtUpsertScanState = this.db.prepare(`
      INSERT INTO project_scan_state (project, last_scan_sha, last_scan_at, last_scan_mode)
      VALUES (?, ?, CURRENT_TIMESTAMP, ?)
      ON CONFLICT(project) DO UPDATE SET
        last_scan_sha = excluded.last_scan_sha,
        last_scan_at  = excluded.last_scan_at,
        last_scan_mode = excluded.last_scan_mode
    `);
    this._stmtGetProjectRoot = this.db.prepare(`
      SELECT root_path FROM project_scan_state WHERE project = ?
    `);
    this._stmtSetProjectRoot = this.db.prepare(`
      INSERT INTO project_scan_state (project, root_path)
      VALUES (?, ?)
      ON CONFLICT(project) DO UPDATE SET root_path = excluded.root_path
    `);
    this._stmtGetFileHashRowsForProject = this.db.prepare(`
      SELECT file, hash, updated_at FROM file_hashes WHERE project = ?
    `);
    this._stmtGetOrphanNodeFilesForProject = this.db.prepare(`
      SELECT DISTINCT n.file
      FROM nodes n
      LEFT JOIN file_hashes fh
        ON fh.project = n.project AND fh.file = n.file
      WHERE n.project = ?
        AND fh.file IS NULL
    `);
    this._stmtPurgeFileHash = this.db.prepare(`
      DELETE FROM file_hashes WHERE project = ? AND file = ?
    `);
    this._stmtUpdateLastScanSha = this.db.prepare(`
      INSERT INTO project_scan_state (project, last_scan_sha, last_scan_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(project) DO UPDATE SET
        last_scan_sha = excluded.last_scan_sha,
        last_scan_at  = excluded.last_scan_at
    `);
    this._stmtGetExclusionState = this.db.prepare(`
      SELECT exclusion_policy_hash, exclusion_purged_at
      FROM project_scan_state WHERE project = ?
    `);
    this._stmtSetExclusionState = this.db.prepare(`
      INSERT INTO project_scan_state (project, exclusion_policy_hash, exclusion_purged_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(project) DO UPDATE SET
        exclusion_policy_hash = excluded.exclusion_policy_hash,
        exclusion_purged_at   = excluded.exclusion_purged_at
    `);
  }

  // Insert or update a node. Returns the stable id.
  upsertNode({ project, file, name, type, line = null, metadata = null }) {
    const metadata_json = metadata != null ? JSON.stringify(metadata) : null;
    const lineKey = line != null ? line : -1;

    const insertResult = this._stmtInsertNode.run(project, file, name, type, line, metadata_json);
    if (insertResult.changes > 0) {
      return Number(insertResult.lastInsertRowid);
    }

    // Row already exists — update metadata and return existing id
    this._stmtUpdateNode.run(metadata_json, project, file, name, type, lineKey);
    const row = this._stmtGetNodeId.get(project, file, name, type, lineKey);
    return row.id;
  }

  insertEdge({ sourceId, targetId, type, category, sourceProject, sourceFile, data = null, sequence = null }) {
    const data_json = data != null ? JSON.stringify(data) : null;
    const result = this._stmtInsertEdge.run(sourceId, targetId, type, category, sourceProject, sourceFile, data_json, sequence);
    return Number(result.lastInsertRowid);
  }

  registerEdgeType({ name, category, followsForBlastRadius = false, impliesStaleness = false, description = null }) {
    this._stmtRegisterEdgeType.run(name, category, followsForBlastRadius ? 1 : 0, impliesStaleness ? 1 : 0, description);
  }

  setFileHash(project, file, hash) {
    this._stmtSetFileHash.run(project, file, hash);
  }

  getFileHash(project, file) {
    const row = this._stmtGetFileHash.get(project, file);
    return row ? row.hash : null;
  }

  deleteFileNodes(project, file) {
    this._stmtDeleteFileNodes.run(project, file);
  }

  deleteFileEdges(project, file) {
    this._stmtDeleteFileEdges.run(project, file);
  }

  addAnnotation(nodeId, content, author = 'human') {
    const result = this._stmtAddAnnotation.run(nodeId, content, author);
    return Number(result.lastInsertRowid);
  }

  getOpenFindings(project) {
    return this._stmtSelectOpenFindings.all(project);
  }

  insertFinding({ project, source_file, kind, test_file, first_seen_sha, last_seen_sha }) {
    const result = this._stmtInsertFinding.run(
      project, source_file, kind, test_file || null,
      first_seen_sha, last_seen_sha
    );
    return Number(result.lastInsertRowid);
  }

  bumpFinding({ project, source_file, kind, test_file, last_seen_sha }) {
    this._stmtBumpFinding.run(
      last_seen_sha, project, source_file, kind, test_file || null
    );
  }

  resolveFinding(id, resolvedSha) {
    this._stmtResolveFinding.run(resolvedSha, id);
  }

  getScanState(project) {
    return this._stmtGetScanState.get(project) || null;
  }

  upsertScanState(project, sha, mode) {
    this._stmtUpsertScanState.run(project, sha, mode);
  }

  // Stamp the completion of a whole-project scan (scan.js). This is the
  // watermark blast-radius uses to decide whether an empty result is
  // trustworthy or merely un-resolved for a same-session file.
  setFullScanAt(project) {
    this._stmtSetFullScanAt.run(project);
  }

  // Newest updated_at/created_at across all nodes of a file. Returns a SQLite
  // datetime string (UTC, 'YYYY-MM-DD HH:MM:SS') or null when the file has no
  // nodes. Compared against last_full_scan_at to detect same-session drift.
  getFileNewestNodeTime(project, file) {
    const row = this._stmtGetFileNewestNodeTime.get(project, file);
    return (row && row.t) || null;
  }

  getProjectRoot(project) {
    const row = this._stmtGetProjectRoot.get(project);
    return (row && row.root_path) || null;
  }

  setProjectRoot(project, rootPath) {
    this._stmtSetProjectRoot.run(project, rootPath);
  }

  getFileHashRowsForProject(project) {
    return this._stmtGetFileHashRowsForProject.all(project);
  }

  getOrphanNodeFilesForProject(project) {
    return this._stmtGetOrphanNodeFilesForProject.all(project).map(r => r.file);
  }

  purgeFile(project, file) {
    this.db.transaction(() => {
      this.deleteFileNodes(project, file);
      this.deleteFileEdges(project, file);
      this._stmtPurgeFileHash.run(project, file);
    })();
  }

  updateLastScanSha(project, sha) {
    this._stmtUpdateLastScanSha.run(project, sha);
  }

  getExclusionState(project) {
    return this._stmtGetExclusionState.get(project) || null;
  }

  setExclusionState(project, hash) {
    this._stmtSetExclusionState.run(project, hash);
  }

  getLabels(nodeId, opts = {}) {
    const { all = false, multi = false } = opts;
    const wherePieces = ['node_id = ?'];
    const params = [nodeId];
    if (!all) wherePieces.push('is_stale = 0');

    const sql = `
      SELECT id, node_id, detector_id, term, category, descriptors_json,
             role_summary, confidence, source, model_id,
             body_hash_at_label, is_stale, created_at, updated_at
      FROM code_labels
      WHERE ${wherePieces.join(' AND ')}
      ORDER BY
        CASE source
          WHEN 'manual' THEN 0
          WHEN 'llm' THEN 1
          WHEN 'heuristic' THEN 2
        END,
        confidence DESC,
        id DESC
      ${multi ? '' : 'LIMIT 1'}
    `;
    const stmt = this.db.prepare(sql);
    if (multi) return stmt.all(...params);
    return stmt.get(...params) || null;
  }

  upsertLabel(label) {
    const {
      nodeId, detectorId, term, category,
      descriptors, roleSummary = null,
      confidence, source,
      modelId = null, bodyHashAtLabel = null,
    } = label;

    let clamped = confidence;
    if (typeof clamped !== 'number' || Number.isNaN(clamped)) {
      throw new TypeError(`upsertLabel: confidence must be a number, got ${confidence}`);
    }
    if (clamped > 1.0) {
      console.warn(`upsertLabel: confidence ${clamped} clamped to 1.0 for ${detectorId} on node ${nodeId}`);
      clamped = 1.0;
    } else if (clamped < 0.0) {
      console.warn(`upsertLabel: confidence ${clamped} clamped to 0.0 for ${detectorId} on node ${nodeId}`);
      clamped = 0.0;
    }

    const descriptorsJson = Array.isArray(descriptors) && descriptors.length > 0
      ? JSON.stringify(descriptors)
      : null;

    this.db.prepare(`
      INSERT INTO code_labels
        (node_id, detector_id, term, category, descriptors_json, role_summary,
         confidence, source, model_id, body_hash_at_label, is_stale, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
      ON CONFLICT(node_id, detector_id, source) DO UPDATE SET
        term = excluded.term,
        category = excluded.category,
        descriptors_json = excluded.descriptors_json,
        role_summary = excluded.role_summary,
        confidence = excluded.confidence,
        model_id = excluded.model_id,
        body_hash_at_label = excluded.body_hash_at_label,
        is_stale = 0,
        updated_at = CURRENT_TIMESTAMP
    `).run(nodeId, detectorId, term, category, descriptorsJson, roleSummary,
           clamped, source, modelId, bodyHashAtLabel);
  }

  markLabelsStale(nodeId, newBodyHash) {
    this.db.prepare(`
      UPDATE code_labels
      SET is_stale = 1, updated_at = CURRENT_TIMESTAMP
      WHERE node_id = ?
        AND body_hash_at_label IS NOT NULL
        AND body_hash_at_label != ?
    `).run(nodeId, newBodyHash);
  }

  getNodeBodyHash(nodeId) {
    const row = this.db.prepare('SELECT body_hash FROM nodes WHERE id = ?').get(nodeId);
    return row ? row.body_hash : null;
  }

  setNodeBodyHash(nodeId, hash) {
    this.db.prepare('UPDATE nodes SET body_hash = ? WHERE id = ?').run(hash, nodeId);
  }

  getMeta(key) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  withTransaction(fn) {
    return this.db.transaction(fn)();
  }

  close() {
    this.db.close();
  }
}

module.exports = { GraphDB, SCHEMA_VERSION };
