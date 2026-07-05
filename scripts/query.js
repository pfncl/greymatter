'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { GraphDB } = require('../lib/graph-db');
const { GraphQueries } = require('../lib/graph-queries');
const { MemoryDB } = require('../lib/memory-db');
const { MemoryQueries } = require('../lib/memory-queries');
const { getProjectContext, listProjectContexts, getRecentSessions } = require('../lib/reorientation');

const DEFAULT_DB = path.join(os.homedir(), '.claude', 'greymatter', 'graph.db');
const DEFAULT_MEMORY_DB = path.join(os.homedir(), '.claude', 'greymatter', 'memory.db');

// ── Formatters (exported for testing) ────────────────────────────────────────

function formatMap(fileList, project) {
  if (!fileList || fileList.length === 0) {
    return `(no files indexed for project "${project}")`;
  }
  const lines = [`Project: ${project}  (${fileList.length} files)\n`];
  for (const { file, nodes } of fileList) {
    const defs = nodes.filter(n => n.type !== 'module');
    const defStr = defs.length > 0
      ? defs.map(n => `${n.type}:${n.name}`).join(', ')
      : '(no definitions)';
    lines.push(`  ${file}  →  ${defStr}`);
  }
  return lines.join('\n');
}

function formatFind(results) {
  if (!results || results.length === 0) return '(no matches)';
  return results.map(n => {
    const loc = n.line != null ? `${n.file}:${n.line}` : n.file;
    return `${n.project}/${loc}  ${n.type}  ${n.name}`;
  }).join('\n');
}

function formatBlastRadius(dependents, file, opts) {
  const inGraph = opts && opts.inGraph;
  const onDisk = opts && opts.onDisk;
  const projectRoot = (opts && opts.projectRoot) || '<PROJECT_ROOT>';
  if (!dependents || dependents.length === 0) {
    if (onDisk && !inGraph) {
      // File exists on disk but graph has no nodes for it — graph is stale
      // (file written this session, not yet re-scanned). "Nothing depends on"
      // is misleading; report the staleness explicitly.
      //
      // Name the EXACT remediation. The trap this closes: reverse-import edges
      // ("who imports me") are only produced by the whole-project two-pass
      // resolution in scan.js — re-running --blast-radius or scanning a
      // subdirectory can NEVER populate them. The rescan must cover the whole
      // project root so importer and importee land in fileNodeMaps together.
      return `(graph stale — "${file}" exists on disk but is not yet indexed.\n`
        + `  Fix: node scan.js --dir ${projectRoot}\n`
        + `  Must be the whole project root, not a subdirectory — reverse-import `
        + `edges are resolved in a project-wide two-pass; a scoped rescan will `
        + `still report stale.)`;
    }
    if (opts && opts.reverseMaybeStale) {
      // Node exists but was touched more recently than the last whole-project
      // scan — its reverse-import edges may not be resolved yet. Empty here is
      // NOT authoritative; don't treat the file as safe-to-delete on this basis.
      return `(no dependents found for "${file}" — but this file was indexed `
        + `after the last full scan, so reverse-import edges may be incomplete.\n`
        + `  This is NOT authoritative — do not treat as safe-to-delete.\n`
        + `  Confirm with: node scan.js --dir ${projectRoot}  (then re-query).`;
    }
    return `(nothing depends on "${file}")`;
  }
  const lines = [`Blast radius for ${file}:`];
  for (const dep of dependents) {
    lines.push(`  ${dep.project}/${dep.file}`);
  }
  return lines.join('\n');
}

function formatFlow(flowData, file) {
  const { inbound = [], outbound = [] } = flowData || {};
  const lines = [`Flow for ${file}:`];
  if (outbound.length > 0) {
    lines.push(`  outbound (${outbound.length}):`);
    for (const e of outbound) {
      lines.push(`    [${e.type}] → target:${e.target_id}`);
    }
  }
  if (inbound.length > 0) {
    lines.push(`  inbound (${inbound.length}):`);
    for (const e of inbound) {
      lines.push(`    [${e.type}] ← source:${e.source_id}`);
    }
  }
  if (inbound.length === 0 && outbound.length === 0) lines.push('  (no edges)');
  return lines.join('\n');
}

function formatTrace(traceData, name) {
  const { node, edges } = traceData || {};
  if (!node) return `(no node named "${name}")`;
  const lines = [`${node.project}/${node.file}:${node.line}  ${node.type}  ${node.name}`];
  const out = (edges || []).filter(e => e.source_id === node.id);
  const inn = (edges || []).filter(e => e.target_id === node.id);
  if (out.length > 0) lines.push(`  outbound: ${out.map(e => `[${e.type}]→${e.target_id}`).join(', ')}`);
  if (inn.length > 0) lines.push(`  inbound:  ${inn.map(e => `[${e.type}]←${e.source_id}`).join(', ')}`);
  return lines.join('\n');
}

function formatExclusions(policy, project, sampleMatches) {
  const lines = [`[exclusions: ${project}]`];
  lines.push(`respect_gitignore: ${policy.respectGitignore}`);
  lines.push(`respect_greymatterignore: ${policy.respectGreymatterignore}`);
  lines.push(`hash: ${policy.hash.slice(0, 12)}...`);
  lines.push('');
  lines.push(`patterns (${policy.patterns.length}):`);
  for (const { pattern, source } of policy.patterns) {
    lines.push(`  ${source.padEnd(18)} ${pattern}`);
  }
  if (sampleMatches.length > 0) {
    lines.push('');
    lines.push('sample matches (paths in project that this policy currently excludes):');
    for (const f of sampleMatches.slice(0, 10)) {
      lines.push(`  ${f}`);
    }
  }
  return lines.join('\n');
}

function formatStructure(definitions, file) {
  if (!definitions || definitions.length === 0) {
    return `(no definitions in ${file})`;
  }
  const lines = [`Structure of ${file}:`];
  for (const def of definitions) {
    const loc = def.line != null ? `:${def.line}` : '';
    lines.push(`  ${def.type}  ${def.name}${loc}`);
  }
  return lines.join('\n');
}

function formatSchema(nodes) {
  if (!nodes || nodes.length === 0) return '(no schema nodes found)';
  const lines = ['Schema:'];
  for (const n of nodes) {
    if (n.type === 'table') {
      lines.push(`  TABLE ${n.name}  (${n.project}/${n.file}:${n.line})`);
    } else if (n.type === 'column') {
      lines.push(`    ${n.name}`);
    }
  }
  return lines.join('\n');
}

function formatReorient(entries, project) {
  if (!entries || entries.length === 0) {
    return `(no recent sessions for "${project}")`;
  }
  const lines = [`Recent sessions for ${project}:\n`];
  for (const entry of entries) {
    const shortId = entry.session_id ? entry.session_id.substring(0, 8) : '?';
    const date = entry.date || 'unknown';
    let dateStr = date;
    try {
      const d = new Date(date + 'T00:00:00Z');
      dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } catch { /* keep raw date */ }

    const decisions = (entry.decisions || []).join(', ');
    const rawFiles = entry.files || [];
    const basenameCounts = new Map();
    for (const f of rawFiles) {
      const b = f.split('/').pop();
      basenameCounts.set(b, (basenameCounts.get(b) || 0) + 1);
    }
    const files = rawFiles.map(f => {
      const parts = f.split('/');
      const base = parts[parts.length - 1];
      if (basenameCounts.get(base) > 1 && parts.length >= 2) {
        return parts[parts.length - 2] + '/' + base;
      }
      return base;
    });

    lines.push(`  ${dateStr} [${shortId}] — ${decisions || '(no decisions recorded)'}`);
    if (files.length > 0) {
      lines.push(`    Files: ${files.join(', ')}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function formatRecent(entries) {
  if (!entries || entries.length === 0) return '(no recent sessions)';
  const lines = ['Recent sessions:\n'];
  for (const entry of entries) {
    const shortId = entry.session_id ? entry.session_id.substring(0, 8) : '?';
    const date = entry.date || 'unknown';
    let dateStr = date;
    try {
      const d = new Date(date + 'T00:00:00Z');
      dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } catch { /* keep raw date */ }
    let timeStr = '';
    if (entry.start_time) {
      const m = entry.start_time.match(/T(\d{2}:\d{2})/);
      if (m) timeStr = ' ' + m[1];
    }
    const projectsStr = (entry.projects && entry.projects.length > 0)
      ? entry.projects.join(', ')
      : '(no projects touched)';
    const decisionsStr = (entry.decisions || []).join(', ');

    lines.push(`  ${dateStr}${timeStr} [${shortId}]  ${projectsStr}`);
    if (decisionsStr) lines.push(`    Terms: ${decisionsStr}`);

    if (entry.files && entry.files.length > 0) {
      const multiProject = new Set(entry.files.map(f => f.project)).size > 1;
      const fileStrs = entry.files.map(f => {
        const base = f.path.split('/').pop();
        return multiProject ? `${f.project}/${base}` : base;
      });
      lines.push(`    Files: ${fileStrs.join(', ')}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function formatReorientList(contexts) {
  if (!contexts || contexts.length === 0) return '(no project context available)';
  const lines = ['Projects with session context:\n'];
  for (const c of contexts) {
    const dateStr = c.lastDate || 'unknown';
    lines.push(`  ${c.project}  (${c.sessionCount} sessions, last: ${dateStr})`);
  }
  return lines.join('\n');
}

function renderLabels({ db, file, project, includeStale }) {
  const where = project
    ? 'WHERE file = ? AND project = ?'
    : 'WHERE file = ?';
  const params = project ? [file, project] : [file];
  const nodes = db.db.prepare(`
    SELECT id, name, line FROM nodes ${where} ORDER BY line ASC
  `).all(...params);

  if (nodes.length === 0) return `${file} — no labels\n`;

  const lines = [`${file}`];
  let any = false;
  for (const node of nodes) {
    const labels = db.getLabels(node.id, { multi: true, all: includeStale });
    if (labels.length === 0) continue;
    any = true;
    for (const l of labels) {
      const desc = l.descriptors_json ? `[${JSON.parse(l.descriptors_json).join(', ')}]` : '';
      const stale = l.is_stale ? ' [stale]' : '';
      lines.push(`  L${String(node.line).padEnd(4)} ${node.name.padEnd(28)} ${l.category.padEnd(20)} ${desc}${stale}`);
    }
  }
  if (!any) return `${file} — no labels\n`;
  return lines.join('\n') + '\n';
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function flag(args, name) {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

function positional(args, command) {
  // Return first arg after command that doesn't start with '--'
  const idx = args.indexOf(command);
  if (idx === -1 || idx + 1 >= args.length) return null;
  const next = args[idx + 1];
  return next && !next.startsWith('--') ? next : null;
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const dbPath = flag(args, '--db') || DEFAULT_DB;
  const projectFlag = flag(args, '--project');

  if (!command) {
    process.stderr.write('Usage: query.js <--map|--find|--blast-radius|--flow|--trace|--structure|--schema|--labels|--list-projects|--resolve|--reorient|--recent|--exclusions> [args]\n');
    process.stderr.write('Common flags: --project <name>  --db <path to graph.db>  --memory-db <path to memory.db> (for --resolve)\n');
    process.exit(1);
  }

  // --resolve uses memory.db (aliases table), not graph.db
  if (command === '--resolve') {
    const alias = positional(args, '--resolve');
    if (!alias) { process.stderr.write('--resolve requires an alias\n'); process.exit(1); }
    const memDbPath = flag(args, '--memory-db') || DEFAULT_MEMORY_DB;
    let memDb;
    try {
      memDb = new MemoryDB(memDbPath);
    } catch (err) {
      process.stderr.write(`Could not open memory.db: ${err.message}\n`);
      process.exit(1);
    }
    try {
      const queries = new MemoryQueries(memDb);
      const matches = queries.resolveAliases(alias, projectFlag);
      if (matches.length === 0) {
        process.stdout.write(`(no match for "${alias}")\n`);
      } else {
        for (const m of matches) {
          process.stdout.write(`${m.alias}\t${m.project}\t${m.file || 'NULL'}\n`);
        }
      }
    } finally {
      memDb.close();
    }
    return;
  }

  // --body and --section don't need the DB
  if (command === '--body') {
    const file = args[1];
    const name = args[2];
    if (!file || !name) { process.stderr.write('--body requires <file> <name>\n'); process.exit(1); }
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    // Escape regex metacharacters in user-supplied identifier
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const declRe = new RegExp([
      `function\\s+${escaped}\\b`,
      `(?:const|let|var)\\s+${escaped}\\s*=`,
      `^\\s*class\\s+${escaped}\\b`,
      `^\\s*(?:async\\s+|static\\s+|get\\s+|set\\s+)*${escaped}\\s*\\([^)]*\\)\\s*\\{`,
      `^\\s*${escaped}\\s*:\\s*(?:async\\s+)?(?:function\\b|\\([^)]*\\)\\s*=>)`,
      `^\\s*(?:module\\.)?exports\\.${escaped}\\s*=`,
    ].join('|'));
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
      if (declRe.test(lines[i])) { start = i; break; }
    }
    if (start === -1) {
      process.stdout.write(`(${name} not found in ${file})\n`);
    } else {
      let depth = 0, end = lines.length - 1;
      for (let i = start; i < lines.length; i++) {
        depth += (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length;
        if (i > start && depth <= 0) { end = i; break; }
      }
      process.stdout.write(lines.slice(start, end + 1).join('\n') + '\n');
    }
    return;
  }

  if (command === '--section') {
    const file = args[1];
    const section = args[2];
    if (!file || !section) { process.stderr.write('--section requires <file> <section>\n'); process.exit(1); }
    const content = fs.readFileSync(file, 'utf8');
    if (section === 'template') {
      const stripped = content
        .replace(/<script[\s\S]*?<\/script>/g, '')
        .replace(/<style[\s\S]*?<\/style>/g, '');
      process.stdout.write(stripped.trim() + '\n');
      return;
    }
    const patterns = {
      script: { start: /<script[^>]*>/, end: /<\/script>/ },
      style:  { start: /<style[^>]*>/,  end: /<\/style>/ },
    };
    const p = patterns[section];
    if (!p) { process.stderr.write(`Unknown section: ${section}\n`); process.exit(1); }
    const lines = content.split('\n');
    let inSection = false, startIdx = -1, endIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (!inSection && p.start.test(lines[i])) { inSection = true; startIdx = i; }
      else if (inSection && p.end.test(lines[i])) { endIdx = i; break; }
    }
    if (startIdx === -1) {
      process.stdout.write(`(no ${section} section found)\n`);
    } else {
      let slice = lines.slice(startIdx, endIdx + 1);
      const range = args[3];
      if (range) {
        const [a, b] = range.split('-').map(Number);
        slice = slice.slice((a || 1) - 1, b || slice.length);
      }
      process.stdout.write(slice.join('\n') + '\n');
    }
    return;
  }

  const db = new GraphDB(dbPath);
  const queries = new GraphQueries(db);

  try {
    if (command === '--map') {
      const project = positional(args, '--map') || projectFlag;
      if (!project) {
        const projects = queries.listProjects();
        if (projects.length === 1) {
          const map = queries.getProjectMap(projects[0]);
          process.stdout.write(formatMap(map, projects[0]) + '\n');
        } else {
          process.stdout.write('Projects:\n' + projects.map(p => '  ' + p).join('\n') + '\n');
        }
      } else {
        const map = queries.getProjectMap(project);
        process.stdout.write(formatMap(map, project) + '\n');
      }

    } else if (command === '--find') {
      const name = positional(args, '--find');
      if (!name) { process.stderr.write('--find requires an identifier\n'); process.exit(1); }
      const results = queries.findNodes(name, projectFlag);
      process.stdout.write(formatFind(results) + '\n');

    } else if (command === '--blast-radius') {
      const file = positional(args, '--blast-radius');
      if (!file) { process.stderr.write('--blast-radius requires a file path\n'); process.exit(1); }
      const project = projectFlag || queries.listProjects()[0];
      const radius = queries.getBlastRadius(project, file);
      // Stale-graph detection: if file has zero nodes in graph but exists on
      // disk (e.g., written this session, not yet re-scanned), say so explicitly
      // — empty `radius` would otherwise format as "nothing depends on", which
      // is indistinguishable from genuine no-consumers case.
      const inGraph = queries.getFileNodes(project, file).length > 0;
      let onDisk = false;
      try { require('fs').accessSync(file); onDisk = true; } catch { /* fall through */ }
      const projectRoot = db.getProjectRoot(project) || null;
      // Reverse-edge trust check: an empty radius on an in-graph file means
      // either genuinely nothing depends on it, OR its importers were never
      // two-pass-resolved against it (file created/edited this session, no full
      // scan since). Distinguish via the watermark: if the file's newest node
      // is more recent than — or exists without — the last whole-project scan,
      // treat the empty result as possibly incomplete, not authoritative.
      const scanState = db.getScanState(project);
      const lastFullScanAt = scanState && scanState.last_full_scan_at;
      const nodeTime = inGraph ? db.getFileNewestNodeTime(project, file) : null;
      const reverseMaybeStale = inGraph && nodeTime != null
        && (!lastFullScanAt || nodeTime > lastFullScanAt);
      process.stdout.write(
        formatBlastRadius(radius, file, { inGraph, onDisk, projectRoot, reverseMaybeStale }) + '\n'
      );

    } else if (command === '--flow') {
      const file = positional(args, '--flow');
      if (!file) { process.stderr.write('--flow requires a file path\n'); process.exit(1); }
      const project = projectFlag || queries.listProjects()[0];
      const flow = queries.getFileFlow(project, file);
      process.stdout.write(formatFlow(flow, file) + '\n');

    } else if (command === '--trace') {
      const name = positional(args, '--trace');
      if (!name) { process.stderr.write('--trace requires an identifier\n'); process.exit(1); }
      const trace = queries.traceIdentifier(name, projectFlag);
      process.stdout.write(formatTrace(trace, name) + '\n');

    } else if (command === '--structure') {
      const file = positional(args, '--structure');
      if (!file) { process.stderr.write('--structure requires a file path\n'); process.exit(1); }
      const project = projectFlag || queries.listProjects()[0];
      const structure = queries.getStructure(project, file);
      process.stdout.write(formatStructure(structure, file) + '\n');

    } else if (command === '--schema') {
      const schema = queries.getSchema(projectFlag);
      process.stdout.write(formatSchema(schema) + '\n');

    } else if (command === '--list-projects') {
      const projects = queries.listProjectsWithRoots();
      const nameWidth = projects.reduce((w, p) => Math.max(w, p.name.length), 0);
      const lines = projects.map(p => {
        const root = p.root_path || '(not recorded — rescan to register root)';
        return p.name.padEnd(nameWidth) + '  →  ' + root;
      });
      process.stdout.write(lines.join('\n') + '\n');

    } else if (command === '--reorient') {
      const project = positional(args, '--reorient') || projectFlag;
      if (project) {
        const entries = getProjectContext(dbPath, project);
        process.stdout.write(formatReorient(entries, project) + '\n');
      } else {
        const contexts = listProjectContexts(dbPath);
        process.stdout.write(formatReorientList(contexts) + '\n');
      }

    } else if (command === '--recent') {
      const n = parseInt(positional(args, '--recent') || '2', 10) || 2;
      const memDbPath = flag(args, '--memory-db') || DEFAULT_MEMORY_DB;
      const entries = getRecentSessions(memDbPath, dbPath, n);
      process.stdout.write(formatRecent(entries) + '\n');

    } else if (command === '--labels') {
      const file = positional(args, '--labels');
      if (!file) { process.stderr.write('--labels requires a file path\n'); process.exit(1); }
      const includeStale = args.includes('--all');
      process.stdout.write(renderLabels({ db, file, project: projectFlag, includeStale }));

    } else if (command === '--exclusions') {
      const project = positional(args, '--exclusions') || projectFlag;
      if (!project) { process.stderr.write('--exclusions requires a project name\n'); process.exit(1); }
      const root = db.getProjectRoot(project);
      if (!root) {
        process.stderr.write(`No root recorded for project "${project}". Rescan to register root.\n`);
        process.exit(1);
      }
      const { loadConfig } = require('../lib/config');
      const { loadPolicy: _loadPolicy, isExcluded: _isExcluded } = require('../lib/exclusion');
      let cfg;
      try { cfg = loadConfig(); } catch { cfg = {}; }
      const pol = _loadPolicy(root, cfg);
      const fileRows = db.db.prepare('SELECT file FROM file_hashes WHERE project = ?').all(project);
      const excluded = fileRows
        .map(r => r.file)
        .filter(f => _isExcluded(path.join(root, f), pol));
      process.stdout.write(formatExclusions(pol, project, excluded) + '\n');

    } else {
      process.stderr.write(`Unknown command: ${command}\n`);
      process.exit(1);
    }
  } finally {
    db.close();
  }
}

if (require.main === module) main();

module.exports = { formatMap, formatFind, formatBlastRadius, formatStructure, formatFlow, formatTrace, formatSchema, formatReorient, formatReorientList, formatRecent, renderLabels, formatExclusions };
