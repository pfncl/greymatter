'use strict';

const { foldDiacritics } = require('./tokenize');

class MemoryQueries {
  constructor(memoryDb) {
    this._db = memoryDb;
  }

  getSession(sessionId) {
    return this._db.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) || null;
  }

  getRecentSessions(limit) {
    return this._db.db.prepare(
      'SELECT * FROM sessions ORDER BY start_time DESC LIMIT ?'
    ).all(limit != null ? limit : 10);
  }

  getWindowsForSession(sessionId) {
    return this._db.db.prepare(
      'SELECT * FROM windows WHERE session_id = ? ORDER BY seq'
    ).all(sessionId);
  }

  getWindowContent(windowId) {
    return this._db.db.prepare(
      'SELECT * FROM conversation_content WHERE window_id = ?'
    ).get(windowId) || null;
  }

  getWindowFiles(windowId) {
    return this._db.db.prepare(
      'SELECT * FROM window_files WHERE window_id = ?'
    ).all(windowId);
  }

  getDecisions(windowId) {
    return this._db.db.prepare(
      'SELECT * FROM decisions WHERE window_id = ? ORDER BY seq'
    ).all(windowId);
  }

  // Find the most recent session that touched a given project.
  // Projects are stored as a JSON array in projects_json — use JSON1 json_each
  // for an exact element match so "api" doesn't prefix-match "api-gateway".
  getLastSessionForProject(project) {
    return this._db.db.prepare(
      `SELECT s.* FROM sessions s
       WHERE EXISTS (SELECT 1 FROM json_each(s.projects_json) WHERE value = ?)
       ORDER BY s.start_time DESC LIMIT 1`
    ).get(project) || null;
  }

  // Return active signals scoped to a specific project. Project-scoped means
  // file_pattern matches the project name OR a path under the project. NULL
  // file_pattern signals are excluded — those are global, surfaced elsewhere.
  getSignalsForProject(projectName) {
    if (!projectName) return [];
    const all = this._db.db.prepare(
      `SELECT * FROM signals
       WHERE archived = 0 AND file_pattern IS NOT NULL
       ORDER BY weight DESC`
    ).all();
    return all.filter(s => _matchesProject(s.file_pattern, projectName));
  }

  // Return active signals whose trigger is 'pre_write' and whose file_pattern
  // matches the supplied file path. NULL file_pattern matches every file.
  getPreWriteSignalsForFile(filePath) {
    if (!filePath) return [];
    const all = this._db.db.prepare(
      `SELECT * FROM signals
       WHERE archived = 0 AND trigger = 'pre_write'
       ORDER BY weight DESC`
    ).all();
    return all.filter(s => !s.file_pattern || _globMatches(s.file_pattern, filePath));
  }

  // Return the N most recent sessions that touched a given project, with
  // their touched files (deduped) and top decisions. Used by scripts/recent.js.
  getRecentSessionsForProject(project, limit) {
    const lim = limit != null ? limit : 3;
    const matched = this._db.db.prepare(
      `SELECT s.* FROM sessions s
       WHERE EXISTS (SELECT 1 FROM json_each(s.projects_json) WHERE value = ?)
       ORDER BY COALESCE(s.end_time, s.start_time) DESC LIMIT ?`
    ).all(project, lim);

    const getFiles = this._db.db.prepare(
      `SELECT DISTINCT wf.file_path AS file_path, wf.tool AS tool
       FROM window_files wf
       JOIN windows w ON w.id = wf.window_id
       WHERE w.session_id = ?`
    );
    const getDecisions = this._db.db.prepare(
      `SELECT d.seq AS seq, d.summary AS summary, d.status AS status, d.terms AS terms
       FROM decisions d
       JOIN windows w ON w.id = d.window_id
       WHERE w.session_id = ?
       ORDER BY w.seq, d.seq
       LIMIT 5`
    );

    return matched.map(s => ({
      session_id: s.id,
      start_time: s.start_time,
      end_time: s.end_time,
      files: getFiles.all(s.id),
      decisions: getDecisions.all(s.id),
    }));
  }

  // Multi-strategy alias resolution:
  //   1. exact match scoped to projectHint (if provided)
  //   2. "<project> <rest>" form — if first token is a known project, look up rest
  //   3. fuzzy substring match across all projects (LIKE '%alias%')
  // Returns an array of { alias, project, file } rows, possibly empty.
  resolveAliases(aliasInput, projectHint) {
    if (!aliasInput) return [];
    const trimmed = String(aliasInput).trim();

    // Strategy 1: exact match scoped to projectHint
    if (projectHint) {
      const rows = this._db.db.prepare(
        'SELECT alias, project, file FROM aliases WHERE alias = ? AND project = ?'
      ).all(trimmed, projectHint);
      if (rows.length > 0) return rows;
    }

    // Strategy 1b: exact match across all projects
    const exactRows = this._db.db.prepare(
      'SELECT alias, project, file FROM aliases WHERE alias = ?'
    ).all(trimmed);
    if (exactRows.length > 0) return exactRows;

    // Strategy 2: "<project> <rest>" — token split on first space
    const firstSpace = trimmed.indexOf(' ');
    if (firstSpace > 0) {
      const firstToken = trimmed.slice(0, firstSpace);
      const rest = trimmed.slice(firstSpace + 1).trim();
      const knownProjects = this._db.db.prepare(
        'SELECT DISTINCT project FROM aliases WHERE project = ?'
      ).all(firstToken);
      if (knownProjects.length > 0 && rest) {
        const rows = this._db.db.prepare(
          'SELECT alias, project, file FROM aliases WHERE alias = ? AND project = ?'
        ).all(rest, firstToken);
        if (rows.length > 0) return rows;
      }
    }

    // Strategy 3: fuzzy substring across all projects
    return this._db.db.prepare(
      'SELECT alias, project, file FROM aliases WHERE alias LIKE ? ORDER BY project, alias'
    ).all(`%${trimmed}%`);
  }

  listAliases(project) {
    if (project) {
      return this._db.db.prepare(
        'SELECT * FROM aliases WHERE project = ? ORDER BY alias'
      ).all(project);
    }
    return this._db.db.prepare(
      'SELECT * FROM aliases ORDER BY project, alias'
    ).all();
  }

  // Find a window by session id prefix and seq number.
  findWindow(sessionIdOrPrefix, seq) {
    const exact = this._db.db.prepare(
      'SELECT * FROM windows WHERE session_id = ? AND seq = ?'
    ).get(sessionIdOrPrefix, seq);
    if (exact) return exact;
    // prefix match
    return this._db.db.prepare(
      'SELECT * FROM windows WHERE session_id LIKE ? AND seq = ?'
    ).get(sessionIdOrPrefix + '%', seq) || null;
  }

  // Return window metadata + decisions for --digest mode (no content).
  getWindowDigest(sessionIdOrPrefix, seq) {
    const win = this.findWindow(sessionIdOrPrefix, seq);
    if (!win) return null;
    const decisions = this._db.db.prepare(
      'SELECT seq, summary, terms, status FROM decisions WHERE window_id = ? ORDER BY seq'
    ).all(win.id);
    return { window: win, decisions };
  }

  // Return raw JSONL content stored for a window (full text).
  getWindowFullContent(sessionIdOrPrefix, seq) {
    const win = this.findWindow(sessionIdOrPrefix, seq);
    if (!win) return null;
    const row = this._db.db.prepare(
      'SELECT content FROM conversation_content WHERE window_id = ?'
    ).get(win.id);
    return row ? { window: win, content: row.content } : { window: win, content: '' };
  }

  // Return decisions list for a window identified by session prefix + seq.
  getWindowDecisionsBySeq(sessionIdOrPrefix, seq) {
    const win = this.findWindow(sessionIdOrPrefix, seq);
    if (!win) return null;
    return this._db.db.prepare(
      'SELECT * FROM decisions WHERE window_id = ? ORDER BY seq'
    ).all(win.id);
  }

  // Signals: return active signals matching trigger type, above weight threshold.
  // 'passive' signals fire everywhere; specific trigger signals fire only when queried for.
  getActiveSignals(trigger, threshold) {
    const t = threshold != null ? threshold : 0;
    return this._db.db.prepare(
      `SELECT * FROM signals
       WHERE archived = 0 AND weight >= ?
         AND (trigger = ? OR trigger = 'passive')
       ORDER BY weight DESC`
    ).all(t, trigger || 'passive');
  }

  getActiveForces(threshold) {
    const t = threshold != null ? threshold : 0;
    return this._db.db.prepare(
      'SELECT * FROM forces WHERE archived = 0 AND score >= ? ORDER BY score DESC'
    ).all(t);
  }

  getAllSignals() {
    return this._db.db.prepare(
      'SELECT * FROM signals ORDER BY type, weight DESC'
    ).all();
  }

  getAllForces() {
    return this._db.db.prepare(
      'SELECT * FROM forces ORDER BY score DESC'
    ).all();
  }

  // Format signals + forces above threshold as markdown rules file.
  // Two sections: "Behavioral Rules" (sorted by weight) and "Relational Forces" (sorted by score).
  generateSignalsMd(threshold) {
    const t = threshold != null ? threshold : 0;
    const signals = this._db.db.prepare(
      'SELECT * FROM signals WHERE archived = 0 AND weight >= ? ORDER BY weight DESC'
    ).all(t);
    const forces = this._db.db.prepare(
      'SELECT * FROM forces WHERE archived = 0 AND score >= ? ORDER BY score DESC'
    ).all(t);

    const lines = ['# Behavioral Signals', ''];

    lines.push('## Behavioral Rules', '');
    if (signals.length === 0) {
      lines.push('*No behavioral rules recorded yet.*', '');
    } else {
      for (const s of signals) {
        const desc = s.description ? ` — ${s.description}` : '';
        lines.push(`- \`${s.weight}\` (${s.polarity}) **${s.label}**${desc}`);
      }
      lines.push('');
    }

    lines.push('## Relational Forces', '');
    if (forces.length === 0) {
      lines.push('*No relational forces recorded yet.*', '');
    } else {
      for (const f of forces) {
        const desc = f.description ? ` — ${f.description}` : '';
        lines.push(`- \`${f.score}\` **${f.name}**${desc}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  // Returns the set of promoted stopwords for filtering FTS5 queries.
  _getPromotedStopwords() {
    try {
      const rows = this._db.db.prepare(
        'SELECT term FROM stopword_candidates WHERE promoted = 1'
      ).all();
      return new Set(rows.map(r => r.term.toLowerCase()));
    } catch (err) {
      process.stderr.write(`greymatter: stopword query failed: ${err.message}\n`);
      return new Set();
    }
  }

  // FTS5-backed conversation search.
  // clusters: array of arrays — inner arrays are OR terms, outer array is AND.
  // Returns windows with scores and decision digests, sorted by score desc.
  searchConversations(clusters, limit) {
    if (!clusters || clusters.length === 0) return [];

    const stopwords = this._getPromotedStopwords();

    // For each cluster, collect rowids that match any term in the cluster
    const clusterRowidSets = [];
    for (const cluster of clusters) {
      if (!cluster || cluster.length === 0) continue;
      // Build FTS5 MATCH string: term1 OR term2 ... (filter out promoted stopwords)
      // Query terms are folded the same way the index tokenizer folds ingested
      // text — "klubová" and "klubova" must both hit the indexed "klubova".
      const matchParts = cluster
        .map(t => foldDiacritics(t.toLowerCase()).replace(/['"]/g, ''))
        .filter(t => t && !stopwords.has(t));
      if (matchParts.length === 0) continue;
      const matchStr = matchParts.join(' OR ');
      let rows;
      try {
        rows = this._db.db.prepare(
          'SELECT rowid FROM search_index WHERE search_index MATCH ?'
        ).all(matchStr);
      } catch {
        rows = [];
      }
      clusterRowidSets.push(new Set(rows.map(r => r.rowid)));
    }

    if (clusterRowidSets.length === 0) return [];

    // Intersect across clusters (AND behavior)
    let candidateIds = [...clusterRowidSets[0]];
    for (let i = 1; i < clusterRowidSets.length; i++) {
      candidateIds = candidateIds.filter(id => clusterRowidSets[i].has(id));
    }

    if (candidateIds.length === 0) return [];

    const effectiveLimit = limit != null ? limit : 10;
    const getWindow = this._db.db.prepare('SELECT * FROM windows WHERE id = ?');
    const getDecisions = this._db.db.prepare(
      'SELECT seq, summary, status FROM decisions WHERE window_id = ? ORDER BY seq'
    );

    const results = [];
    for (const id of candidateIds) {
      const win = getWindow.get(id);
      if (!win) continue;
      const decisions = getDecisions.all(id);
      // Score: number of clusters matched (all candidates matched all clusters)
      // Add recency bonus via end_time comparison
      results.push({
        session_id: win.session_id,
        seq: win.seq,
        start_time: win.start_time,
        end_time: win.end_time,
        scope: win.scope,
        summary: win.summary,
        score: clusterRowidSets.length,
        decisions,
      });
    }

    // Sort by score desc, then by end_time desc (most recent first)
    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.end_time || '').localeCompare(a.end_time || '');
    });

    return results.slice(0, effectiveLimit);
  }
  // ── Stopword management ─────────────────────────────────────────────────────

  // Flag terms as noise (increment noise_count). Auto-promote when noise_count >= 5.
  flagNoise(terms) {
    const now = new Date().toISOString();
    for (const term of terms) {
      const t = term.toLowerCase().trim();
      if (!t) continue;
      this._db.db.prepare(`
        INSERT INTO stopword_candidates (term, noise_count, relevant_count, promoted, last_seen)
        VALUES (?, 1, 0, 0, ?)
        ON CONFLICT(term) DO UPDATE SET
          noise_count = noise_count + 1,
          last_seen = excluded.last_seen
      `).run(t, now);

      // Auto-promote if noise_count >= 5 and relevant_count == 0
      this._db.db.prepare(`
        UPDATE stopword_candidates
        SET promoted = 1
        WHERE term = ? AND noise_count >= 5 AND relevant_count = 0
      `).run(t);
    }
  }

  // Flag terms as relevant (increment relevant_count, reset noise streak prevention).
  flagRelevant(terms) {
    const now = new Date().toISOString();
    for (const term of terms) {
      const t = term.toLowerCase().trim();
      if (!t) continue;
      this._db.db.prepare(`
        INSERT INTO stopword_candidates (term, noise_count, relevant_count, promoted, last_seen)
        VALUES (?, 0, 1, 0, ?)
        ON CONFLICT(term) DO UPDATE SET
          relevant_count = relevant_count + 1,
          noise_count = 0,
          promoted = 0,
          last_seen = excluded.last_seen
      `).run(t, now);
    }
  }

  // Demote a promoted term back (set promoted = 0).
  demoteStopword(term) {
    const t = term.toLowerCase().trim();
    this._db.db.prepare(
      'UPDATE stopword_candidates SET promoted = 0 WHERE term = ?'
    ).run(t);
  }

  // List all stopword candidates with their counts and promotion status.
  listStopwords() {
    return this._db.db.prepare(
      'SELECT term, noise_count, relevant_count, promoted, last_seen FROM stopword_candidates ORDER BY noise_count DESC, term'
    ).all();
  }
}

// Glob → RegExp matcher: * → .*, ? → ., everything else literal. Anchored.
// Two-pass: split on * first so the wildcard escapes aren't also escaped
// by the literal-escape step.
function _globMatches(pattern, input) {
  try {
    const body = pattern
      .split('*')
      .map(seg => seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\?/g, '.'))
      .join('.*');
    return new RegExp('^' + body + '$').test(input);
  } catch {
    return false;
  }
}

// True if file_pattern indicates a signal scoped to the given project — either
// the project name appears in the pattern verbatim, or the pattern matches the
// project's bare name via glob expansion.
function _matchesProject(filePattern, projectName) {
  if (!filePattern || !projectName) return false;
  if (filePattern.includes(projectName)) return true;
  return _globMatches(filePattern, projectName);
}

module.exports = { MemoryQueries, _globMatches, _matchesProject };
