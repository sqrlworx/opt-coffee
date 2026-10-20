// Offline moderator: deterministic text heuristics, no external services.
// Used directly when no LLM is configured, and as the fallback when one fails.

const STOPWORDS = new Set(
  `a about above after again against all am an and any are as at be because been before being below
  between both but by can could did do does doing down during each few for from further had has have
  having he her here hers herself him himself his how i if in into is it its itself just me more most
  my myself no nor not now of off on once only or other our ours ourselves out over own same she should
  so some such than that the their theirs them themselves then there these they this those through to
  too under until up very was we were what when where which while who whom why will with would you your
  yours yourself yourselves get got go going want really think thing things lot much many also still
  ever even way something anything someone anyone one ones like make made need know take use used
  best good better advice tips question questions please thanks thank hi hello already actually
  basically still every new day first place become became find look see feel`.split(/\s+/),
);

function stem(word) {
  // Deliberately light: enough to merge "promoted/promotion/promotions", "database/databases".
  let w = word;
  if (w.length > 4) {
    if (w.endsWith('ies')) w = w.slice(0, -3) + 'y';
    else if (w.endsWith('sses')) w = w.slice(0, -2);
    else if (/(x|ch|sh|z)es$/.test(w)) w = w.slice(0, -2);
    else if (w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  }
  for (const suffix of ['ation', 'ment', 'ing', 'ion', 'ed', 'ly']) {
    if (w.length - suffix.length >= 4 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

export function tokenize(text) {
  return (text.match(/[A-Za-z0-9][A-Za-z0-9+#.]*/g) ?? [])
    .map((raw) => raw.replace(/\.+$/, ''))
    .map((raw) => ({ raw, word: raw.toLowerCase() }))
    .filter(({ word }) => word.length > 1 && !STOPWORDS.has(word))
    .map(({ raw, word }) => ({ stem: stem(word), word, raw }));
}

// TF-IDF vectors (Map<stem, weight>, L2-normalized) for a list of texts.
function vectorize(texts) {
  const docs = texts.map(tokenize);
  const df = new Map();
  for (const doc of docs) for (const s of new Set(doc.map((t) => t.stem))) df.set(s, (df.get(s) ?? 0) + 1);
  const n = docs.length;
  const surface = new Map(); // stem -> counts of original spellings, for labels
  const vectors = docs.map((doc) => {
    const v = new Map();
    for (const { stem: s, raw } of doc) {
      v.set(s, (v.get(s) ?? 0) + 1);
      const counts = surface.get(s) ?? new Map();
      counts.set(raw, (counts.get(raw) ?? 0) + 1);
      surface.set(s, counts);
    }
    for (const [s, tf] of v) v.set(s, tf * (Math.log((n + 1) / (df.get(s) + 1)) + 1));
    return normalize(v);
  });
  return { vectors, surface, df };
}

function normalize(v) {
  let norm = 0;
  for (const w of v.values()) norm += w * w;
  norm = Math.sqrt(norm) || 1;
  for (const [k, w] of v) v.set(k, w / norm);
  return v;
}

function cosine(a, b) {
  if (a.size > b.size) [a, b] = [b, a];
  let dot = 0;
  for (const [k, w] of a) dot += w * (b.get(k) ?? 0);
  return dot;
}

function centroid(vectors) {
  const c = new Map();
  for (const v of vectors) for (const [k, w] of v) c.set(k, (c.get(k) ?? 0) + w);
  return normalize(c);
}

// Keep deliberate casing ("MySQL", "iOS"); title-case plain lowercase words.
function labelWord(counts) {
  const spellings = [...counts.entries()].sort((x, y) => y[1] - x[1]);
  const cased = spellings.find(([w]) => /[A-Z]/.test(w.slice(1)));
  const word = cased ? cased[0] : spellings[0][0].toLowerCase();
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Cluster similar questions (average-linkage agglomerative clustering on TF-IDF cosine).
 * @param {{id:number, body:string}[]} questions
 * @returns {{label:string, questionIds:number[]}[]}
 */
export function groupQuestions(questions, { threshold = 0.2 } = {}) {
  if (questions.length === 0) return [];
  const { vectors, surface, df } = vectorize(questions.map((q) => q.body));
  const sim = vectors.map((a) => vectors.map((b) => cosine(a, b)));
  let clusters = questions.map((_, i) => [i]);

  for (;;) {
    let best = { score: threshold, a: -1, b: -1 };
    for (let a = 0; a < clusters.length; a++) {
      for (let b = a + 1; b < clusters.length; b++) {
        let total = 0;
        for (const i of clusters[a]) for (const j of clusters[b]) total += sim[i][j];
        const score = total / (clusters[a].length * clusters[b].length);
        if (score >= best.score) best = { score, a, b };
      }
    }
    if (best.a < 0) break;
    clusters[best.a] = clusters[best.a].concat(clusters[best.b]);
    clusters.splice(best.b, 1);
  }

  // Rank a cluster's terms: central to the cluster *and* recurring across all questions,
  // so a lone question is labeled by its subject ("Databases"), not its rarest word.
  const rankedTerms = (members) =>
    [...centroid(members.map((i) => vectors[i])).entries()]
      .map(([s, w]) => [s, w * Math.log(1 + df.get(s))])
      .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
      .map(([s]) => s);

  // Clusters whose leading term is the same are about the same subject: merge them.
  const byLead = new Map();
  for (const members of clusters) {
    const lead = rankedTerms(members)[0] ?? '';
    byLead.set(lead, (byLead.get(lead) ?? []).concat(members));
  }

  return [...byLead.values()].map((members) => {
    // A second label term only if it is shared by several questions in the group.
    const [lead, ...rest] = rankedTerms(members);
    const second = rest.find((s) => members.filter((i) => vectors[i].has(s)).length >= 2);
    const terms = [lead, second].filter(Boolean);
    return {
      label: terms.length ? terms.map((s) => labelWord(surface.get(s))).join(' & ') : 'General',
      questionIds: members.map((i) => questions[i].id),
    };
  });
}

/**
 * Suggest an answer order mixing popularity with logical flow: start with the most
 * popular group, then repeatedly pick the group that best balances popularity and
 * similarity to the group just covered. Within a group, most-voted first.
 *
 * @param {{label:string, questionIds:number[]}[]} groups
 * @param {{id:number, body:string, votes:number, source:string, createdAt:string}[]} questions
 * @returns {{groups: {label:string, questionIds:number[], popularity:number}[], questionIds:number[]}}
 */
export function suggestOrder(groups, questions, { popularityWeight = 0.6 } = {}) {
  if (groups.length === 0) return { groups: [], questionIds: [] };
  const byId = new Map(questions.map((q) => [q.id, q]));
  // An asker's own question counts as interest; moderator seeds only count their +1s.
  const interest = (q) => q.votes + (q.source === 'asker' ? 1 : 0);

  const { vectors } = vectorize(questions.map((q) => q.body));
  const vecById = new Map(questions.map((q, i) => [q.id, vectors[i]]));

  const enriched = groups.map((g) => {
    const qs = g.questionIds.map((id) => byId.get(id)).filter(Boolean);
    qs.sort((a, b) => b.votes - a.votes || interest(b) - interest(a) || a.createdAt.localeCompare(b.createdAt));
    return {
      label: g.label,
      questionIds: qs.map((q) => q.id),
      popularity: qs.reduce((sum, q) => sum + interest(q), 0),
      centroid: centroid(qs.map((q) => vecById.get(q.id))),
    };
  });

  const maxPop = Math.max(1, ...enriched.map((g) => g.popularity));
  const remaining = [...enriched];
  remaining.sort((a, b) => b.popularity - a.popularity);
  const ordered = [remaining.shift()];
  while (remaining.length) {
    const last = ordered[ordered.length - 1];
    let bestIdx = 0;
    let bestScore = -Infinity;
    remaining.forEach((g, i) => {
      // Cosine between short texts rarely exceeds ~0.3 even when clearly related, so
      // rescale it onto the same 0..1 footing as popularity before mixing.
      const relatedness = Math.min(1, cosine(last.centroid, g.centroid) / 0.3);
      const score = popularityWeight * (g.popularity / maxPop) + (1 - popularityWeight) * relatedness;
      if (score > bestScore) [bestIdx, bestScore] = [i, score];
    });
    ordered.push(remaining.splice(bestIdx, 1)[0]);
  }

  return {
    groups: ordered.map(({ label, questionIds, popularity }) => ({ label, questionIds, popularity })),
    questionIds: ordered.flatMap((g) => g.questionIds),
  };
}

const TEMPLATES = [
  (s) => `What's the most common mistake you see people make with ${s}?`,
  (s) => `If you had to learn ${s} from scratch today, where would you start?`,
  (s) => `What's one thing about ${s} that you believed early on and later changed your mind about?`,
  (s) => `Which resources (books, courses, people) would you recommend for going deeper on ${s}?`,
  (s) => `What's overhyped in ${s} right now, and what's underrated?`,
  (s) => `How do you tell the difference between someone who is good at ${s} and someone who is great?`,
  (s) => `What does a typical week of working on ${s} actually look like for you?`,
  (s) => `What's a question about ${s} you wish people asked you more often?`,
  (s) => `Where do you think ${s} is headed in the next few years?`,
  (s) => `What's the hardest tradeoff you've had to make in ${s}?`,
];

const BACKGROUND_TEMPLATES = [
  (s) => `How has your background shaped the way you approach ${s}?`,
  (s) => `What's a story from your own career that taught you the most about ${s}?`,
];

/**
 * Seed questions derived from the expert's expertise/bio and the office hour's topic.
 * @param {{bio:string, expertise:string[]}} expert
 * @param {{title:string, topic?:string|null, description?:string}} officeHour
 * @param {{existing?:string[], count?:number, round?:number}} opts
 *   existing: question bodies to avoid duplicating; round: vary output on repeat requests.
 * @returns {string[]}
 */
export function suggestQuestions(expert, officeHour, { existing = [], count = 6, round = 0 } = {}) {
  const subjects = [];
  const add = (s) => {
    const clean = s?.trim().replace(/\s+/g, ' ');
    if (clean && !subjects.some((x) => x.toLowerCase() === clean.toLowerCase())) subjects.push(clean);
  };
  add(officeHour.topic);
  for (const tag of expert.expertise ?? []) add(tag);
  if (subjects.length === 0) {
    // Fall back to the most distinctive words in the title/bio.
    const words = tokenize(`${officeHour.title} ${officeHour.description ?? ''} ${expert.bio ?? ''}`);
    for (const { word } of words.slice(0, 3)) add(word);
  }
  if (subjects.length === 0) add('your work');

  const existingVecs = existing.map((e) => new Set(tokenize(e).map((t) => t.stem)));
  const tooSimilar = (q) => {
    const stems = new Set(tokenize(q).map((t) => t.stem));
    return existingVecs.some((e) => {
      const inter = [...stems].filter((s) => e.has(s)).length;
      return inter / Math.max(1, Math.min(stems.size, e.size)) > 0.7;
    });
  };

  const candidates = [];
  const templates = expert.bio?.trim() ? [...TEMPLATES, ...BACKGROUND_TEMPLATES] : TEMPLATES;
  // Walk templates x subjects diagonally so consecutive suggestions vary in both.
  for (let k = 0; k < templates.length * subjects.length; k++) {
    const t = templates[(k + round * count) % templates.length];
    const s = subjects[k % subjects.length];
    candidates.push(t(s));
  }

  const out = [];
  for (const q of candidates) {
    if (out.length >= count) break;
    if (!out.includes(q) && !tooSimilar(q)) out.push(q);
  }
  return out;
}

// ---------- follow-ups ----------

const MAX_FOLLOW_UP = 500; // characters, like a typed question

/**
 * Questions for a follow-up office hour, taken from the discussion under the published answers:
 * the questions people asked in their replies. Ones the expert didn't respond to come first, then
 * the most liked. The expert's own replies are left out.
 * @param {{question: string, replies: {body: string, likes: number, byExpert: boolean, responded: boolean}[]}[]} discussion
 *   one entry per answered question
 * @param {{count?: number}} opts
 * @returns {string[]}
 */
export function followUpQuestions(discussion, { count = 8 } = {}) {
  const candidates = [];
  for (const { replies } of discussion) {
    for (const r of replies) {
      if (r.byExpert) continue;
      for (const s of sentences(r.body).filter((x) => x.endsWith('?') && x.length >= 5)) {
        candidates.push({ text: s.length > MAX_FOLLOW_UP ? shorten(s, MAX_FOLLOW_UP - 1) : s, likes: r.likes, responded: r.responded, order: candidates.length });
      }
    }
  }
  candidates.sort((a, b) => a.responded - b.responded || b.likes - a.likes || a.order - b.order);
  const out = [];
  const picked = [];
  for (const { text } of candidates) {
    if (out.length >= count) break;
    const stems = new Set(tokenize(text).map((t) => t.stem));
    // Skip near-repeats of a question already picked.
    if (picked.some((p) => [...stems].filter((st) => p.has(st)).length / Math.max(1, Math.min(stems.size, p.size)) > 0.7)) continue;
    picked.push(stems);
    out.push(text);
  }
  return out;
}

// ---------- summaries ----------

const QUESTION_CHARS = 90;
const POINT_CHARS = 110;
const MAX_POINTS = 3;

/** `text` cut to about `max` characters at a word boundary. */
function shorten(text, max) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max + 1).replace(/\s+\S*$/, '').replace(/[\s,;:–—-]+$/, '')}…`;
}

const sentences = (text) => (text.match(/[^.?!]+[.?!]*["')\]]?/g) ?? []).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);

/**
 * A short version of one answer, for the summary transcript: the question in a few words, and up
 * to three of the answer's sentences, spread through it.
 * Extractive: in each third of the answer, the sentence whose words the answer uses most.
 * @param {{question: string, answer: string}} input  the answer's transcript, after the question
 * @returns {{question: string, points: string[]}}
 */
export function summarizeAnswer({ question, answer }) {
  const asked = sentences(question);
  const summary = { question: shorten(asked.find((s) => s.endsWith('?')) ?? asked[0] ?? question, QUESTION_CHARS), points: [] };
  // Too short to be a point, unless that's all there is: "Great question." "So, yeah."
  const all = sentences(answer);
  const long = all.filter((s) => s.split(' ').length >= 5);
  const candidates = long.length ? long : all;
  if (!candidates.length) return summary;
  const tf = new Map();
  for (const s of candidates) for (const t of tokenize(s)) tf.set(t.stem, (tf.get(t.stem) ?? 0) + 1);
  const score = (s) => {
    const stems = new Set(tokenize(s).map((t) => t.stem));
    let total = 0;
    for (const st of stems) total += tf.get(st);
    return total / Math.sqrt(s.split(' ').length);
  };
  const n = Math.min(MAX_POINTS, candidates.length);
  for (let i = 0; i < n; i++) {
    const third = candidates.slice(Math.floor((i * candidates.length) / n), Math.floor(((i + 1) * candidates.length) / n));
    const best = third.reduce((a, b) => (score(b) > score(a) ? b : a));
    summary.points.push(shorten(best, POINT_CHARS));
  }
  return summary;
}

// ---------- b-roll ----------

const MIN_BROLL = 1.5; // seconds; a cutaway shorter than this isn't worth it
const LEAD = 2.5; // seconds the expert is on camera, at most, before cutting away
const TAIL = 1.5; // and after cutting back, before the answer ends
const PHRASE_GAP = 0.25; // seconds of silence before a word that starts a phrase
const SENTENCE_GAP = 0.6;

/**
 * Where b-roll can go in an answer, and for how long: all of it, unless it's longer than the
 * answer. The expert is seen first and last, as far as there's room: the b-roll starts a little
 * after the answer does and ends a little before. With `pastEnd` (full-screen b-roll the expert
 * lets run past the end of their answer), it's all of the clip, and one longer than the answer
 * starts as early as it can and runs on past the end. The take starts with the question, up to
 * `answerStart`; `end` is how long the take is, and `clip` how long the b-roll is.
 * @returns {{length: number, from: number, to: number} | null}  the length it plays for, and the
 *   earliest and latest it can start; null when the answer is too short for any
 */
export function brollRange({ clip, answerStart, end, pastEnd = false }) {
  const from = answerStart ?? 0;
  const answer = end - from;
  const length = pastEnd ? clip : Math.min(clip, answer);
  if (!(length >= MIN_BROLL && answer > 0)) return null;
  const spare = Math.max(0, answer - length);
  const earliest = from + Math.min(LEAD, spare / 2);
  return { length: round3(length), from: round3(earliest), to: round3(Math.max(earliest, end - length - Math.min(TAIL, spare / 2))) };
}

/**
 * B-roll cut in where the expert chose, `start` seconds into the take (not before the answer
 * starts): from there until a little before the answer ends, or all of it if it's shorter; with
 * `pastEnd`, all of it, past the end of the answer if need be. Null when it would cut in less than
 * MIN_BROLL before the answer ends, or play for less than that.
 * @returns {{start: number, length: number} | null}
 */
function placeAt({ start, clip, answerStart, end, pastEnd = false }) {
  const at = Math.max(answerStart ?? 0, start);
  const length = pastEnd ? clip : Math.min(clip, end - at - TAIL);
  return end - at >= MIN_BROLL && length >= MIN_BROLL ? { start: round3(at), length: round3(length) } : null;
}

/**
 * Where to cut away to b-roll in an answer: as the expert talks about what it shows (the words
 * it's described with), on a sentence or phrase starting. A word said just before the cut counts
 * nearly as much as one said during it, and less the later it comes. Without a transcript, or when
 * nothing said matches, it goes about a third of the way into the answer, at a phrase if there is
 * one there. See brollRange for how long it plays and where it can go. With a `start`, it goes
 * where the expert chose instead (see placeAt).
 * @param {{description: string, clip: number, answerStart: number|null, end: number, words?: [number, number, string][] | null,
 *   start?: number|null, pastEnd?: boolean}} input  `words` are the take's, from speech-to-text, timed from its start
 * @returns {{start: number, length: number} | null}  null when the answer is too short for b-roll
 */
export function placeBroll(input) {
  if (input.start != null) return placeAt(input);
  const range = brollRange(input);
  if (!range) return null;
  const { length, from, to } = range;
  const answerStart = input.answerStart ?? 0;
  const answer = input.end - answerStart;
  const wanted = new Set(tokenize(input.description).map((t) => t.stem));
  const said = (input.words ?? [])
    .filter(([start, end]) => (start + end) / 2 >= answerStart)
    .map(([start, end, text]) => ({ start, end, text: String(text).trim(), stems: tokenize(String(text)).map((t) => t.stem) }));
  // Cuts can start where a phrase does: after a pause or punctuation. A sentence is better still.
  const starts = [{ at: from, boundary: 0 }];
  said.forEach((w, i) => {
    if (w.start < from || w.start > to) return;
    const before = said[i - 1];
    const gap = before ? w.start - before.end : Infinity;
    const boundary = !before || gap >= SENTENCE_GAP || /[.?!]["')\]]?$/.test(before.text) ? 0.25 : gap >= PHRASE_GAP || /[,;:]$/.test(before.text) ? 0.1 : 0;
    if (boundary) starts.push({ at: w.start, boundary });
  });
  const relevance = (at) => {
    const best = new Map(); // stem -> its weight, counted once
    for (const w of said) {
      if (w.end < at - 1 || w.start >= at + length) continue;
      const weight = w.start < at ? 0.8 : 1 - (0.5 * (w.start - at)) / length;
      for (const s of w.stems) if (wanted.has(s)) best.set(s, Math.max(best.get(s) ?? 0, weight));
    }
    return [...best.values()].reduce((a, b) => a + b, 0);
  };
  const score = ({ at, boundary }) => relevance(at) + boundary - 0.3 * Math.abs((at - answerStart) / answer - 1 / 3);
  const best = starts.reduce((a, b) => (score(b) > score(a) ? b : a));
  // Without a transcript there are no phrases to go by, so it goes a third of the way in.
  const at = said.length ? best.at : Math.min(to, Math.max(from, answerStart + answer / 3));
  return { start: round3(at), length };
}

const round3 = (secs) => Math.round(secs * 1000) / 1000;
