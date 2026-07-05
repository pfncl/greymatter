'use strict';

const path = require('path');

const USED_EDGE_TYPES = [
  { name: 'imports', category: 'structural', followsForBlastRadius: true, impliesStaleness: false, description: 'ES module import from script block' },
  { name: 'exports', category: 'structural', followsForBlastRadius: false, impliesStaleness: false, description: 'Exported prop (export let)' },
  { name: 'dispatches', category: 'data_flow', followsForBlastRadius: false, impliesStaleness: false, description: 'Component event dispatch' },
];

// Extract the <script> block content and its starting line offset.
function extractScriptBlock(content) {
  // Handles <script>, <script lang="ts">, <script context="module">, etc.
  const scriptStart = content.search(/<script[\s>]/i);
  if (scriptStart === -1) return { script: '', lineOffset: 0 };

  const tagEnd = content.indexOf('>', scriptStart);
  if (tagEnd === -1) return { script: '', lineOffset: 0 };

  const bodyStart = tagEnd + 1;
  const closeTag = content.indexOf('</script>', bodyStart);
  if (closeTag === -1) return { script: '', lineOffset: 0 };

  const scriptContent = content.slice(bodyStart, closeTag);
  // Line offset: count newlines before bodyStart
  const lineOffset = content.slice(0, bodyStart).split('\n').length - 1;

  return { script: scriptContent, lineOffset };
}

function extract(content, filePath, project) {
  const nodes = [];
  const edges = [];
  const seenImports = new Set();

  const componentName = path.basename(filePath, '.svelte');

  // Component-level node
  nodes.push({ project, file: filePath, name: componentName, type: 'component', line: 1 });

  const { script, lineOffset } = extractScriptBlock(content);

  if (script) {
    const scriptLines = script.split('\n');

    for (let i = 0; i < scriptLines.length; i++) {
      const line = scriptLines[i];
      const trimmed = line.trim();
      const lineNum = lineOffset + i + 1;

      // ── Imports ────────────────────────────────────────────────────────────
      // Skip: import type { ... } from '...' (TS-style type-only imports)
      if (/^import\s+type\s+/.test(trimmed)) continue;

      const importMatch = trimmed.match(/^import\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"]/);
      if (importMatch) {
        const mod = importMatch[1];
        // Relative/absolute imports and path aliases ($lib, @/, ~/) become edges;
        // npm packages and SvelteKit virtuals ($app/, $env/) are skipped
        if ((mod.startsWith('.') || mod.startsWith('/') || mod === '$lib' || mod.startsWith('$lib/') || mod.startsWith('@/') || mod.startsWith('~/')) && !seenImports.has(mod)) {
          seenImports.add(mod);
          edges.push({
            type: 'imports', category: 'structural',
            source: componentName, target: mod,
            sourceProject: project, sourceFile: filePath,
          });
        }
        continue;
      }

      // ── Exported props (export let <name>) ────────────────────────────────
      const propMatch = trimmed.match(/^export\s+let\s+(\w+)/);
      if (propMatch) {
        nodes.push({ project, file: filePath, name: propMatch[1], type: 'prop', line: lineNum });
        edges.push({
          type: 'exports', category: 'structural',
          source: componentName, target: propMatch[1],
          sourceProject: project, sourceFile: filePath,
        });
        continue;
      }

      // ── Svelte 5 exported props ($props rune) ─────────────────────────────
      // let { title, count } = $props();
      const runePropsMatch = trimmed.match(/^(?:const|let)\s*\{([^}]+)\}\s*=\s*\$props\(\)/);
      if (runePropsMatch) {
        const propNames = runePropsMatch[1].split(',').map(p => {
          const name = p.trim().split('=')[0].trim();
          return name.startsWith('...') ? null : name;
        }).filter(Boolean);
        for (const propName of propNames) {
          nodes.push({ project, file: filePath, name: propName, type: 'prop', line: lineNum });
          edges.push({
            type: 'exports', category: 'structural',
            source: componentName, target: propName,
            sourceProject: project, sourceFile: filePath,
          });
        }
        continue;
      }

      // ── Event dispatcher calls: dispatch('event-name', ...) ───────────────
      // Match dispatch calls anywhere in the line
      const dispatchPattern = /\bdispatch\(\s*['"]([^'"]+)['"]/g;
      let m;
      while ((m = dispatchPattern.exec(line)) !== null) {
        edges.push({
          type: 'dispatches', category: 'data_flow',
          source: componentName, target: m[1],
          sourceProject: project, sourceFile: filePath,
        });
      }
    }
  }

  // ── <slot> tags in template ────────────────────────────────────────────────
  const slotPattern = /<slot(?:\s+name="([^"]+)")?[\s/>]/gi;
  let slotMatch;
  while ((slotMatch = slotPattern.exec(content)) !== null) {
    const slotName = slotMatch[1] || 'default';
    // Only add each slot name once
    if (!nodes.some(n => n.type === 'slot' && n.name === slotName)) {
      // Compute line number for the slot tag
      const slotLine = content.slice(0, slotMatch.index).split('\n').length;
      nodes.push({ project, file: filePath, name: slotName, type: 'slot', line: slotLine });
    }
  }

  return { nodes, edges, edge_types: USED_EDGE_TYPES };
}

// Svelte components are rarely test files themselves — tests live in sibling
// .test.ts / .test.js files that import the component. candidateTestPaths
// therefore crosses extensions: given Foo.svelte it returns Foo.test.ts etc.
const testPairs = {
  isTestFile(relPath) {
    return /\.test\.svelte$|\.spec\.svelte$/.test(relPath)
      || /(^|\/)(test|tests|__tests__|spec)\//.test(relPath);
  },

  candidateTestPaths(sourceRelPath) {
    const dir = path.dirname(sourceRelPath);
    const name = path.basename(sourceRelPath, '.svelte');
    const testExtensions = ['.test.ts', '.spec.ts', '.test.js', '.spec.js'];
    const parent = dir === '.' ? '' : path.basename(dir);
    const candidates = [];
    for (const ext of testExtensions) {
      candidates.push(path.join(dir, `${name}${ext}`));
      candidates.push(path.join(dir, '__tests__', `${name}${ext}`));
      candidates.push(path.join('test', `${name}${ext}`));
      candidates.push(path.join('tests', `${name}${ext}`));
      // Flattened-parent convention: routes/foo/Bar.svelte -> test/foo-Bar.test.ts
      if (parent) {
        candidates.push(path.join('test', `${parent}-${name}${ext}`));
        candidates.push(path.join('tests', `${parent}-${name}${ext}`));
      }
    }
    return candidates;
  },

  parseAnnotations(content) {
    const header = content.split('\n').slice(0, 20).join('\n');
    const matches = [...header.matchAll(/\/\/[ \t]*@tests[ \t]+(\S+)/g)];
    return matches.map(m => m[1]);
  },
};

function extractBody(content, node) {
  if (!node || typeof node.line !== 'number') return null;
  const { script, lineOffset } = extractScriptBlock(content);
  if (!script) return null;
  const scriptLineIdx = node.line - lineOffset - 1;
  const scriptLines = script.split('\n');
  if (scriptLineIdx < 0 || scriptLineIdx >= scriptLines.length) return null;

  let depth = 0;
  let foundOpen = false;
  let endIdx = scriptLineIdx;
  for (let i = scriptLineIdx; i < scriptLines.length; i++) {
    const line = scriptLines[i];
    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;
    depth += opens - closes;
    if (opens > 0) foundOpen = true;
    if (foundOpen && depth <= 0) { endIdx = i; break; }
  }
  if (!foundOpen) return scriptLines[scriptLineIdx];
  return scriptLines.slice(scriptLineIdx, endIdx + 1).join('\n');
}

const labelDetectors = [
  {
    id: 'svelte-load',
    category: 'data-access',
    defaultTerm: 'load function',
    detect: (node, ctx) => {
      if (!node.name || node.name !== 'load') return null;
      if (!ctx?.filePath) return null;
      if (!/\+(page|layout)(\.server)?\.(js|ts)$/.test(ctx.filePath)) return null;
      return { confidence: 0.95, descriptors: ['sveltekit'] };
    },
  },
  {
    id: 'svelte-server-endpoint',
    category: 'route-handler',
    defaultTerm: 'server endpoint',
    detect: (node, ctx) => {
      if (!node.name) return null;
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(node.name)) return null;
      if (!ctx?.filePath?.endsWith('+server.js') && !ctx?.filePath?.endsWith('+server.ts')) return null;
      return { confidence: 0.95, descriptors: ['sveltekit', node.name.toLowerCase()] };
    },
  },
];

module.exports = { extensions: ['.svelte'], extract, testPairs, labelDetectors, extractBody };
