import { readFileSync, writeFileSync } from 'node:fs';

const API = 'https://api.openai.com/v1';
const TIMEOUT = 3 * 60_000; // per request; drawing a frame takes a few seconds to a minute
const MAX_ANSWER = 8000; // characters of the answer GPT reads
const SHOT_RULES = readFileSync(new URL('./shot.md', import.meta.url), 'utf8');
const FRAME_RULES = `

Also describe the clip's first frame as a still image, for an image model to draw: the same kind of picture (a photograph for live footage, the diagram or illustration itself for one of those), with the same content, labels, colours and framing, at the moment the clip starts, in 40 to 70 words. Keep what matters in the middle of the frame, away from the top and bottom edges, since it's cropped to 16:9.`;
const PLAN_SCHEMA = {
  type: 'object',
  properties: { shot: { type: 'string' }, frame: { type: 'string' } },
  required: ['shot', 'frame'],
  additionalProperties: false,
};
const LOOK = 'A still from a video, sharp and clean. No captions, logos or watermarks.';

/**
 * B-roll's shot, planned with OpenAI when there's an API key: GPT writes it up from the expert's
 * description (by the same rules as the local writer, shot.md), and gpt-image draws its first
 * frame, which the video model then animates (see broll.py). Both get the question and what the
 * expert says in the answer.
 *
 * Returns null without a key.
 * @param {{apiKey?: string, textModel?: string, imageModel?: string}} opts
 */
export function createOpenAIPlanner({
  apiKey = process.env.OPENAI_API_KEY,
  textModel = process.env.FORUM_OPENAI_MODEL ?? 'gpt-5.5',
  imageModel = process.env.FORUM_OPENAI_IMAGE_MODEL ?? 'gpt-image-2',
} = {}) {
  if (!apiKey) return null;

  async function post(path, body, signal) {
    const res = await fetch(`${API}/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT)]) : AbortSignal.timeout(TIMEOUT),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`OpenAI ${path} failed (${res.status}): ${data.error?.message ?? 'no details'}`);
    return data;
  }

  return {
    name: `${textModel} + ${imageModel}`,

    /**
     * The shot to film for the expert's description, and its first frame as a photograph.
     * @returns {Promise<{shot: string, frame: string}>}
     */
    async plan({ prompt, question = null, answer = null, signal = null }) {
      const input = [
        question ? `<question>\n${question}\n</question>` : null,
        answer ? `<answer>\n${answer.slice(0, MAX_ANSWER)}\n</answer>` : null,
        `<b_roll>\n${prompt}\n</b_roll>`,
      ].filter(Boolean).join('\n');
      const res = await post('responses', {
        model: textModel,
        reasoning: { effort: 'low' },
        instructions: SHOT_RULES + FRAME_RULES,
        input,
        text: { format: { type: 'json_schema', name: 'b_roll_shot', strict: true, schema: PLAN_SCHEMA } },
      }, signal);
      const text = res.output?.find((o) => o.type === 'message')?.content?.find((c) => c.type === 'output_text')?.text;
      if (!text) throw new Error(`OpenAI wrote no shot (${res.status})`);
      const { shot, frame } = JSON.parse(text);
      const tidy = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
      if (tidy(shot).split(' ').length < 8 || !tidy(frame)) throw new Error(`OpenAI's shot came out as ${JSON.stringify(text.slice(0, 200))}`);
      return { shot: tidy(shot), frame: tidy(frame) };
    },

    /** Draws `frame` (see plan) as a PNG at `file`, 3:2, for cropping to 16:9. */
    async draw(frame, file, { signal = null } = {}) {
      const res = await post('images/generations', { model: imageModel, prompt: `${frame}\n\n${LOOK}`, size: '1536x1024', quality: 'medium', n: 1 }, signal);
      const image = res.data?.[0]?.b64_json;
      if (!image) throw new Error('OpenAI drew no image');
      writeFileSync(file, Buffer.from(image, 'base64'));
    },
  };
}
