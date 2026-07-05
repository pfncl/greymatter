'use strict';

const path = require('path');

const USED_EDGE_TYPES = [
  { name: 'imports', category: 'structural', followsForBlastRadius: true, impliesStaleness: false, description: 'ES module import from Astro frontmatter' },
  { name: 'exports', category: 'structural', followsForBlastRadius: false, impliesStaleness: false, description: 'Exported binding from Astro frontmatter (Props interface member, getStaticPaths, prerender, partial, …)' },
  { name: 'uses_component', category: 'data_flow', followsForBlastRadius: false, impliesStaleness: false, description: 'Component usage in Astro template (<ComponentName … />)' },
];

// Extract the frontmatter block (between `---` fences at the very top of file)
// and its starting line offset. Astro requires frontmatter to begin on line 1
// — there is no leading whitespace tolerance in the canonical syntax.
function extractFrontmatter(content) {
  if (!/^---[ \t]*\r?\n/.test(content)) {
    return { frontmatter: '', lineOffset: 0, frontmatterEnd: 0 };
  }
  const lines = content.split('\n');
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^---[ \t]*\r?$/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    return { frontmatter: '', lineOffset: 0, frontmatterEnd: 0 };
  }
  return {
    frontmatter: lines.slice(1, endIdx).join('\n'),
    // Frontmatter body line 0 lives at file line 2 (line 1 is the opening `---`).
    lineOffset: 1,
    // 0-indexed line of the closing fence — template starts at frontmatterEnd+1.
    frontmatterEnd: endIdx,
  };
}

function extract(content, filePath, project) {
  const nodes = [];
  const edges = [];
  const seenImports = new Set();
  const seenComponents = new Set();
  const seenProps = new Set();

  const componentName = path.basename(filePath, '.astro');

  // File-level node so other extractors' edges can target this Astro file.
  nodes.push({ project, file: filePath, name: componentName, type: 'component', line: 1 });

  const { frontmatter, lineOffset, frontmatterEnd } = extractFrontmatter(content);

  if (frontmatter) {
    const fmLines = frontmatter.split('\n');

    let inPropsInterface = false;
    let propsInterfaceDepth = 0;

    for (let i = 0; i < fmLines.length; i++) {
      const line = fmLines[i];
      const trimmed = line.trim();
      const lineNum = lineOffset + i + 1;

      // ── Imports ────────────────────────────────────────────────────────────
      // Skip TS-style type-only imports — they don't survive to runtime, and
      // including them as blast-radius edges produces false positives on rename.
      if (/^import\s+type\s+/.test(trimmed)) continue;

      const importMatch = trimmed.match(/^import\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"]/);
      if (importMatch) {
        const mod = importMatch[1];
        // Relative/absolute imports and path aliases ($lib, @/, ~/) become edges
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

      // ── `interface Props { … }` — Astro's canonical typed-props declaration ─
      if (/^(?:export\s+)?interface\s+Props\b/.test(trimmed)) {
        inPropsInterface = true;
        const opens = (line.match(/\{/g) || []).length;
        const closes = (line.match(/\}/g) || []).length;
        propsInterfaceDepth = opens - closes;
        continue;
      }
      if (inPropsInterface) {
        const opens = (line.match(/\{/g) || []).length;
        const closes = (line.match(/\}/g) || []).length;
        // Capture top-level members BEFORE updating depth — a member line starts
        // at the depth its enclosing scope is at (1 for top-level Props), and may
        // itself open a nested type on the same line that pushes depth to 2.
        const propMatch = trimmed.match(/^(\w+)\??\s*:/);
        if (propMatch && propsInterfaceDepth === 1) {
          const propName = propMatch[1];
          if (!seenProps.has(propName)) {
            seenProps.add(propName);
            nodes.push({ project, file: filePath, name: propName, type: 'prop', line: lineNum });
            edges.push({
              type: 'exports', category: 'structural',
              source: componentName, target: propName,
              sourceProject: project, sourceFile: filePath,
            });
          }
        }
        propsInterfaceDepth += opens - closes;
        if (propsInterfaceDepth <= 0) inPropsInterface = false;
        continue;
      }

      // ── `const { name, count = 0 } = Astro.props` destructure ──────────────
      const astroPropsMatch = trimmed.match(/^(?:const|let|var)\s*\{([^}]+)\}\s*=\s*Astro\.props/);
      if (astroPropsMatch) {
        const propNames = astroPropsMatch[1].split(',').map(p => {
          // Strip rename (`foo: bar`), default (`foo = 0`), and rest (`...rest`).
          const head = p.trim().split('=')[0].trim().split(':')[0].trim();
          return head.startsWith('...') ? null : head;
        }).filter(Boolean);
        for (const propName of propNames) {
          if (!seenProps.has(propName)) {
            seenProps.add(propName);
            nodes.push({ project, file: filePath, name: propName, type: 'prop', line: lineNum });
            edges.push({
              type: 'exports', category: 'structural',
              source: componentName, target: propName,
              sourceProject: project, sourceFile: filePath,
            });
          }
        }
        continue;
      }

      // ── Exported bindings (`export const getStaticPaths`, `export const prerender`, …) ─
      const exportConstMatch = trimmed.match(/^export\s+(?:const|let|var)\s+(\w+)/);
      if (exportConstMatch) {
        const exportName = exportConstMatch[1];
        nodes.push({ project, file: filePath, name: exportName, type: 'binding', line: lineNum });
        edges.push({
          type: 'exports', category: 'structural',
          source: componentName, target: exportName,
          sourceProject: project, sourceFile: filePath,
        });
        continue;
      }
      const exportFnMatch = trimmed.match(/^export\s+(?:async\s+)?function\s+(\w+)/);
      if (exportFnMatch) {
        const fnName = exportFnMatch[1];
        nodes.push({ project, file: filePath, name: fnName, type: 'function', line: lineNum });
        edges.push({
          type: 'exports', category: 'structural',
          source: componentName, target: fnName,
          sourceProject: project, sourceFile: filePath,
        });
        continue;
      }
    }
  }

  // ── Template parsing — everything after the frontmatter closing fence ─────
  // `frontmatterEnd === 0` means no frontmatter detected → scan whole file.
  const allLines = content.split('\n');
  const templateText = allLines.slice(frontmatterEnd > 0 ? frontmatterEnd + 1 : 0).join('\n');

  // Component usage: PascalCase tag names (also handles `<Namespace.Sub>`).
  // HTML elements are lowercase by spec, so this cleanly separates the two.
  const componentPattern = /<([A-Z][A-Za-z0-9_.]*)\b/g;
  let cMatch;
  while ((cMatch = componentPattern.exec(templateText)) !== null) {
    const tagName = cMatch[1];
    if (seenComponents.has(tagName)) continue;
    seenComponents.add(tagName);
    edges.push({
      type: 'uses_component', category: 'data_flow',
      source: componentName, target: tagName,
      sourceProject: project, sourceFile: filePath,
    });
  }

  // ── `<slot>` tags in template (Astro supports named slots like Svelte) ────
  const slotPattern = /<slot(?:\s+name="([^"]+)")?[\s/>]/gi;
  let slotMatch;
  while ((slotMatch = slotPattern.exec(content)) !== null) {
    const slotName = slotMatch[1] || 'default';
    if (!nodes.some(n => n.type === 'slot' && n.name === slotName)) {
      const slotLine = content.slice(0, slotMatch.index).split('\n').length;
      nodes.push({ project, file: filePath, name: slotName, type: 'slot', line: slotLine });
    }
  }

  return { nodes, edges, edge_types: USED_EDGE_TYPES };
}

// Astro components are rarely test files themselves — tests live in sibling
// .test.ts / .test.js files that import the component. candidateTestPaths
// therefore crosses extensions, mirroring the Svelte extractor's contract.
const testPairs = {
  isTestFile(relPath) {
    return /\.test\.astro$|\.spec\.astro$/.test(relPath)
      || /(^|\/)(test|tests|__tests__|spec)\//.test(relPath);
  },

  candidateTestPaths(sourceRelPath) {
    const dir = path.dirname(sourceRelPath);
    const name = path.basename(sourceRelPath, '.astro');
    const testExtensions = ['.test.ts', '.spec.ts', '.test.js', '.spec.js'];
    const parent = dir === '.' ? '' : path.basename(dir);
    const candidates = [];
    for (const ext of testExtensions) {
      candidates.push(path.join(dir, `${name}${ext}`));
      candidates.push(path.join(dir, '__tests__', `${name}${ext}`));
      candidates.push(path.join('test', `${name}${ext}`));
      candidates.push(path.join('tests', `${name}${ext}`));
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
  const { frontmatter, lineOffset } = extractFrontmatter(content);
  if (!frontmatter) return null;
  const fmLineIdx = node.line - lineOffset - 1;
  const fmLines = frontmatter.split('\n');
  if (fmLineIdx < 0 || fmLineIdx >= fmLines.length) return null;

  let depth = 0;
  let foundOpen = false;
  let endIdx = fmLineIdx;
  for (let i = fmLineIdx; i < fmLines.length; i++) {
    const line = fmLines[i];
    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;
    depth += opens - closes;
    if (opens > 0) foundOpen = true;
    if (foundOpen && depth <= 0) { endIdx = i; break; }
  }
  if (!foundOpen) return fmLines[fmLineIdx];
  return fmLines.slice(fmLineIdx, endIdx + 1).join('\n');
}

const labelDetectors = [
  {
    id: 'astro-get-static-paths',
    category: 'route-handler',
    defaultTerm: 'static path generator',
    detect(node, ctx) {
      if (!node.name || node.name !== 'getStaticPaths') return null;
      if (!ctx?.filePath?.endsWith('.astro')) return null;
      return { confidence: 0.95, descriptors: ['astro', 'dynamic-route'] };
    },
  },
];

module.exports = { extensions: ['.astro'], extract, testPairs, labelDetectors, extractBody };
