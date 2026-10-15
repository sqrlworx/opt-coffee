import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';

const API = 'https://generativelanguage.googleapis.com/v1beta';
const TIMEOUT = 2 * 60_000; // per request
const RENDER_TIMEOUT = 15 * 60_000; // a clip usually takes a minute or two
const POLL = 10_000;
const MAX_ANSWER = 8000; // characters of the answer Gemini reads
const SHOT_RULES = readFileSync(new URL('./shot.md', import.meta.url), 'utf8');
const LENGTHS = [4, 6, 8]; // the clip lengths Veo makes, in seconds
const NEGATIVE = 'subtitles, captions, watermark, logo, split screen';
const sleep = promisify(setTimeout);

/**
 * B-roll with the Gemini API, when there's a key: Veo films the shot, and Gemini writes it up from
 * the expert's description (by the same rules as the local writer, shot.md) when nothing else does.
 * Veo makes 4, 6 or 8 seconds at 720p (with sound, which the cutaway doesn't use).
 *
 * Returns null without a key.
 * @param {{apiKey?: string, videoModel?: string, textModel?: string, poll?: number}} opts
 */
export function createGemini({
  apiKey = process.env.GEMINI_API_KEY,
  videoModel = process.env.FORUM_VEO_MODEL ?? 'veo-3.1-fast-generate-preview',
  textModel = process.env.FORUM_GEMINI_MODEL ?? 'gemini-3.5-flash',
  poll = POLL,
} = {}) {
  if (!apiKey) return null;
  const within = (signal, ms = TIMEOUT) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms));

  async function call(path, body, signal) {
    const res = await fetch(`${API}/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'x-goog-api-key': apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: within(signal),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Gemini ${path.split(':').at(-1)} failed (${res.status}): ${data.error?.message?.trim() ?? 'no details'}`);
    return data;
  }

  return {
    videoName: videoModel,
    textName: textModel,
    /** The longest clip Veo makes. */
    maxSeconds: LENGTHS.at(-1),

    /**
     * Films `shot` with Veo as an MP4 at `out`, at least `seconds` long if it can be (4, 6 or 8).
     * Aborting `signal` stops waiting for it.
     * @returns {Promise<{seconds: number}>}
     */
    async film(shot, out, { seconds, signal = null }) {
      const length = LENGTHS.find((s) => s >= seconds) ?? LENGTHS.at(-1);
      let op = await call(`models/${videoModel}:predictLongRunning`, {
        instances: [{ prompt: shot }],
        parameters: { aspectRatio: '16:9', durationSeconds: length, resolution: '720p', negativePrompt: NEGATIVE },
      }, signal);
      for (const until = Date.now() + RENDER_TIMEOUT; !op.done; ) {
        if (Date.now() > until) throw new Error('Veo took too long');
        await sleep(poll, null, { signal: signal ?? undefined });
        op = await call(op.name, null, signal);
      }
      if (op.error) throw new Error(`Veo failed: ${op.error.message}`);
      const result = op.response?.generateVideoResponse;
      const uri = result?.generatedSamples?.[0]?.video?.uri;
      if (!uri) throw new Error(`Veo made no video${result?.raiMediaFilteredReasons?.length ? `: ${result.raiMediaFilteredReasons.join(' ')}` : ''}`);
      const res = await fetch(uri, { headers: { 'x-goog-api-key': apiKey }, signal: within(signal) });
      if (!res.ok) throw new Error(`downloading Veo's video failed (${res.status})`);
      const part = `${out}.part`;
      try {
        writeFileSync(part, Buffer.from(await res.arrayBuffer()));
        renameSync(part, out);
      } finally {
        rmSync(part, { force: true });
      }
      return { seconds: length };
    },

    /**
     * The shot to film for the expert's description, written up by Gemini (see openai.js for the
     * same with GPT, which also describes a first frame; Veo doesn't need one).
     * @returns {Promise<{shot: string}>}
     */
    async plan({ prompt, question = null, answer = null, signal = null }) {
      const brief = [
        question ? `<question>\n${question}\n</question>` : null,
        answer ? `<answer>\n${answer.slice(0, MAX_ANSWER)}\n</answer>` : null,
        `<b_roll>\n${prompt}\n</b_roll>`,
      ].filter(Boolean).join('\n');
      const res = await call(`models/${textModel}:generateContent`, {
        systemInstruction: { parts: [{ text: SHOT_RULES }] },
        contents: [{ role: 'user', parts: [{ text: brief }] }],
      }, signal);
      const shot = (res.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').replace(/\s+/g, ' ').trim();
      if (shot.split(' ').length < 8) throw new Error(`Gemini's shot came out as ${JSON.stringify(shot.slice(0, 200))}`);
      return { shot };
    },
  };
}
