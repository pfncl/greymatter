'use strict';
require('../lib/resolve-deps');

// Pattern classifier — categorize files by which variant of a pattern they use.
// Discovers projects from graph.db instead of DIR files.
//
// Usage:
//   node greymatter/scripts/classify.js <config-file> [--project name] [--context N]
//   node greymatter/scripts/classify.js --inline "label1=pattern1" "label2=pattern2" [--project name]

const fs = require('fs');
const path = require('path');
const os = require('os');
const { GraphDB } = require('../lib/graph-db');

const DEFAULT_DB = path.join(os.homedir(), '.claude', 'greymatter', 'graph.db');

const args = process.argv.slice(2);

function flag(name) {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

function hasFlag(name) {
  return args.includes(name);
}

const projectFilter = flag('--project');
const contextLines = parseInt(flag('--context') || flag('-C') || '1', 10);
const isInline = hasFlag('--inline');
const dbPath = flag('--db') || DEFAULT_DB;
const workspace = flag('--workspace') || process.env.CLAUDE_WORKSPACE || process.cwd();

// Parse classify config — either from file or inline args
let classifyConfig;

if (isInline) {
  const inlineIdx = args.indexOf('--inline');
  const variants = {};
  for (let i = inlineIdx + 1; i < args.length; i++) {
    if (args[i].startsWith('--')) break;
    const eq = args[i].indexOf('=');
    if (eq === -1) {
      console.error('Inline variant must be label=pattern: ' + args[i]);
      process.exit(1);
    }
    variants[args[i].slice(0, eq)] = args[i].slice(eq + 1);
  }
  if (Object.keys(variants).length === 0) {
    console.error('No variants provided. Use: --inline "label1=pattern1" "label2=pattern2"');
    process.exit(1);
  }
  classifyConfig = { name: 'Inline classification', variants, exclude: [] };
} else {
  const configFile = args.find(a => !a.startsWith('--'));
  if (!configFile) {
    console.log(`Usage:
  node greymatter/scripts/classify.js <config.json> [--project name] [--context N]
  node greymatter/scripts/classify.js --inline "label=pattern" ... [--project name]

Config file format:
  {
    "name": "Description",
    "variants": {
      "label1": "regex1",
      "label2": "regex2"
    },
    "exclude": ["tests/", "docs/"]
  }

Options:
  --project <name>    Filter to one project
  --context N, -C N   Lines of context per match (default: 1)
  --no-snippets       Summary only, no code snippets
  --db <path>         Path to graph.db (default: ~/.claude/greymatter/graph.db)
  --workspace <path>  Workspace root (default: CLAUDE_WORKSPACE or cwd)`);
    process.exit(1);
  }

  try {
    classifyConfig = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
  } catch (err) {
    console.error('Failed to read config: ' + err.message);
    process.exit(1);
  }
}

const showSnippets = !hasFlag('--no-snippets');
const excludePatterns = (classifyConfig.exclude || []).map(p => new RegExp(p));

const variants = {};
for (const [label, pat] of Object.entries(classifyConfig.variants)) {
  try {
    variants[label] = new RegExp(pat);
  } catch (err) {
    console.error('Invalid regex for "' + label + '": ' + err.message);
    process.exit(1);
  }
}

const { collectFiles } = require('../lib/file-walker');

const DIRECTION_PATTERNS = {
  client: [
    /\bfetch\s*\(/, /\.get\s*\(/, /\.post\s*\(/, /\.put\s*\(/, /\.patch\s*\(/, /\.delete\s*\(/,
    /XMLHttpRequest/, /\$\.ajax/, /\$\.get/, /\$\.post/,
    /\bimport\s*\(/, /window\.location/, /location\.href/,
    /\.href\s*=/, /\.src\s*=/,
  ],
  server: [
    /\bapp\.(get|post|put|patch|delete|use)\s*\(/, /\brouter\.(get|post|put|patch|delete|use)\s*\(/,
    /\bres\.redirect/, /\bres\.json/, /\bres\.send/, /\bres\.status/,
    /\.prepare\s*\(/, /\.exec\s*\(/,
  ],
  config: [
    /apiBase\s*[:=]/, /baseUrl\s*[:=]/, /baseURL\s*[:=]/, /endpoint\s*[:=]/,
    /href\s*=\s*["']/, /src\s*=\s*["']/, /action\s*=\s*["']/,
    /const\s+\w*[Uu][Rr][Ll]\s*=/, /var\s+\w*[Uu][Rr][Ll]\s*=/, /let\s+\w*[Uu][Rr][Ll]\s*=/,
    /var\s+API\s*=/, /const\s+API\s*=/, /let\s+API\s*=/,
    /https?:\/\//, /ics:\s*['"]/, /url:\s*['"]/, /apiBase\s*:/,
  ],
  reference: [
    /^\s*\/\//, /^\s*\/?\*/, /^\s*#/, /^\s*<!--/,
    /\.test\s*\(/, /\.get\s*\(\s*['"]\//, /supertest/,
    /assert/, /expect\s*\(/, /describe\s*\(/, /it\s*\(/,
    /console\.log\s*\(.*`/, /process\.exit/,
  ],
};

function detectDirection(lines, matchIdx, ctx) {
  const start = Math.max(0, matchIdx - ctx);
  const end = Math.min(lines.length - 1, matchIdx + ctx);
  const windowLines = [];
  for (let j = start; j <= end; j++) windowLines.push(lines[j]);
  const matchLine = lines[matchIdx];

  if (DIRECTION_PATTERNS.reference.some(p => p.test(matchLine))) return 'reference';
  if (DIRECTION_PATTERNS.client.some(p => p.test(matchLine))) return 'client';
  if (windowLines.some(l => DIRECTION_PATTERNS.client.some(p => p.test(l)))) return 'client';
  if (DIRECTION_PATTERNS.server.some(p => p.test(matchLine))) return 'server';
  if (windowLines.some(l => DIRECTION_PATTERNS.server.some(p => p.test(l)))) return 'server';
  if (DIRECTION_PATTERNS.config.some(p => p.test(matchLine))) return 'config';
  return 'unknown';
}

function classifyFile(filePath, ctx) {
  let content;
  try { content = fs.readFileSync(filePath, 'utf-8'); }
  catch { return []; }
  if (content.includes('\0')) return [];

  const lines = content.split('\n');
  const hits = [];

  for (let i = 0; i < lines.length; i++) {
    for (const [label, regex] of Object.entries(variants)) {
      if (regex.test(lines[i])) {
        const start = Math.max(0, i - ctx);
        const end = Math.min(lines.length - 1, i + ctx);
        const contextSnippet = [];
        for (let j = start; j <= end; j++) {
          const marker = j === i ? '>' : ' ';
          contextSnippet.push(marker + ' ' + String(j + 1).padStart(4) + '  ' + lines[j]);
        }

        const direction = detectDirection(lines, i, 2);
        hits.push({ variant: label, direction, lineNum: i + 1, context: contextSnippet.join('\n') });
      }
    }
  }

  return hits;
}

// Load project names from graph.db
function loadProjects(dbPath) {
  try { fs.accessSync(dbPath); } catch { return []; }
  const db = new GraphDB(dbPath);
  try {
    const rows = db.db.prepare('SELECT DISTINCT project FROM nodes ORDER BY project').all();
    return rows.map(r => r.project);
  } finally {
    db.close();
  }
}

// Main
const projectNames = loadProjects(dbPath);
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

const byVariant = {};
for (const label of Object.keys(variants)) {
  byVariant[label] = [];
}

let filesScanned = 0;

for (const projectName of filteredProjects) {
  const projectRoot = path.join(workspace, projectName);
  if (!fs.existsSync(projectRoot)) continue;

  const files = collectFiles(projectRoot);

  for (const filePath of files) {
    const relPath = path.relative(projectRoot, filePath);
    if (excludePatterns.some(p => p.test(relPath))) continue;

    filesScanned++;
    const hits = classifyFile(filePath, contextLines);
    if (hits.length === 0) continue;

    const fileByVariant = {};
    for (const hit of hits) {
      if (!fileByVariant[hit.variant]) fileByVariant[hit.variant] = [];
      fileByVariant[hit.variant].push(hit);
    }

    for (const [label, fileHits] of Object.entries(fileByVariant)) {
      byVariant[label].push({ project: projectName, file: relPath, hits: fileHits });
    }
  }
}

// Print results
console.log('━━ ' + (classifyConfig.name || 'Classification') + ' ━━');
console.log(filesScanned + ' files scanned across ' + filteredProjects.length + ' projects\n');

let totalFiles = 0;
let totalHits = 0;

for (const [label, entries] of Object.entries(byVariant)) {
  const hitCount = entries.reduce((s, e) => s + e.hits.length, 0);
  const fileCount = entries.length;
  totalFiles += fileCount;
  totalHits += hitCount;

  const bar = hitCount === 0 ? '  ' : '██';
  console.log(bar + ' ' + label + ' — ' + hitCount + ' hits in ' + fileCount + ' files');

  if (showSnippets && entries.length > 0) {
    const byProject = {};
    for (const entry of entries) {
      if (!byProject[entry.project]) byProject[entry.project] = [];
      byProject[entry.project].push(entry);
    }

    for (const [projName, projEntries] of Object.entries(byProject)) {
      console.log('   ' + projName + '/');
      for (const entry of projEntries) {
        for (const hit of entry.hits) {
          const dirTag = hit.direction ? ' [' + hit.direction + ']' : '';
          console.log('     ' + entry.file + ':' + hit.lineNum + dirTag);
          for (const line of hit.context.split('\n')) {
            console.log('     │' + line);
          }
        }
      }
    }
  }
  console.log('');
}

console.log('─── Summary ───');
for (const [label, entries] of Object.entries(byVariant)) {
  const hitCount = entries.reduce((s, e) => s + e.hits.length, 0);
  const pct = totalHits > 0 ? Math.round((hitCount / totalHits) * 100) : 0;
  const barLen = Math.max(1, Math.round(pct / 2));
  const bar = '█'.repeat(barLen);
  console.log('  ' + bar + ' ' + pct + '% ' + label + ' (' + hitCount + ')');
}
console.log('  ' + totalHits + ' total hits in ' + totalFiles + ' files');

const allHits = [];
for (const entries of Object.values(byVariant)) {
  for (const entry of entries) {
    for (const hit of entry.hits) allHits.push(hit);
  }
}
const dirCounts = {};
for (const hit of allHits) {
  dirCounts[hit.direction] = (dirCounts[hit.direction] || 0) + 1;
}
if (Object.keys(dirCounts).length > 0) {
  console.log('\n─── By Direction ───');
  const dirLabels = {
    client: '→ client (outgoing)', server: '← server (route/handler)',
    config: '⚙ config (URL definition)', reference: '📎 reference (comment/test)', unknown: '? unknown',
  };
  for (const [dir, count] of Object.entries(dirCounts).sort((a, b) => b[1] - a[1])) {
    const pct = Math.round((count / allHits.length) * 100);
    console.log('  ' + (dirLabels[dir] || dir) + ': ' + count + ' (' + pct + '%)');
  }
}
