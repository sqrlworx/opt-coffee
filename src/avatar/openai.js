import { readFileSync } from 'node:fs';

const API = 'https://api.openai.com/v1';
const TIMEOUT = 3 * 60_000; // per request; drawing a character takes about half a minute
const DESIGN_RULES = readFileSync(new URL('./character.md', import.meta.url), 'utf8');
const DESIGN_SCHEMA = {
  type: 'object',
  properties: { allowed: { type: 'boolean' }, reason: { type: 'string' }, characters: { type: 'array', items: { type: 'string' } } },
  required: ['allowed', 'reason', 'characters'],
  additionalProperties: false,
};
// How every character is drawn, so that players can animate it (see rig.js): eyes it can blink as
// the fox does, and a closed mouth that can open, all facing the viewer, on a plain background
// that shows around it.
const LOOK = `Style: a clean 2D cartoon illustration, flat colours with soft shading, simple bold shapes, like a modern animated show.
Framing: head and shoulders, facing the viewer straight on, centred, the face in the middle of the picture, with clear space above the head and at the sides.
Face: two simple solid black oval eyes, each with one small white highlight, set apart, with nothing touching or covering them (no eyelashes, glasses, hair or eyebrows over them). The mouth is closed: one thin dark curved line, a gentle smile, with no teeth, lips or tongue showing and nothing covering it. A character with a beak, snout or muzzle has this smile line too, drawn on its face just below the beak or nose, as in a children's cartoon.
Background: one plain, flat, light colour, with nothing else in it.
No text, logos or watermarks. Wholesome and friendly.`;
const SIZE = 1024; // pixels square
const box = { type: 'array', items: { type: 'number' } };
const SEEN_SCHEMA = {
  type: 'object',
  properties: { appropriate: { type: 'boolean' }, animatable: { type: 'boolean' }, problem: { type: 'string' }, leftEye: box, rightEye: box, mouth: box, head: box },
  required: ['appropriate', 'animatable', 'problem', 'leftEye', 'rightEye', 'mouth', 'head'],
  additionalProperties: false,
};
const SEEN_RULES = `You check a cartoon character drawn for someone's profile picture, which will be animated saying things: its eyes blink and its mouth moves. The image is ${SIZE} by ${SIZE} pixels; give positions in its pixels, x from the left edge and y from the top.
- appropriate: false if anything in it is vulgar, obscene, sexual, hateful, violent or gory, or mocks a group of people.
- animatable: true only if the character faces the viewer with two visible, solid dark eyes and one closed mouth drawn as a thin dark line, nothing covering them. A smile line below a beak or nose counts as the mouth; a beak or snout without one doesn't. Otherwise false, and say why in problem (else leave problem empty).
- leftEye, rightEye: the box around each eye as [left, top, right, bottom], leftEye the one on the left of the picture.
- mouth: the box around the mouth line, corner to corner, as [left, top, right, bottom], not including any beak or nose above it.
- head: the box around the whole head, including hair, ears, horns or a hat, as [left, top, right, bottom].`;

/** The image model wouldn't draw it: its own moderation stopped it. */
export class Blocked extends Error {}

/**
 * Characters for profile pictures, made with OpenAI when there's an API key: GPT designs them from
 * what the user asked for (character.md), turning down anything that isn't fit to draw, gpt-image
 * draws them in a style players can animate (LOOK), and GPT looks at each drawing to check it and
 * say where its eyes, mouth and head are. OpenAI's moderation model checks both what was asked for
 * and what was drawn.
 *
 * Returns null without a key.
 * @param {{apiKey?: string, textModel?: string, imageModel?: string}} opts
 */
export function createOpenAIArtist({
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
    if (data.error?.code === 'moderation_blocked') throw new Blocked(data.error.message);
    if (!res.ok) throw new Error(`OpenAI ${path} failed (${res.status}): ${data.error?.message ?? 'no details'}`);
    return data;
  }

  // GPT's answer to `input`, as JSON in the shape of `schema`.
  async function ask(instructions, input, name, schema, signal) {
    const res = await post('responses', { model: textModel, reasoning: { effort: 'low' }, instructions, input, text: { format: { type: 'json_schema', name, strict: true, schema } } }, signal);
    const text = res.output?.find((o) => o.type === 'message')?.content?.find((c) => c.type === 'output_text')?.text;
    if (!text) throw new Error(`OpenAI wrote no ${name} (${res.status})`);
    return JSON.parse(text);
  }

  const dataUrl = (png) => `data:image/png;base64,${png.toString('base64')}`;

  return {
    name: `${imageModel}, designed and checked by ${textModel}`,
    size: SIZE,

    /** Whether OpenAI's moderation model flags `text`, or a PNG. */
    async flagged(input, { signal = null } = {}) {
      const item = Buffer.isBuffer(input) ? { type: 'image_url', image_url: { url: dataUrl(input) } } : { type: 'text', text: input };
      const res = await post('moderations', { model: 'omni-moderation-latest', input: [item] }, signal);
      return Boolean(res.results?.some((r) => r.flagged));
    },

    /**
     * Three characters for what the user asked for (`prompt`, maybe empty), as descriptions to draw,
     * unless it isn't fit to draw: then `allowed` is false, and `reason` says why, to show them.
     * `about` is who they are, from their profile.
     * @returns {Promise<{allowed: boolean, reason: string, characters: string[]}>}
     */
    async design({ prompt, about, signal = null }) {
      const profile = [about.displayName && `Name: ${about.displayName}`, about.bio && `Bio: ${about.bio}`, about.expertise?.length && `Expertise: ${about.expertise.join(', ')}`].filter(Boolean).join('\n');
      const input = `<profile>\n${profile || '(empty)'}\n</profile>\n<asked_for>\n${prompt || '(nothing)'}\n</asked_for>`;
      const { allowed, reason, characters } = await ask(DESIGN_RULES, input, 'characters', DESIGN_SCHEMA, signal);
      const tidy = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
      return { allowed, reason: tidy(reason), characters: characters.map(tidy).filter(Boolean).slice(0, 3) };
    },

    /** Draws a character (see design) as a PNG, SIZE pixels square. Throws Blocked if the image model won't. */
    async draw(character, { signal = null } = {}) {
      const res = await post('images/generations', { model: imageModel, prompt: `A cartoon character for a profile picture: ${character}\n\n${LOOK}`, size: `${SIZE}x${SIZE}`, quality: 'medium', n: 1 }, signal);
      const image = res.data?.[0]?.b64_json;
      if (!image) throw new Error('OpenAI drew no image');
      return Buffer.from(image, 'base64');
    },

    /**
     * Looks at a drawing (a PNG): whether it's `appropriate`, whether it's `animatable` (and if not,
     * the `problem`), and where its eyes, mouth and head are, each a box [left, top, right, bottom]
     * in its pixels.
     */
    async look(png, { signal = null } = {}) {
      const input = [{ role: 'user', content: [{ type: 'input_image', image_url: dataUrl(png), detail: 'high' }] }];
      return ask(SEEN_RULES, input, 'character', SEEN_SCHEMA, signal);
    },
  };
}
