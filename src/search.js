// Explore's search: words matched at their start, forgiving of typos, scored by how well and where
// they matched, with the parts that matched to highlight.

// A word as it's compared: lowercase, accents dropped ("Café" → "cafe").
const fold = (word) => word.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

// The words of `text`, folded, with where each is in it.
function tokens(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
    const word = fold(m[0]);
    if (word) out.push({ word, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

export const words = (text) => tokens(text).map((t) => t.word);

// Edits (insert, delete, substitute, swap two neighbours) to turn `a` into `b`, giving up past `max`.
function distance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prev2[j - 2] + 1);
      row.push(d);
      best = Math.min(best, d);
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = row;
  }
  return prev[b.length];
}

// Short words have to be spelled right; longer ones can be a typo or two off.
const typos = (term) => (term.length >= 8 ? 2 : term.length >= 4 ? 1 : 0);

// How well a search term matches a word: 4 for the word itself, 3 for its start (so a term still
// being typed matches), 2 for a typo or two off the word, 1 for a typo or two off its start, which
// is a letter longer or shorter for a letter added or missed. Not the start for a term of four
// letters: one off the start of a word is too many words ("maya" would match "management"). `length`
// is how much of the word matched.
function wordMatch(term, word) {
  if (word === term) return { quality: 4, length: word.length };
  if (word.startsWith(term)) return { quality: 3, length: term.length };
  const max = typos(term);
  if (!max) return null;
  if (distance(term, word, max) <= max) return { quality: 2, length: word.length };
  if (term.length < 5) return null;
  for (let n = term.length - 1; n <= term.length + 1; n++) {
    if (n < word.length && distance(term, word.slice(0, n), max) <= max) return { quality: 1, length: n };
  }
  return null;
}

// The words of a search, each once.
export const terms = (query) => [...new Set(words(query))];

/**
 * Matches search `terms` against `fields` ([{ key, text, weight }]): every term has to match a word
 * of some field. Returns null if one doesn't, else `score`, each term's best match times its field's
 * weight, summed, and `ranges`: for each field key, the [start, end] parts of its text that matched,
 * in order.
 */
export function match(terms, fields) {
  if (!terms.length) return null;
  const tokenized = fields.map((f) => ({ ...f, tokens: tokens(f.text) }));
  let score = 0;
  const ranges = {};
  for (const term of terms) {
    let best = 0;
    for (const { key, weight, tokens } of tokenized) {
      for (const t of tokens) {
        const m = wordMatch(term, t.word);
        if (!m) continue;
        best = Math.max(best, m.quality * weight);
        // Folding can change a word's length (a ligature, say); then it's all highlighted.
        const end = m.length < t.word.length && t.word.length === t.end - t.start ? t.start + m.length : t.end;
        (ranges[key] ??= []).push([t.start, end]);
      }
    }
    if (!best) return null;
    score += best;
  }
  for (const key of Object.keys(ranges)) ranges[key] = merge(ranges[key]);
  return { score, ranges };
}

function merge(ranges) {
  const out = [];
  for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/** A test for whether texts match `query` between them, or null if the query has no words. */
export function matcher(query) {
  const t = terms(query);
  if (!t.length) return null;
  return (...texts) => Boolean(match(t, texts.map((text, i) => ({ key: i, text, weight: 1 }))));
}

/**
 * About `length` characters of `text` on one line, from a little before the first of `ranges`, with
 * an ellipsis where it's cut, and the ranges in it. Null without ranges.
 */
export function snippet(text, ranges, length = 160) {
  if (!ranges?.length) return null;
  const flat = text.replace(/\s/g, ' ');
  if (flat.length <= length) return { text: flat, ranges };
  const first = ranges[0][0];
  let start = Math.max(0, first - 40);
  if (start > 0) {
    const space = flat.indexOf(' ', start);
    start = space >= 0 && space < first ? space + 1 : start;
  }
  let end = Math.min(flat.length, start + length);
  if (end < flat.length) {
    const space = flat.lastIndexOf(' ', end);
    if (space > first) end = space;
  }
  const lead = start > 0 ? '…' : '';
  const shift = lead.length - start;
  return {
    text: lead + flat.slice(start, end) + (end < flat.length ? '…' : ''),
    ranges: ranges.filter(([s, e]) => e > start && s < end).map(([s, e]) => [Math.max(s, start) + shift, Math.min(e, end) + shift]),
  };
}
