import { createHash } from 'node:crypto';
import * as heuristic from './heuristic.js';

const CACHE_LIMIT = 500;

/**
 * The moderator facade the app talks to.
 *
 * - suggestQuestions: async; uses Claude when available, heuristics otherwise.
 * - groupQuestions: sync, so page loads never wait on an LLM. With Claude enabled it
 *   serves cached LLM groupings and refreshes them in the background
 *   (stale-while-revalidate); until a grouping is ready it returns the heuristic one.
 * - suggestOrder: always local and deterministic, computed from the groups.
 * - summarizeAnswer: sync, cached and refreshed in the background like groupQuestions. Until the
 *   LLM's summary is ready it returns the heuristic one marked `pending`, so pages can check back.
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
