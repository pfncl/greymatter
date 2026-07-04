'use strict';

// Shared tokenizer for FTS5 index — single source of truth for
// stopwords and term normalization across ingest and rebuild paths.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'have', 'from', 'will', 'would',
  'could', 'should', 'been', 'were', 'they', 'their', 'there', 'what', 'when',
  'where', 'which', 'about', 'into', 'your', 'more', 'also', 'some', 'like',
  'just', 'than', 'then', 'these', 'those', 'such', 'each', 'make', 'made',
  'need', 'want', 'look', 'know', 'take', 'come', 'here', 'how', 'not', 'but',
  'can', 'all', 'are', 'was', 'has', 'its', 'let', 'new', 'use', 'used', 'using',
  'get', 'got', 'add', 'set', 'run', 'now', 'see', 'way', 'any', 'one', 'two',
  'file', 'code', 'line', 'lines', 'test', 'type', 'data', 'class', 'function',
]);

const MIN_LENGTH = 4;

// Fold diacritics to ASCII ("klubová" → "klubova") so accented text and
// ASCII-stripped queries meet in the middle. Must be applied on BOTH sides:
// ingest (tokenize below) and query (memory-queries searchConversations).
// Without it the split() below treats á/é/ž… as separators and shreds words.
function foldDiacritics(text) {
  return text.normalize('NFD').replace(/\p{M}+/gu, '');
}

// Tokenizes text into an array of filtered, lowercased, diacritics-folded terms
function tokenize(text) {
  if (!text) return [];
  return foldDiacritics(text.replace(/<[^>]+>/g, ' ').toLowerCase())
    .split(/[^a-z0-9_]+/)
    .filter(t => t.length >= MIN_LENGTH && !STOPWORDS.has(t));
}

// Tokenizes and deduplicates — returns unique terms sorted by frequency
function extractTerms(userTexts) {
  const counts = {};
  for (const text of userTexts) {
    const cleaned = text
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .trim();
    for (const t of tokenize(cleaned)) {
      counts[t] = (counts[t] || 0) + 1;
    }
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(e => e[0]);
}

module.exports = { tokenize, extractTerms, foldDiacritics, STOPWORDS, MIN_LENGTH };
