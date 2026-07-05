#!/usr/bin/env node
'use strict';
require('../lib/resolve-deps');

const path = require('path');
const { MemoryDB } = require('../lib/memory-db');
const { MemoryQueries } = require('../lib/memory-queries');
const { getDataDir } = require('../lib/config');

function getMemoryDbPath() {
  return path.join(getDataDir(), 'memory.db');
}

// ---- Message parsing from stored JSONL text ----

function cleanUserText(content) {
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content.filter(b => b.type === 'text').map(b => b.text).join('');
  }
  text = text.replace(/<command-message>[\s\S]*?<\/command-message>\s*/g, '');
  text = text.replace(/<command-name>[\s\S]*?<\/command-name>\s*/g, '');
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '');
  text = text.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>\s*/g, '');
  text = text.replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>\s*/g, '');
  text = text.replace(/<command-args>[\s\S]*?<\/command-args>\s*/g, '');
  return text.trim();
}

function isConversational(text) {
  if (!text || text.length === 0) return false;
  if (text === '[Request interrupted by user for tool use]') return false;
  if (text === '[Request interrupted by user]') return false;
  const skipPrefixes = [
    'Start-of-session greeting',
    'End-of-session goodnight',
    'End-of-work wrap up',
    'Resume a project or workspace',
    'Base directory for this skill:',
    'Implement the following plan:',
    'This session is being continued from a previous conversation',
  ];
  for (const prefix of skipPrefixes) {
    if (text.startsWith(prefix)) return false;
  }
  return true;
}

// Parse stored JSONL content into message objects.
// startLocal/endLocal are 0-indexed within the stored content (not the global session).
function parseMessages(content, startLocal, endLocal) {
  const rawLines = content.split('\n');
  if (startLocal == null) startLocal = 0;
  if (endLocal == null) endLocal = rawLines.length - 1;

  const rawMessages = [];
  for (let i = startLocal; i <= endLocal && i < rawLines.length; i++) {
    const line = rawLines[i];
    if (!line || !line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    if (obj.type === 'user') {
      const text = cleanUserText(obj.message && obj.message.content != null ? obj.message.content : '');
      if (isConversational(text)) {
        rawMessages.push({ ln: i, type: 'user', text, timestamp: obj.timestamp });
      }
    } else if (obj.type === 'assistant') {
      const content2 = obj.message && obj.message.content;
      const text = Array.isArray(content2)
        ? content2.filter(b => b.type === 'text').map(b => b.text).join('').trim()
        : '';
      const requestId = obj.requestId || obj.uuid;
      const activities = [];
      if (Array.isArray(content2)) {
        for (const block of content2) {
          if (block.type === 'tool_use' && block.name === 'Skill') {
            activities.push({ kind: 'skill', name: block.input && block.input.skill || '?' });
          } else if (block.type === 'tool_use' && block.name === 'Agent') {
            activities.push({ kind: 'agent', name: block.input && block.input.description || '?' });
          }
        }
      }
      if (text || activities.length > 0) {
        rawMessages.push({ ln: i, type: 'assistant', text: text || '', timestamp: obj.timestamp, requestId, activities });
      }
    }
  }

  // Merge assistant chunks by requestId
  const merged = new Map();
  for (const msg of rawMessages) {
    if (msg.type === 'assistant' && msg.requestId) {
      if (merged.has(msg.requestId)) {
        const existing = merged.get(msg.requestId);
        if (msg.text) existing.text = existing.text ? existing.text + '\n\n' + msg.text : msg.text;
        if (msg.activities && msg.activities.length) {
          existing.activities = (existing.activities || []).concat(msg.activities);
        }
        existing.ln = msg.ln;
      } else {
        merged.set(msg.requestId, Object.assign({}, msg));
      }
    }
  }

  const seen = new Set();
  const messages = [];
  for (const msg of rawMessages) {
    if (msg.type === 'user') {
      messages.push(msg);
    } else if (msg.type === 'assistant' && msg.requestId && !seen.has(msg.requestId)) {
      seen.add(msg.requestId);
      const m = merged.get(msg.requestId);
      if (m && m.text) messages.push(m);
    }
  }
  return messages;
}

// Compact: keep first assistant response per user turn, collapse the rest.
function compactMessages(messages) {
  const output = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.type === 'user') {
      output.push(msg);
      i++;
      if (i < messages.length && messages[i].type === 'assistant') {
        output.push(messages[i]);
        i++;
        let skippedCount = 0, firstLine = null, lastLine = null;
        const activities = [];
        while (i < messages.length && messages[i].type === 'assistant') {
          if (firstLine === null) firstLine = messages[i].ln;
          lastLine = messages[i].ln;
          if (messages[i].activities) for (const a of messages[i].activities) activities.push(a);
          skippedCount++;
          i++;
        }
        if (skippedCount > 0) output.push({ type: 'skip', count: skippedCount, startLine: firstLine, endLine: lastLine, activities });
      }
    } else if (msg.type === 'assistant') {
      output.push(msg);
      i++;
      let skippedCount = 0, firstLine = null, lastLine = null;
      const activities = [];
      while (i < messages.length && messages[i].type === 'assistant') {
        if (firstLine === null) firstLine = messages[i].ln;
        lastLine = messages[i].ln;
        if (messages[i].activities) for (const a of messages[i].activities) activities.push(a);
        skippedCount++;
        i++;
      }
      if (skippedCount > 0) output.push({ type: 'skip', count: skippedCount, startLine: firstLine, endLine: lastLine, activities });
    } else {
      i++;
    }
  }
  return output;
}

function printMessages(msgs, fullMode) {
  const output = fullMode ? msgs : compactMessages(msgs);
  for (const msg of output) {
    if (msg.type === 'skip') {
      let label = msg.count + ' Claude messages skipped';
      if (msg.activities && msg.activities.length > 0) {
        const skills = [...new Set(msg.activities.filter(a => a.kind === 'skill').map(a => a.name))];
        const agents = msg.activities.filter(a => a.kind === 'agent').map(a => a.name);
        const parts = [];
        if (skills.length) parts.push(skills.join(', '));
        if (agents.length) parts.push(agents.join(', '));
        label += ' (' + parts.join(' -> ') + ')';
      }
      console.log('\n  [...' + label + ' — lines ' + msg.startLine + '-' + msg.endLine + ']');
    } else {
      const role = msg.type === 'user' ? 'Human' : 'Claude';
      console.log('\n[' + role + '] (line ' + msg.ln + ')');
      console.log(msg.text);
    }
  }
}

function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log('Usage: node read-window.js <session-prefix> <seq> [--focus start-end] [--full] [--digest] [--decision N [--why]]');
    process.exit(1);
  }

  const sessionPrefix = args[0];
  const seq = parseInt(args[1], 10);
  const fullMode = args.includes('--full');
  const digestMode = args.includes('--digest');

  let focusStart = null, focusEnd = null;
  const focusIdx = args.indexOf('--focus');
  if (focusIdx !== -1 && args[focusIdx + 1]) {
    const parts = args[focusIdx + 1].split('-').map(Number);
    focusStart = parts[0];
    focusEnd = parts[1];
  }

  let decisionNum = null, decisionWhy = false;
  const decIdx = args.indexOf('--decision');
  if (decIdx !== -1 && args[decIdx + 1]) {
    decisionNum = parseInt(args[decIdx + 1], 10);
    decisionWhy = args.includes('--why');
  }

  let db;
  try {
    db = new MemoryDB(getMemoryDbPath());
  } catch (err) {
    console.error('Could not open memory.db: ' + err.message);
    process.exit(1);
  }

  const queries = new MemoryQueries(db);
  const win = queries.findWindow(sessionPrefix, seq);

  if (!win) {
    console.error('Window not found: session=' + sessionPrefix + ' seq=' + seq);
    db.close();
    process.exit(1);
  }

  // -- digest mode --
  if (digestMode) {
    const decisions = queries.getWindowDecisionsBySeq(sessionPrefix, seq) || [];
    const sessionShort = win.session_id.length > 8 ? win.session_id.slice(0, 8) + '...' : win.session_id;
    console.log('Session: ' + sessionShort);
    console.log('Window: seq ' + seq + ' | lines ' + win.start_line + '-' + win.end_line + ' | digest');
    if (win.scope) console.log('Scope: ' + win.scope);
    if (win.summary) console.log('Summary: ' + win.summary);
    console.log('='.repeat(60));
    if (decisions.length === 0) {
      console.log('\nNo decisions detected for this window.');
    } else {
      for (const d of decisions) {
        const statusTag = d.status && d.status !== 'decided' ? ' (' + d.status + ')' : '';
        console.log('\n  ' + (d.seq != null ? d.seq + '. ' : '') + d.summary + statusTag);
      }
    }
    console.log('\n' + decisions.length + ' decision' + (decisions.length === 1 ? '' : 's'));
    db.close();
    return;
  }

  // -- decision mode --
  if (decisionNum != null) {
    const decisions = queries.getWindowDecisionsBySeq(sessionPrefix, seq) || [];
    const target = decisions.find(d => d.seq === decisionNum);
    if (!target) {
      console.error('Decision ' + decisionNum + ' not found. This window has ' + decisions.length + ' decision(s).');
      db.close();
      process.exit(1);
    }

    const contentRow = queries.getWindowFullContent(sessionPrefix, seq);
    const storedContent = contentRow && contentRow.content ? contentRow.content : '';

    // Global line numbers → local indices in stored content
    const offset = win.start_line || 0;
    let localStart = Math.max(0, (target.start_line || offset) - offset);
    const localEnd = Math.max(0, (target.end_line || win.end_line) - offset);

    if (decisionWhy && decisionNum > 0) {
      const prev = decisions.find(d => d.seq === decisionNum - 1);
      if (prev && prev.end_line != null) localStart = Math.max(0, prev.end_line + 1 - offset);
    } else if (decisionWhy && decisionNum === 0) {
      localStart = 0;
    }

    const messages = parseMessages(storedContent, localStart, localEnd);
    const mode = decisionWhy ? 'decision + reasoning' : 'decision';
    const sessionShort = win.session_id.length > 8 ? win.session_id.slice(0, 8) + '...' : win.session_id;
    console.log('Session: ' + sessionShort);
    console.log('Window: seq ' + seq + ' | Decision ' + decisionNum + ' | ' + mode);
    console.log('Decision: ' + target.summary);
    console.log('='.repeat(60));
    printMessages(messages, fullMode);
    db.close();
    return;
  }

  // -- focus / full mode --
  const contentRow = queries.getWindowFullContent(sessionPrefix, seq);
  const storedContent = contentRow && contentRow.content ? contentRow.content : '';
  const offset = win.start_line || 0;
  const totalLocalLines = storedContent.split('\n').length;

  let localStart = 0;
  let localEnd = totalLocalLines - 1;
  let globalStart = win.start_line || 0;
  let globalEnd = win.end_line || (offset + totalLocalLines - 1);

  if (focusStart != null) {
    localStart = Math.max(0, focusStart - offset);
    globalStart = focusStart;
  }
  if (focusEnd != null) {
    localEnd = Math.min(totalLocalLines - 1, focusEnd - offset);
    globalEnd = focusEnd;
  }

  const messages = parseMessages(storedContent, localStart, localEnd);
  const sessionShort = win.session_id.length > 8 ? win.session_id.slice(0, 8) + '...' : win.session_id;
  const mode = fullMode ? 'full' : 'compact';
  console.log('Session: ' + sessionShort);
  console.log('Window: seq ' + seq + ' | lines ' + globalStart + '-' + globalEnd + ' | ' + mode);
  console.log('Messages: ' + messages.length + ' total');
  console.log('='.repeat(60));
  printMessages(messages, fullMode);

  db.close();
}

main();
