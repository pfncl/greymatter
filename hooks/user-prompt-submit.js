#!/usr/bin/env node
'use strict';
require('../lib/resolve-deps');

// Universal IF-THEN UserPromptSubmit matcher.
//
// Reads rules from `~/.claude/greymatter/prompt-triggers.json` and, for each
// matched rule, injects the rule's message as additionalContext. Matching is
// verb+noun collocation (both terms must appear within `proximity` tokens of
// each other) so phrases like "make this into a plan" fire while "I plan to
// refactor" does not.
//
// Hook envelope (stdin JSON, per Claude Code spec):
//   { "prompt": "...", "session_id": "...", "transcript_path": "...", ... }
//
// Output (stdout JSON):
//   { "hookSpecificOutput": { "hookEventName": "UserPromptSubmit",
//                             "additionalContext": "..." } }
//
// Failures (missing rules file, parse error, etc.) write to stderr and exit 0.
// This script must never block prompt submission.
//
// Lint mode: `node user-prompt-submit.js --lint "your prompt here"` prints
// every rule that would fire, with no envelope wrapping.

const fs = require('fs');
const os = require('os');
const path = require('path');

const RULES_PATH = path.join(os.homedir(), '.claude', 'greymatter', 'prompt-triggers.json');

function tokenize(text) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter(Boolean);
}

// Collocation: any verb token within `proximity` of any noun token.
function matchCollocation(tokens, rule) {
  const verbs = new Set((rule.verbs || []).map(v => v.toLowerCase()));
  const nouns = new Set((rule.nouns || []).map(n => n.toLowerCase()));
  const proximity = Number.isFinite(rule.proximity) ? rule.proximity : 5;

  const verbPositions = [];
  const nounPositions = [];
  for (let i = 0; i < tokens.length; i++) {
    if (verbs.has(tokens[i])) verbPositions.push(i);
    if (nouns.has(tokens[i])) nounPositions.push(i);
  }
  if (verbPositions.length === 0 || nounPositions.length === 0) return false;

  for (const v of verbPositions) {
    for (const n of nounPositions) {
      if (Math.abs(v - n) <= proximity) return true;
    }
  }
  return false;
}

// Substring: any phrase appears anywhere in the prompt (case-insensitive).
function matchPhrase(promptLower, rule) {
  const phrases = (rule.phrases || []).map(p => p.toLowerCase());
  return phrases.some(p => promptLower.includes(p));
}

function ruleFires(prompt, rule) {
  const tokens = tokenize(prompt);
  const promptLower = prompt.toLowerCase();

  // Negation gate — if any negate phrase is present, suppress this rule.
  if (Array.isArray(rule.negate)) {
    for (const phrase of rule.negate) {
      if (promptLower.includes(phrase.toLowerCase())) return false;
    }
  }

  const type = (rule.match && rule.match.type) || rule.type || 'collocation';
  // Allow rule.match to nest the matcher fields, OR allow them flat on the rule.
  const matcher = rule.match || rule;

  if (type === 'collocation') return matchCollocation(tokens, matcher);
  if (type === 'phrase') return matchPhrase(promptLower, matcher);
  if (type === 'any') {
    return matchCollocation(tokens, matcher) || matchPhrase(promptLower, matcher);
  }
  return false;
}

function loadRules() {
  let raw;
  try {
    raw = fs.readFileSync(RULES_PATH, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { rules: [] };
    process.stderr.write(`prompt-triggers: cannot read ${RULES_PATH}: ${err.message}\n`);
    return { rules: [] };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.rules)) {
      process.stderr.write(`prompt-triggers: ${RULES_PATH} missing top-level "rules" array\n`);
      return { rules: [] };
    }
    return parsed;
  } catch (err) {
    process.stderr.write(`prompt-triggers: ${RULES_PATH} is not valid JSON: ${err.message}\n`);
    return { rules: [] };
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { buf += chunk; });
    process.stdin.on('end', () => resolve(buf));
    // If stdin is a TTY (no envelope), resolve empty so we exit cleanly.
    if (process.stdin.isTTY) resolve('');
  });
}

function buildContext(matched) {
  if (matched.length === 0) return '';
  const lines = ['Prompt-trigger matches:'];
  for (const m of matched) {
    lines.push(`\n• [${m.id}] ${m.message}`);
  }
  return lines.join('\n');
}

async function runHook() {
  const stdinRaw = await readStdin();
  let envelope;
  try {
    envelope = stdinRaw ? JSON.parse(stdinRaw) : {};
  } catch {
    return; // malformed envelope — exit silently, do not block
  }
  const prompt = typeof envelope.prompt === 'string' ? envelope.prompt : '';
  if (!prompt) return;

  const { rules } = loadRules();
  const matched = [];
  for (const rule of rules) {
    if (!rule || !rule.message) continue;
    try {
      if (ruleFires(prompt, rule)) {
        matched.push({ id: rule.id || '(unnamed)', message: rule.message });
      }
    } catch (err) {
      process.stderr.write(`prompt-triggers: rule ${rule.id || '(unnamed)'} threw: ${err.message}\n`);
    }
  }

  const additionalContext = buildContext(matched);
  if (!additionalContext) return;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  }));
}

function runLint(prompt) {
  const { rules } = loadRules();
  const matched = [];
  for (const rule of rules) {
    if (!rule || !rule.message) continue;
    try {
      if (ruleFires(prompt, rule)) {
        matched.push(rule.id || '(unnamed)');
      }
    } catch (err) {
      process.stderr.write(`rule ${rule.id || '(unnamed)'} threw: ${err.message}\n`);
    }
  }
  if (matched.length === 0) {
    process.stdout.write('No rules matched.\n');
  } else {
    process.stdout.write(`Matched: ${matched.join(', ')}\n`);
  }
}

const args = process.argv.slice(2);
if (args[0] === '--lint') {
  runLint(args.slice(1).join(' '));
} else {
  runHook().catch((err) => {
    process.stderr.write(`prompt-triggers: ${err.message}\n`);
    process.exit(0); // never block
  });
}
