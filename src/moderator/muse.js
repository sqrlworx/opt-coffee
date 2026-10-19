// Muse-backed moderator: llm.js's prompts, sent to Meta's Model API (https://dev.meta.ai/docs).
// Loaded only when META_API_KEY is set, or FORUM_MODERATOR=muse.
import { SYSTEM, createLlmModerator } from './llm.js';

const API = 'https://api.meta.ai/v1';
const TIMEOUT = 60_000; // per request; the expert waits on seed and follow-up questions

/** @param {{apiKey?: string, model?: string}} opts */
export function createMuseModerator({ apiKey = process.env.META_API_KEY, model = process.env.FORUM_MUSE_MODEL ?? 'muse-spark-1.3' } = {}) {
  if (!apiKey) throw new Error('META_API_KEY is not set');

  return createLlmModerator('muse', async (prompt, schema) => {
    const res = await fetch(`${API}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        max_completion_tokens: 4096,
        reasoning_effort: 'low',
        messages: [
          { role: 'developer', content: SYSTEM },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'moderator', strict: true, schema } },
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Muse moderator failed (${res.status}): ${data.error?.message ?? 'no details'}`);
    const choice = data.choices?.[0];
    if (choice?.finish_reason !== 'stop') throw new Error(`Muse moderator stopped with ${choice?.finish_reason}`);
    if (!choice.message?.content) throw new Error('Muse moderator returned no text');
    return JSON.parse(choice.message.content);
  });
}
