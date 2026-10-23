import { spawnSync } from 'node:child_process';
import { Blocked, createOpenAIArtist } from './openai.js';
import { PICTURE_SIZE, readPng, rig, toWebp } from './rig.js';

const TRIES = 3; // drawings of each character, at most, until one can be animated
const NOT_FIT = "That isn't something we can draw. Try describing a different character.";
const NOT_ANIMATABLE = "Couldn't draw that as a character whose face can talk. Try describing it a little differently.";

/** What the user asked for isn't fit to draw. Its message is for them. */
export class Refused extends Error {}

/**
 * Characters people make for their profile picture, which say their questions in the joined video
 * as the fox does (public/fox.js). An artist (src/avatar/openai.js) designs three from what they ask
 * for, draws them and looks at each drawing; rig.js then finds each one's eyes and mouth, paints them
 * out, and says where players draw them. A drawing that's flagged, or can't be animated, is drawn
 * again.
 *
 * Returns null without an artist (an OpenAI API key), or without ffmpeg able to write WebP.
 * @param {{artist?: object|null, log?: (msg: string) => void}} opts
 */
export function createAvatars({ artist = createOpenAIArtist(), log = console.warn } = {}) {
  if (!artist) {
    log("[avatar] no OpenAI API key, so people can't make characters for their profile pictures");
    return null;
  }
  const encoders = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  if (encoders.error || !/\blibwebp\b/.test(encoders.stdout)) {
    log("[avatar] ffmpeg (with libwebp) not found, so people can't make characters for their profile pictures");
    return null;
  }

  // One of the characters, drawn until it can be animated: its profile picture and the picture
  // players animate (both WebP), and its rig. Null if none of the drawings would do; `tally` counts
  // those turned down as unfit (`blocked`), and those that couldn't be animated (`stiff`).
  async function drawn(character, tally, signal) {
    for (let i = 0; i < TRIES; i++) {
      signal?.throwIfAborted();
      try {
        const png = await artist.draw(character, { signal });
        const [flagged, seen] = await Promise.all([artist.flagged(png, { signal }), artist.look(png, { signal })]);
        if (flagged || !seen.appropriate) {
          tally.blocked++;
          continue;
        }
        if (!seen.animatable) {
          tally.stiff++;
          log(`[avatar] drew a character that can't be animated (${seen.problem}), so drawing it again`);
          continue;
        }
        const img = await readPng(png);
        const original = { ...img, data: img.data.slice() };
        const rigged = rig(img, seen);
        if (!rigged) {
          tally.stiff++;
          log("[avatar] couldn't find a drawn character's eyes and mouth, so drawing it again");
          continue;
        }
        const [picture, base] = await Promise.all([toWebp(original, { crop: rigged.picture, size: PICTURE_SIZE }), toWebp(img)]);
        return { character, picture, base, rig: rigged.rig };
      } catch (err) {
        if (signal?.aborted) throw err;
        if (err instanceof Blocked) tally.blocked++;
        else log(`[avatar] drawing a character failed: ${err.message}`);
      }
    }
    return null;
  }

  return {
    name: artist.name,

    /**
     * Up to three characters for what the user asked for (`prompt`, maybe empty) and who they are
     * (`about`: displayName, bio and expertise), each {character, picture, base, rig}: what it was
     * drawn from, its profile picture and the picture players animate (WebP buffers), and its rig
     * (see rig.js). Throws Refused when it isn't fit to draw.
     */
    async make({ prompt, about, signal = null }) {
      if (prompt && (await artist.flagged(prompt, { signal }))) throw new Refused(NOT_FIT);
      const design = await artist.design({ prompt, about, signal });
      if (!design.allowed) throw new Refused(design.reason || NOT_FIT);
      if (!design.characters.length) throw new Error('no characters were designed');
      const tally = { blocked: 0, stiff: 0 };
      const options = (await Promise.all(design.characters.map((c) => drawn(c, tally, signal)))).filter(Boolean);
      if (options.length) return options;
      if (tally.blocked) throw new Refused(NOT_FIT);
      if (tally.stiff) throw new Refused(NOT_ANIMATABLE);
      throw new Error('none of the characters could be drawn');
    },
  };
}
