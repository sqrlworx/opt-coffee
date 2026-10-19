import { createHash } from 'node:crypto';
import * as heuristic from './heuristic.js';

const CACHE_LIMIT = 500;

/**
 * The moderator facade the app talks to.
 *
 * - suggestQuestions: async; uses Claude when available, heuristics otherwise.
 * - followUpQuestions: async, the same way; questions for a follow-up, from a discussion.
 * - groupQuestions: sync, so page loads never wait on an LLM. With Claude enabled it
 *   serves cached LLM groupings and refreshes them in the background
 *   (stale-while-revalidate); until a grouping is ready it returns the heuristic one.
 * - suggestOrder: always local and deterministic, computed from the groups.
 * - summarizeAnswer: sync, cached and refreshed in the background like groupQuestions. Until the
 *   LLM's summary is ready it returns the heuristic one marked `pending`, so pages can check back.
 * - placeBroll: async; where b-roll goes in an answer. Claude picks the moment when available;
 *   how long it plays, and where it may go, are always the heuristic's.
 *
 * `llm` stands in for Claude (tests).
 * @param {{mode?: 'auto'|'heuristic'|'claude', log?: (msg:string)=>void, llm?: object}} opts
 */
export async function createModerator({ mode = process.env.FORUM_MODERATOR ?? 'auto', log = console.warn, llm = null } = {}) {
  const hasCredentials = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  if (!llm && (mode === 'claude' || (mode === 'auto' && hasCredentials))) {
    try {
      const { createClaudeModerator } = await import('./claude.js');
      llm = await createClaudeModerator();
    } catch (err) {
      log(`[moderator] Claude unavailable, using heuristics: ${err.message}`);
    }
  }

  const groupCache = new Map(); // fingerprint -> groups
  const summaryCache = new Map(); // fingerprint -> summary
  const inFlight = new Set();

  function remember(cache, key, value) {
    cache.set(key, value);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  }

  function refreshGroups(key, questions) {
    if (inFlight.has(key)) return;
    inFlight.add(key);
    llm
      .groupQuestions(questions)
      .then((groups) => remember(groupCache, key, sanitizeGroups(groups, questions)))
      .catch((err) => log(`[moderator] Claude grouping failed: ${err.message}`))
      .finally(() => inFlight.delete(key));
  }

  function refreshSummary(key, input) {
    if (inFlight.has(key)) return;
    inFlight.add(key);
    llm
      .summarizeAnswer(input)
      .then((summary) => remember(summaryCache, key, sanitizeSummary(summary, input)))
      .catch((err) => {
        log(`[moderator] Claude summary failed: ${err.message}`);
        remember(summaryCache, key, heuristic.summarizeAnswer(input)); // so pages stop waiting for it
      })
      .finally(() => inFlight.delete(key));
  }

  return {
    name: llm ? 'claude' : 'heuristic',

    async suggestQuestions(expert, officeHour, opts = {}) {
      if (llm) {
        try {
          const out = await llm.suggestQuestions(expert, officeHour, opts);
          if (out.length) return out;
        } catch (err) {
          log(`[moderator] Claude suggestions failed: ${err.message}`);
        }
      }
      return heuristic.suggestQuestions(expert, officeHour, opts);
    },

    /**
     * @param {{title: string, topic?: string|null, description?: string}} officeHour  the one being followed up
     * @param {{question: string, replies: {body: string, likes: number, byExpert: boolean, responded: boolean}[]}[]} discussion
     * @returns {Promise<string[]>}
     */
    async followUpQuestions(officeHour, discussion, opts = {}) {
      const people = discussion.some((d) => d.replies.some((r) => !r.byExpert));
      if (llm && people) {
        try {
          return (await llm.followUpQuestions(officeHour, discussion, opts)).map((q) => q.slice(0, 500));
        } catch (err) {
          log(`[moderator] Claude follow-up questions failed: ${err.message}`);
        }
      }
      return heuristic.followUpQuestions(discussion, opts);
    },

    groupQuestions(questions) {
      if (questions.length === 0) return [];
      if (!llm || questions.length === 1) return heuristic.groupQuestions(questions);
      const key = fingerprint(questions);
      const cached = groupCache.get(key);
      if (cached) return cached;
      refreshGroups(key, questions);
      return heuristic.groupQuestions(questions);
    },

    suggestOrder: heuristic.suggestOrder,
    brollRange: heuristic.brollRange,

    /**
     * @param {{question: string, answer: string}} input  the answer's transcript, after the question
     * @returns {{question: string, points: string[], pending: boolean}}
     */
    summarizeAnswer(input) {
      if (!llm || !input.answer) return { ...heuristic.summarizeAnswer(input), pending: false };
      const key = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const cached = summaryCache.get(key);
      if (cached) return { ...cached, pending: false };
      refreshSummary(key, input);
      return { ...heuristic.summarizeAnswer(input), pending: true };
    },

    /**
     * @param {{description: string, question: string, clip: number, answerStart: number|null, end: number,
     *   words: [number, number, string][]|null, cues: [number, number, string][]|null, full?: boolean}} input  the b-roll's
     *   description and length (`clip`), and the take: where its answer starts, how long it is, and its transcript;
     *   `full` when the b-roll is full screen rather than split screen
     * @returns {Promise<{start: number, length: number} | null>}  null when the answer is too short for b-roll
     */
    async placeBroll(input) {
      const placed = heuristic.placeBroll(input);
      const range = heuristic.brollRange(input);
      const cues = (input.cues ?? []).filter(([start, end]) => (start + end) / 2 >= (input.answerStart ?? 0));
      if (!llm || !placed || !cues.length) return placed;
      try {
        const { start } = await llm.placeBroll({ description: input.description, question: input.question, cues, ...range, ...(input.full ? { full: true } : {}) });
        // LLM output is untrusted: kept where the b-roll can go.
        if (Number.isFinite(start)) return { start: Math.round(Math.min(range.to, Math.max(range.from, start)) * 1000) / 1000, length: placed.length };
      } catch (err) {
        log(`[moderator] Claude b-roll placement failed: ${err.message}`);
      }
      return placed;
    },
  };
}

function fingerprint(questions) {
  const h = createHash('sha256');
  for (const q of [...questions].sort((a, b) => a.id - b.id)) h.update(`${q.id}\u0000${q.body}\u0001`);
  return h.digest('hex');
}

// LLM output is untrusted: keep it short, and fall back to the heuristics for anything missing.
function sanitizeSummary(summary, input) {
  const fallback = heuristic.summarizeAnswer(input);
  const points = (Array.isArray(summary?.points) ? summary.points : [])
    .filter((p) => typeof p === 'string' && p.trim())
    .slice(0, 4)
    .map((p) => p.trim().slice(0, 200));
  const question = typeof summary?.question === 'string' ? summary.question.trim().slice(0, 140) : '';
  return { question: question || fallback.question, points: points.length ? points : fallback.points };
}

// LLM output is untrusted: drop unknown/duplicate ids and give leftovers their own groups.
function sanitizeGroups(groups, questions) {
  const valid = new Set(questions.map((q) => q.id));
  const seen = new Set();
  const out = [];
  for (const g of groups) {
    const ids = g.questionIds.filter((id) => valid.has(id) && !seen.has(id));
    ids.forEach((id) => seen.add(id));
    if (ids.length) out.push({ label: String(g.label || 'General').slice(0, 60), questionIds: ids });
  }
  const leftovers = questions.filter((q) => !seen.has(q.id));
  return out.concat(heuristic.groupQuestions(leftovers));
}
