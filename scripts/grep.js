'use strict';
require('../lib/resolve-deps');

// Project-aware grep — searches all files in known project directories.
// Discovers projects from graph.db instead of DIR files.
// Returns matches with surrounding context, grouped by project.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { GraphDB } = require('../lib/graph-db');
const { UnknownProjectError } = require('../lib/mcp/errors');
const { isExcluded } = require('../lib/exclusion');

const DEFAULT_DB = path.join(os.homedir(), '.claude', 'greymatter', 'graph.db');

// Searches a single file for regex matches. Returns structured match objects.
function searchFile(filePath, regex, ctx, maxPerFile) {
  let content;
  try { content = fs.readFileSync(filePath, 'utf-8'); }
  catch { return []; }
  if (content.includes('\0')) return [];

  const lines = content.split('\n');
  const matches = [];
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      if (matches.length >= maxPerFile) break;
      const start = Math.max(0, i - ctx);
      const end = Math.min(lines.length - 1, i + ctx);
      matches.push({
        line: i + 1,
        before: lines.slice(start, i),
        match: lines[i],
        after: lines.slice(i + 1, end + 1),
      });
    }
  }
  return matches;
}

/**
 * Search greymatter's scanned file set for a project.
 * Uses project_scan_state (root_path) and file_hashes to resolve the file set —
 * no filesystem globbing.
 *
 * @param {import('../lib/graph-db').GraphDB} graphDb
 * @param {string} project
 * @param {string} pattern - regex pattern string
 * @param {object} [options]
 * @param {number} [options.context=3] - lines of context on each side
 * @param {number} [options.maxPerFile=20] - max matches per file
 * @param {string} [options.rootPath] - override project root (skips DB lookup)
 * @param {object} [options.policy] - exclusion policy; excluded files are skipped
 * @returns {Array<{ file: string, matches: Array<{ line, before, match, after }> }>}
 */
function grepProject(graphDb, project, pattern, options = {}) {
  const { context = 3, maxPerFile = 20, rootPath: rootPathOpt, policy } = options;

  const fileRows = graphDb.db.prepare('SELECT file FROM file_hashes WHERE project = ?').all(project);
  if (fileRows.length === 0) {
    throw new UnknownProjectError(`no scanned files found for project "${project}"`);
  }

  const root_path = rootPathOpt !== undefined ? rootPathOpt : graphDb.getProjectRoot(project);
  if (!root_path) {
    throw new UnknownProjectError(`no root_path recorded for project "${project}"`);
  }

  let regex;
  try { regex = new RegExp(pattern); }
  catch (err) { throw new Error(`Invalid regex: ${err.message}`); }

  const results = [];
  for (const { file: relFile } of fileRows) {
    const absPath = path.join(root_path, relFile);
    if (policy && isExcluded(absPath, policy)) continue;
    const matches = searchFile(absPath, regex, context, maxPerFile);
    if (matches.length > 0) results.push({ file: relFile, matches });
  }
  return results;
}

module.exports = { grepProject };

// ── CLI ───────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);

  function flag(name) {
    const idx = args.indexOf(name);
    if (idx === -1 || idx + 1 >= args.length) return null;
    return args[idx + 1];
  }

  const pattern = args.find(a => !a.startsWith('--'));
  const contextLines = parseInt(flag('--context') || flag('-C') || '3', 10);
  const projectFilter = flag('--project');
  const maxPerFile = parseInt(flag('--max-per-file') || '20', 10);
  const dbPath = flag('--db') || DEFAULT_DB;
  const workspace = flag('--workspace') || process.env.CLAUDE_WORKSPACE || process.cwd();

  if (!pattern) {
    console.log(`Usage: node greymatter/scripts/grep.js <pattern> [options]

Options:
  --context N, -C N       Lines of context around each match (default: 3)
  --project <name>        Filter to one project (substring match)
  --max-per-file N        Max matches shown per file (default: 20)
  --db <path>             Path to graph.db (default: ~/.claude/greymatter/graph.db)
  --workspace <path>      Workspace root containing project directories (default: CLAUDE_WORKSPACE or cwd)

Examples:
  node greymatter/scripts/grep.js "apiBase"
  node greymatter/scripts/grep.js "apiBase" --project myapp
  node greymatter/scripts/grep.js "fetch.*booking" --context 5`);
    process.exit(1);
  }

  let db;
  try {
    fs.accessSync(dbPath);
    db = new GraphDB(dbPath);
  } catch {
    console.error('No projects found in graph.db. Run: node greymatter/scripts/scan.js');
    process.exit(1);
  }

  try {
    const projectNames = db.db.prepare('SELECT DISTINCT project FROM nodes ORDER BY project').all().map(r => r.project);
    if (projectNames.length === 0) {
      console.error('No projects found in graph.db. Run: node greymatter/scripts/scan.js');
      process.exit(1);
    }

    const filteredProjects = projectFilter
      ? projectNames.filter(n => n.toLowerCase().includes(projectFilter.toLowerCase()))
      : projectNames;

    if (filteredProjects.length === 0) {
      console.error('No project matching "' + projectFilter + '"');
      process.exit(1);
    }

    let regex;
    try { regex = new RegExp(pattern); }
    catch (err) {
      console.error('Invalid regex: ' + err.message);
      process.exit(1);
    }

    let totalMatches = 0;
    let totalFiles = 0;
    const output = [];

    for (const projectName of filteredProjects) {
      // Resolve root: prefer recorded root_path, fall back to workspace convention
      const recordedRoot = db.getProjectRoot(projectName);
      const workspaceRoot = path.join(workspace, projectName);
      const rootPath = recordedRoot || (fs.existsSync(workspaceRoot) ? workspaceRoot : null);
      if (!rootPath) continue;

      let projectResults;
      try {
        projectResults = grepProject(db, projectName, pattern, { context: contextLines, maxPerFile, rootPath });
      } catch (err) {
        if (/UNKNOWN_PROJECT/.test(err.message)) continue;
        throw err;
      }

      if (projectResults.length === 0) continue;

      const projectMatches = projectResults.map(entry => {
        const matchCount = entry.matches.length;
        totalMatches += matchCount;
        totalFiles++;

        // Build snippet display (context window around each match)
        const snippets = entry.matches.map(m => {
          const startLine = m.line - m.before.length;
          const allLines = [...m.before, m.match, ...m.after];
          const snippet = allLines.map((line, idx) => {
            const lineNum = startLine + idx;
            const marker = lineNum === m.line ? '>' : ' ';
            return marker + ' ' + String(lineNum).padStart(4) + '  ' + line;
          }).join('\n');
          return { matchLines: [m.line], snippet };
        });

        return { file: entry.file, matchCount, snippets, truncated: false };
      });

      output.push({ project: projectName, matches: projectMatches });
    }

    if (output.length === 0) {
      console.log('No matches for /' + pattern + '/ across ' + filteredProjects.length + ' projects');
      process.exit(0);
    }

    console.log('/' + pattern + '/ — ' + totalMatches + ' matches in ' + totalFiles + ' files\n');

    for (const proj of output) {
      const fileCount = proj.matches.length;
      const matchCount = proj.matches.reduce((s, m) => s + m.matchCount, 0);
      console.log('━━ ' + proj.project + ' (' + matchCount + ' matches in ' + fileCount + ' files) ━━\n');

      for (const file of proj.matches) {
        console.log('  ' + file.file);
        for (const snippet of file.snippets) {
          console.log('  ┌─');
          for (const line of snippet.snippet.split('\n')) {
            console.log('  │' + line);
          }
          console.log('  └─');
        }
        if (file.truncated) {
          console.log('  ... (truncated, --max-per-file ' + maxPerFile + ')');
        }
        console.log('');
      }
    }
  } finally {
    db.close();
  }
}
