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
