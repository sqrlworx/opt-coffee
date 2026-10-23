import { execFile, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { mediaDuration } from './broll/index.js';
import { takeCaptions } from './speech/captions.js';

const run = promisify(execFile);
const sleep = promisify(setTimeout);
const FFMPEG_TIMEOUT = 30 * 60_000; // a take is at most 10 minutes; re-encoding it is quicker than that
const TRANSCRIPT_WAIT = 30 * 60_000; // longest a finished join waits for transcripts to burn in
const TRANSCRIPT_POLL = 1000;
const WIDTH = 1280;
const HEIGHT = 720;
// Frames between keyframes in the joined video, two seconds' worth: a seek decodes from the keyframe
// before where it lands, and players play the sound meanwhile, over a frozen picture.
const KEYFRAMES = 60;
const FINISHED = [1920, 1080]; // the size src/finish renders takes at
// The mobile app's copy is upright, so that the phone can fill its upright player with it, or either
// half of it (mobile/src/media/split.js). It's 9:16 when every take is, as the app recorded answers
// before they were 3:4, so they fill the whole player uncropped; otherwise 3:4, as it records them
// now. It's 720 wide, or 1080 from src/finish.
const TALL = 9 / 16;
const UPRIGHT = 3 / 4;
const phoneSize = (width, aspect) => [width, Math.round(width / aspect / 2) * 2];
// The phone's upright player, which shows the middle of the copy that shape (STAGE in
// mobile/src/media/Video.jsx).
const STAGE = 9 / 16;
// Finding a question's sound in a video, by lining up how loud each is over time.
const LOUDNESS_RATE = 8000; // samples per second
const STEP = 0.005; // seconds between loudness measurements
const QUESTION_LATE = [-0.1, 0.5]; // how early or late a question's sound might start in its take, in seconds
const MIN_MATCH = 0.4; // correlation below which it isn't taken as found
// The expert's picture while full-screen b-roll plays on the page, in fractions of the frame's width:
// at the top left and framed like the asker's in the player (.jp-pip in public/styles.css), a 4:3
// crop with rounded corners, a thin white frame and a soft shadow below it. In a video joined before
// the phone had a copy of its own, when all b-roll was cut in this way, the mobile app crops the
// expert back out of it into the top half of its split screen (pipRect in mobile/src/media/split.js).
export const PIP = { width: 0.176, inset: 0.03, radius: 0.0096, ring: 0.0022, blur: 0.009, drop: 0.005 };
const CUT_FADE = 0.3; // seconds the cut to b-roll and back takes
// How far down a take the left half of the page's split screen crops it, without a face to go by: as
// much as can go, it's the top that's cropped off (FOCUS in mobile/src/media/split.js).
const FOCUS = 0.6;

// The expert's picture while full-screen b-roll plays in a frame `width` wide, in pixels: its size,
// the white frame around it, and where that frame's top left corner is.
function pipSize(width) {
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const pw = even(PIP.width * width);
  const ring = Math.max(1, Math.round(PIP.ring * width));
  return { pw, ph: even((pw * 3) / 4), ring, x: Math.round(PIP.inset * width), y: Math.round(PIP.inset * width) };
}

/** Where the expert's picture is while full-screen b-roll plays in a frame `width` wide: [x, y, width, height], inside its white frame. */
export function pipBox(width) {
  const { pw, ph, ring, x, y } = pipSize(width);
  return [x + ring, y + ring, pw, ph];
}

/**
 * An ffmpeg filter graph that cuts away to b-roll from `start` for `length` seconds, over the picture
 * ([`pic`], `width`x`height` at 30 fps), fading in and out. The b-roll ([`broll`], any size or frame
 * rate) goes in a place that depends on `layout`:
 * - 'split', the page's split screen: the expert on the left half, from [`half`] (their take already
 *   filling `width / 2` x `height`, timed like [`pic`]), and the b-roll in the right half;
 * - 'corner', full screen on the page: the b-roll in the frame, and the picture at the top left;
 * - 'alone', full screen in the phone's copy: the b-roll in the middle of the frame that the phone's
 *   upright player shows (STAGE).
 * None of the b-roll is cropped off: it's as big as fits in its place, over a blurred, darker copy of
 * itself filling the rest of it, as src/finish sets a take of another shape (fit_filter in
 * finish.py). Its output, [`out`], is timed like [`pic`]; the labels inside it start with `out`, so
 * cutaways with different outputs go in one graph (see cutawaysFilter).
 *
 * B-roll that runs past `until`, the end of the take (full screen, which the expert let run past the
 * end of their answer), doesn't cut back: the part ends on it. [`pic`] must then be lengthened to
 * `start + length`, by repeating its last frame, and in the corner, the take's picture fades out
 * at `until`.
 */
export function cutawayFilter({ layout = 'corner', width, height, start, length, until = Infinity, pic = 'pic', half = 'half', broll = 'broll', out = 'cut' }) {
  const t = (secs) => String(Math.round(secs * 1000) / 1000);
  // Fading in at `start`, and out again `shown` seconds later unless it doesn't cut back.
  const fadesFor = (shown, back = true) => {
    const fade = Math.min(CUT_FADE, shown / 2);
    return `fade=t=in:st=${t(start)}:d=${t(fade)}:alpha=1${back ? `,fade=t=out:st=${t(start + shown - fade)}:d=${t(fade)}:alpha=1` : ''}`;
  };
  const over = start + length > until;
  const at = `setpts=PTS-STARTPTS+${t(start)}/TB`;
  const fades = fadesFor(length, !over);
  // All of the b-roll in `fw` x `fh` (all of its `w` x `h` place, unless less of that is seen), over
  // the blurred copy filling the place.
  const whole = (w, h, label, [fw, fh] = [w, h]) =>
    [
      `[${broll}]fps=30,trim=duration=${t(length)},${at},setsar=1,split=2[${label}_all][${label}_back]`,
      `[${label}_back]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},gblur=sigma=${Math.round((40 * w) / 1920)},eq=brightness=-0.06:saturation=0.7[${label}_blur]`,
      `[${label}_all]scale=${fw}:${fh}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos[${label}_fit]`,
      `[${label}_blur][${label}_fit]overlay=(W-w)/2:(H-h)/2`,
    ].join(';');
  if (layout === 'split') {
    return [
      `${whole(width / 2, height, out)},format=yuv420p[${out}_broll]`,
      `[${half}]trim=start=${t(start)}:duration=${t(length)},${at},setsar=1,format=yuv420p[${out}_face]`,
      `[${out}_face][${out}_broll]hstack=inputs=2,format=yuva420p,${fades}[${out}_both]`,
      `[${pic}][${out}_both]overlay=0:0:eof_action=pass,format=yuv420p[${out}]`,
    ].join(';');
  }
  if (layout === 'alone') {
    const seen = [Math.min(width, Math.round((height * STAGE) / 2) * 2), height];
    return `${whole(width, height, out, seen)},format=yuva420p,${fades}[${out}_broll];[${pic}][${out}_broll]overlay=0:0:eof_action=pass,format=yuv420p[${out}]`;
  }
  const { pw, ph, ring, x, y } = pipSize(width);
  const [cw, ch] = [pw + 2 * ring, ph + 2 * ring];
  const radius = Math.round(PIP.radius * width);
  const blur = Math.max(1, Math.round(PIP.blur * width));
  // Rounded corners, smoothed over a pixel, as the alpha of an RGBA picture.
  const round = (r) => `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*clip(${r}+0.5-hypot(max(abs(X+0.5-W/2)-(W/2-${r}),0),max(abs(Y+0.5-H/2)-(H/2-${r}),0)),0,1)'`;
  const shown = over ? Math.max(2 * CUT_FADE, until - start) : length; // the take's picture, until the take ends
  return [
    `[${pic}]split=2[${out}_base][${out}_face]`,
    `${whole(width, height, out)},format=yuva420p,${fades}[${out}_broll]`,
    `[${out}_face]trim=start=${t(start)}:duration=${t(shown)},${at},crop=min(iw\\,ih*4/3):min(ih\\,iw*3/4),scale=${pw}:${ph}:flags=lanczos,setsar=1,format=rgba,${round(radius)}[${out}_pic]`,
    `color=white:s=${cw}x${ch}:r=30:d=${t(shown)},${at},format=rgba,${round(radius + ring)}[${out}_card]`,
    `[${out}_card][${out}_pic]overlay=${ring}:${ring}:format=auto,${fadesFor(shown)}[${out}_framed]`,
    `[${out}_framed]split=2[${out}_top][${out}_shade]`,
    `[${out}_shade]colorchannelmixer=rr=0:gg=0:bb=0:aa=0.45,pad=${cw + 6 * blur}:${ch + 6 * blur}:${3 * blur}:${3 * blur}:color=black@0,gblur=sigma=${blur}[${out}_shadow]`,
    `[${out}_base][${out}_broll]overlay=0:0:eof_action=pass[${out}_b]`,
    `[${out}_b][${out}_shadow]overlay=${x - 3 * blur}:${y - 3 * blur + Math.round(PIP.drop * width)}:eof_action=pass[${out}_bs]`,
    `[${out}_bs][${out}_top]overlay=${x}:${y}:eof_action=pass,format=yuv420p[${out}]`,
  ].join(';');
}

/**
 * An ffmpeg filter graph that cuts away to each of `cuts` in turn (see cutawayFilter), which mustn't
 * overlap: from [`pic`] to [`out`], through [`out`0], [`out`1] and so on between them. Each cut has
 * its `layout`, `start`, `length` and `until`, its b-roll (`broll`), and for split screen, the take
 * filling the left half for it (`half`), since each is used once.
 */
export function cutawaysFilter({ cuts, width, height, pic = 'pic', out = 'cut' }) {
  return cuts.map((cut, i) => cutawayFilter({ ...cut, width, height, pic: i ? `${out}${i - 1}` : pic, out: i === cuts.length - 1 ? out : `${out}${i}` })).join(';');
}

// The clip that runs past the end of its take (`until`), lengthening it, if one does: the last.
const overrun = (brolls) => brolls.find((b) => b.start + b.length > (b.until ?? Infinity)) ?? null;

/**
 * Joins answer videos into one with ffmpeg. Each take is re-encoded to the same size, frame rate
 * and codecs first: takes can come from different browsers (MP4 or WebM) and cameras, and the
 * browser's recordings have no reliable durations. The re-encoded parts are then put end to end
 * without re-encoding again.
 *
 * With a `finisher` (src/finish), each take is finished instead of just re-encoded: lit and graded
 * at 1080p, its sound cleaned up, and its captions burned in when it has a transcript. If finishing
 * fails, the takes are joined as recorded.
 *
 * A take with b-roll cuts away to each clip in turn (see cutawayFilter), under the captions: split
 * screen, all of it in the right half beside the take filling the left half, or full screen, all of
 * it in the frame with the take in the corner.
 *
 * The phone gets a copy of its own, made from the same parts: upright (9:16 or 3:4, see TALL), each
 * take filling it, cropped, with full-screen b-roll in it too, all of it where the phone's player
 * shows, but without split-screen b-roll (the phone plays that in the other half of its split
 * screen), and with the captions, if they're burned in, placed for it.
 *
 * Returns null when ffmpeg isn't on the PATH.
 */
export function createVideoJoiner({ finisher = null, log = console.warn } = {}) {
  if (spawnSync('ffmpeg', ['-version']).error || spawnSync('ffprobe', ['-version']).error) {
    log('[video] ffmpeg not found, so published answers are shown one by one instead of as one video');
    return null;
  }
  const ffmpeg = (args) => run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { timeout: FFMPEG_TIMEOUT, maxBuffer: 10_000_000 });
  const probe = async (file, entries) => (await run('ffprobe', ['-v', 'error', '-show_entries', entries, '-of', 'csv=p=0', file])).stdout.trim();

  // The shape of the phone's copy of `takes`, width / height (see TALL).
  async function phoneAspect(takes) {
    const sizes = await Promise.all(takes.map(({ file }) => probe(file, 'stream=width,height').catch(() => '')));
    const tall = sizes.every((size) => {
      const [, width, height] = /(\d+),(\d+)/.exec(size) ?? [];
      return width / height <= TALL + 0.01;
    });
    return tall ? TALL : UPRIGHT;
  }

  // The takes as recorded, brought to the same size, frame rate and codecs, with their b-roll cut
  // in: `parts`, and with `phone`, the size of the phone's copy, also `mobile`, those copies, from
  // the same pass.
  async function reencode(takes, dir, phone) {
    const parts = [];
    const mobile = [];
    for (const [i, { file, brolls = [] }] of takes.entries()) {
      const part = join(dir, `${i}.mp4`);
      const copy = join(dir, `${i}_mobile.mp4`);
      // Every take has sound, but a part without any would break joining, so give it silence.
      const silent = !(await probe(file, 'stream=codec_type')).includes('audio');
      const fit = `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:-1:-1,setsar=1,fps=30,format=yuv420p`;
      const fill = ([w, h], down = 0.5) => `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}:(iw-ow)/2:(ih-oh)*${down},setsar=1,fps=30,format=yuv420p`;
      // The clips are inputs 1, 2 and so on. Split-screen b-roll has the take beside it on the page,
      // filling the left half; full-screen b-roll fills the phone's copy too.
      let halves = 0;
      const cuts = brolls.map((b, j) => ({ layout: b.full ? 'corner' : 'split', start: b.start, length: b.length, until: b.until, broll: `${j + 1}:v`, half: b.full ? null : `half${halves++}` }));
      const phoneCuts = brolls.flatMap((b, j) => (b.full ? [{ layout: 'alone', start: b.start, length: b.length, until: b.until, broll: `${j + 1}:v` }] : []));
      // B-roll that runs past the end of the take lengthens it to where the b-roll ends: its last
      // frame held, under the b-roll, and silence.
      const over = overrun(brolls);
      const end = over ? over.start + over.length : null;
      const hold = over ? `,tpad=stop_mode=clone:stop_duration=${end - over.until + 1}` : '';
      const copies = ['desktop', ...(phone ? ['phone'] : []), ...(halves ? ['face'] : [])];
      const graph = [
        `[0:v]split=${copies.length}${copies.map((c) => `[${c}]`).join('')}`,
        `[desktop]${fit}${hold}${cuts.length ? `[pic];${cutawaysFilter({ cuts, width: WIDTH, height: HEIGHT, out: 'v' })}` : '[v]'}`,
        ...(halves ? [`[face]${fill([WIDTH / 2, HEIGHT], FOCUS)}${halves > 1 ? `,split=${halves}` : ''}${cuts.flatMap((c) => (c.half ? [`[${c.half}]`] : [])).join('')}`] : []),
        ...(phone ? [`[phone]${fill(phone)}${hold}${phoneCuts.length ? `[phonepic];${cutawaysFilter({ cuts: phoneCuts, width: phone[0], height: phone[1], pic: 'phonepic', out: 'vm' })}` : '[vm]'}`] : []),
      ];
      const inputs = ['-i', file, ...brolls.flatMap((b) => ['-i', b.file])];
      const output = (video, to) => [
        '-map', video, '-map', silent ? `${inputs.length / 2}:a` : '0:a:0',
        ...(silent ? ['-shortest'] : []),
        '-af', `aresample=48000:async=1${end ? ',apad' : ''}`,
        ...(end ? ['-t', String(end)] : []),
        '-ac', '2',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-g', String(KEYFRAMES),
        '-c:a', 'aac', '-b:a', '128k',
        to,
      ];
      await ffmpeg([
        ...inputs,
        ...(silent ? ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'] : []),
        '-filter_complex', graph.join(';'),
        ...output('[v]', part),
        ...(phone ? output('[vm]', copy) : []),
      ]);
      parts.push(part);
      mobile.push(copy);
    }
    return { parts, mobile: phone ? mobile : null };
  }

  // How loud `file` is every STEP seconds, in dB, from `start` for `length` seconds (or to its end).
  // Kept within 50 dB of its loudest, so recordings with different noise floors compare.
  async function loudness(file, start = 0, length = null) {
    const { stdout } = await run(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-ss', String(start), ...(length ? ['-t', String(length)] : []), '-i', file, '-vn', '-ac', '1', '-ar', String(LOUDNESS_RATE), '-f', 'f32le', '-'],
      { encoding: 'buffer', timeout: FFMPEG_TIMEOUT, maxBuffer: 100_000_000 },
    );
    const samples = new Float32Array(new Uint8Array(stdout).buffer, 0, stdout.length >> 2);
    const hop = LOUDNESS_RATE * STEP;
    const db = [];
    for (let i = 0; i + hop <= samples.length; i += hop) {
      let sum = 0;
      for (let j = i; j < i + hop; j++) sum += samples[j] * samples[j];
      db.push(10 * Math.log10(sum / hop + 1e-12));
    }
    const floor = db.reduce((max, d) => Math.max(max, d), -Infinity) - 50;
    return db.map((d) => Math.max(d, floor));
  }

  // Where the sound of `question` (its audio file) starts in `video`, in seconds after `start`,
  // where its part starts. `length` is how long it plays for.
  async function findQuestion(video, question, start, length) {
    const from = Math.max(0, start + QUESTION_LATE[0]);
    const [heard, played] = await Promise.all([loudness(question), loudness(video, from, length + QUESTION_LATE[1] - QUESTION_LATE[0])]);
    const zero = Math.round((start - from) / STEP); // where the part starts in `played`
    let best = { at: 0, match: MIN_MATCH };
    for (let lag = Math.round(QUESTION_LATE[0] / STEP); lag <= Math.round(QUESTION_LATE[1] / STEP); lag++) {
      const match = zero + lag >= 0 ? correlation(heard, played, zero + lag) : null;
      if (match > best.match) best = { at: lag * STEP, match };
    }
    return best.at;
  }

  // The takes finished, or null if that failed: `parts`, and with `phone`, the size of the phone's
  // copy, also `mobile`, those copies, from the same pass; and `focus`, for each take, where the
  // phone's halves crop the expert's picture and the asker's video to frame their faces.
  async function finish(takes, dir, phone) {
    const parts = takes.map((_, i) => join(dir, `finished_${i}.mp4`));
    const mobile = phone ? takes.map((_, i) => join(dir, `finished_${i}_mobile.mp4`)) : null;
    try {
      // The b-roll is cut in over the finished picture, its clips as inputs 2, 3 and so on (see
      // src/finish/finish.py): split screen beside the take, which the finisher fills the left half
      // with for each clip ([half0], [half1] and so on, while it plays: `halves`), or full screen, also
      // in the phone's copy ([phonepic] to [phonecut]). The finisher lengthens a take whose b-roll
      // runs past its end, to `end`.
      const cutaways = (brolls) => {
        if (!brolls?.length) return null;
        let halves = 0;
        const cuts = brolls.map((b, i) => ({ layout: b.full ? 'corner' : 'split', start: b.start, length: b.length, until: b.until, broll: `${i + 2}:v`, half: b.full ? null : `half${halves++}` }));
        const phoneCuts = brolls.flatMap((b, i) => (b.full ? [{ layout: 'alone', start: b.start, length: b.length, until: b.until, broll: `${i + 2}:v` }] : []));
        const over = overrun(brolls);
        return {
          inputs: brolls.map((b) => b.file),
          filter: cutawaysFilter({ cuts, width: FINISHED[0], height: FINISHED[1] }),
          mobile_filter: phone && phoneCuts.length ? cutawaysFilter({ cuts: phoneCuts, width: phone[0], height: phone[1], pic: 'phonepic', out: 'phonecut' }) : null,
          halves: brolls.filter((b) => !b.full).map((b) => [b.start, b.length]),
          end: over ? over.start + over.length : null,
        };
      };
      const report = await finisher.finish(
        takes.map((t, i) => ({
          input: t.file,
          output: parts[i],
          mobile_output: mobile?.[i] ?? null,
          mobile_size: phone,
          asker_video: t.askerVideo ?? null,
          answer_start: t.answerStart ?? null,
          cues: t.cues ?? null,
          words: t.words ?? null,
          cutaways: cutaways(t.brolls),
        })),
        dir,
      );
      return { parts, mobile, focus: takes.map((_, i) => [report?.takes?.[i]?.expert_focus ?? null, report?.takes?.[i]?.asker_focus ?? null]) };
    } catch (err) {
      log(`[video] finishing failed, so the takes are joined as recorded: ${err.message}`);
      return null;
    }
  }

  return {
    /** Whether takes are finished, with their captions burned in: worth waiting for transcripts. */
    finishing: Boolean(finisher),

    /**
     * Writes the takes, in order, into one MP4 at `out`, and the phone's copy at `mobileOut` if
     * given. A take is a file name, or {file, answerStart, cues, words, brolls, askerVideo} with what
     * finishing uses: where the answer starts after the question, and the transcript's cues and word
     * timings; b-roll to cut away to, clips that don't overlap, in the order they play, each {file,
     * start, length, full, pastEnd}, split screen unless it's `full` screen, and with `pastEnd`,
     * lengthening the take if it runs past its end; and the asker's video, to find their face.
     * @returns {Promise<{durations: number[], captioned: boolean[], mobile: boolean, focus: (number|null)[][]}>}
     *   how long each part is in the result, in seconds, whether its captions are burned in, whether
     *   the phone's copy was written (the same parts, so the same durations), and for each part,
     *   [expert, asker]: where the phone's halves crop the expert's picture in that copy and the
     *   asker's video to frame their faces, as CSS's object-position (0-1 down), when finished
     */
    async join(takes, out, mobileOut = null) {
      const dir = mkdtempSync(join(tmpdir(), 'forum_join_'));
      // The concat demuxer starts each part where the previous one ends, by its duration.
      const concat = async (parts, file) => {
        const list = join(dir, 'parts.txt');
        writeFileSync(list, parts.map((p) => `file '${p}'\n`).join(''));
        await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', `${file}.part`]);
        await rename(`${file}.part`, file);
      };
      try {
        takes = takes.map((t) => (typeof t === 'string' ? { file: t } : t));
        // B-roll allowed past the end of its take lengthens the take if it does run past: by how
        // much depends on how long the take is.
        for (const [i, t] of takes.entries()) {
          const brolls = [...(t.brolls ?? [])].sort((a, b) => a.start - b.start);
          const until = brolls.some((b) => b.pastEnd) ? await mediaDuration(t.file) : undefined;
          takes[i] = { ...t, brolls: brolls.map((b) => (b.pastEnd ? { ...b, until } : b)) };
        }
        const aspect = mobileOut ? await phoneAspect(takes) : null;
        const finished = finisher ? await finish(takes, dir, aspect && phoneSize(1080, aspect)) : null;
        const { parts, mobile, focus = takes.map(() => [null, null]) } = finished ?? (await reencode(takes, dir, aspect && phoneSize(720, aspect)));
        const durations = [];
        for (const part of parts) durations.push(Number(await probe(part, 'format=duration')));
        const captioned = takes.map((t) => Boolean(finished && t.cues?.length));
        await concat(parts, out);
        if (mobile) await concat(mobile, mobileOut);
        return { durations, captioned, mobile: Boolean(mobile), focus };
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(`${out}.part`, { force: true });
        if (mobileOut) rmSync(`${mobileOut}.part`, { force: true });
      }
    },

    /**
     * Where each question's sound starts in joined `video`, in seconds into its part: a take
     * records the question a little late (the browser's audio latency), and joining can shift it
     * further. `questions` are {audio, start, length}: the question's audio file, where its part
     * starts in the video, and how long the question plays for there. 0 for a part without a
     * question, or where it can't be found.
     * @returns {Promise<number[]>}
     */
    async locate(video, questions) {
      const found = [];
      for (const { audio, start, length } of questions) {
        try {
          found.push(audio && length ? await findQuestion(video, audio, start, length) : 0);
        } catch (err) {
          log(`[video] finding a question in ${video} failed: ${err.message}`);
          found.push(0);
        }
      }
      return found;
    },

    /**
     * Writes the asker's video `file` to `out` as players load it: an MP4 with its duration and
     * index up front and a keyframe every second, so a player can start anywhere in it right away.
     * Browsers record without a duration or an index, so a player has to read to the end of the
     * recording to find how long it is before it can show a moment in it, which keeps the asker's
     * picture black for seconds after skipping to their question. The size and the sound are kept.
     */
    async seekable(file, out) {
      try {
        await ffmpeg([
          '-i', file, '-map', '0:v:0', '-map', '0:a:0?',
          '-vf', 'crop=trunc(iw/2)*2:trunc(ih/2)*2', '-fpsmax', '30', // H.264 needs an even size; the page records 1215×1080
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-force_key_frames', 'expr:gte(t,n_forced)',
          '-c:a', 'aac', '-b:a', '96k',
          '-movflags', '+faststart', '-f', 'mp4', `${out}.part`,
        ]);
        await rename(`${out}.part`, out);
      } finally {
        rmSync(`${out}.part`, { force: true });
      }
    },

    /** Whether `file` is taller than wide, as the phone's copy is; false if it can't be read. */
    async upright(file) {
      try {
        const [, width, height] = /(\d+),(\d+)/.exec(await probe(file, 'stream=width,height')).map(Number);
        return height > width;
      } catch {
        return false;
      }
    },
  };
}

// The correlation of `a` with `b` from `offset` on, over as much as they overlap; null if that's
// under half a second, or either is flat.
function correlation(a, b, offset) {
  const n = Math.min(a.length, b.length - offset);
  if (n < 0.5 / STEP) return null;
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[offset + i];
    sa += x;
    sb += y;
    saa += x * x;
    sbb += y * y;
    sab += x * y;
  }
  const va = saa - (sa * sa) / n;
  const vb = sbb - (sb * sb) / n;
  return va > 0 && vb > 0 ? (sab - (sa * sb) / n) / Math.sqrt(va * vb) : null;
}

/**
 * Background work joining each published office hour's answers into one video, one at a time.
 * Progress lives in the database (office_hours.video_status), so `resume()` at startup picks up
 * anything pending, or published before joining existed. It also finds the questions in videos
 * joined before that was done (see joiner.locate), and joins again those whose phone's copy is from
 * before it was upright (see joiner.upright), or framed the expert's face.
 *
 * Before joining, each published question asked on camera gets a copy of the asker's video that
 * players can seek in (see joiner.seekable), and on startup, so do those published before that.
 *
 * When the joiner finishes takes, joining waits for transcripts still being made, so captions can
 * be burned in, and `refresh()` makes the video again after a transcript is corrected.
 */
export function createVideoJobs({ db, joiner, mediaDir, log = console.error, transcriptWait = TRANSCRIPT_WAIT }) {
  let tail = Promise.resolve();
  const enqueue = (job) => {
    tail = tail.then(job).catch((err) => log(err));
  };
  const refreshing = new Set();

  // The answers' transcripts, by video, once none is still being made (or the wait runs out).
  async function transcripts(videos) {
    const marks = videos.map(() => '?').join(', ');
    const pending = db.prepare(`SELECT 1 FROM transcripts WHERE status = 'pending' AND media IN (${marks})`);
    for (const until = Date.now() + transcriptWait; pending.get(...videos) && Date.now() < until; ) await sleep(TRANSCRIPT_POLL);
    const rows = db.prepare(`SELECT media, cues, words FROM transcripts WHERE status = 'ready' AND media IN (${marks})`).all(...videos);
    return new Map(rows.map((r) => [r.media, { cues: JSON.parse(r.cues), words: r.words ? JSON.parse(r.words) : null }]));
  }

  // Joins the answers into a new file. A first join publishes it or marks joining failed; a remake
  // replaces the current video only once the new one is ready.
  async function render(officeHourId, { remake = false } = {}) {
    const answers = db
      .prepare(
        `SELECT id, body, asked_with AS askedWith, audio, asker_video AS askerVideo, published_answer_video AS video, published_answer_start AS answerStart
         FROM questions WHERE office_hour_id = ? AND published_position IS NOT NULL ORDER BY published_position`,
      )
      .all(officeHourId);
    const name = `${randomBytes(16).toString('hex')}.mp4`;
    const mobileName = `${randomBytes(16).toString('hex')}.mp4`; // the phone's copy
    try {
      if (!answers.length) throw new Error('nothing was published');
      // The question at the start of each take is captioned as it was asked: a spoken one from its own transcript.
      const spoken = answers.filter((a) => a.askedWith === 'audio').map((a) => a.audio);
      const texts = joiner.finishing ? await transcripts([...answers.map((a) => a.video), ...spoken]) : new Map();
      const clips = db.prepare('SELECT * FROM brolls WHERE question_id = ? AND published = 1 ORDER BY start');
      const takes = answers.map((a) => {
        const take = texts.get(a.video);
        const asked = { body: a.body, ...(a.askedWith === 'audio' ? texts.get(a.audio) : null) };
        const brolls = clips.all(a.id).map((b) => ({ file: join(mediaDir, b.video), start: b.start, length: b.length, full: Boolean(b.full), pastEnd: Boolean(b.past_end) }));
        const askerVideo = a.askerVideo && join(mediaDir, a.askerVideo);
        return { file: join(mediaDir, a.video), answerStart: a.answerStart, brolls, askerVideo, ...(take && takeCaptions(asked, take, a.answerStart)) };
      });
      const { durations, captioned, mobile, focus = [] } = await joiner.join(takes, join(mediaDir, name), join(mediaDir, mobileName));
      // Where each answer starts and ends in the joined video, where its question's sound starts in
      // it, and where the phone's halves crop the expert and the asker to frame their faces:
      // [question id, start, end, captions burned in, question start, expert, asker], in seconds,
      // then as CSS's object-position (0-1 down), or null.
      let at = 0;
      const spans = durations.map((d) => [at, (at += d)]);
      const heard = await joiner.locate(join(mediaDir, name), questionsIn(answers, spans));
      const chapters = answers.map((a, i) => [a.id, round(spans[i][0]), round(spans[i][1]), captioned[i] ? 1 : 0, round(heard[i]), focus[i]?.[0] ?? null, focus[i]?.[1] ?? null]);
      const old = db.prepare('SELECT video, video_mobile FROM office_hours WHERE id = ?').get(officeHourId);
      db.prepare("UPDATE office_hours SET video = ?, video_mobile = ?, video_status = 'ready', video_chapters = ? WHERE id = ?").run(name, mobile ? mobileName : null, JSON.stringify(chapters), officeHourId);
      for (const file of [old?.video, old?.video_mobile]) if (file) rmSync(join(mediaDir, file), { force: true });
    } catch (err) {
      for (const file of [name, mobileName]) rmSync(join(mediaDir, file), { force: true });
      if (!remake) db.prepare("UPDATE office_hours SET video_status = 'failed' WHERE id = ?").run(officeHourId);
      log(`[video] ${remake ? 'remaking the video' : 'joining the answers'} of office hour ${officeHourId} failed: ${err.message}`);
    }
  }

  // What joiner.locate looks for: each answer's question, played from where its part `spans` start.
  const questionsIn = (answers, spans) => answers.map((a, i) => ({ audio: a.audio && join(mediaDir, a.audio), start: spans[i][0], length: a.answerStart }));

  /** Queues finding where the questions' sound starts in a video joined before that was done. */
  function relocate(officeHourId) {
    enqueue(async () => {
      const oh = db.prepare("SELECT video, video_chapters FROM office_hours WHERE id = ? AND video_status = 'ready'").get(officeHourId);
      if (!oh) return;
      const chapters = JSON.parse(oh.video_chapters);
      const answers = new Map(db.prepare('SELECT id, audio, published_answer_start AS answerStart FROM questions WHERE office_hour_id = ?').all(officeHourId).map((a) => [a.id, a]));
      const heard = await joiner.locate(join(mediaDir, oh.video), questionsIn(chapters.map(([id]) => answers.get(id) ?? {}), chapters.map(([, start, end]) => [start, end])));
      const located = chapters.map((c, i) => [...c.slice(0, 4), round(heard[i]), ...c.slice(5)]);
      db.prepare('UPDATE office_hours SET video_chapters = ? WHERE id = ? AND video = ?').run(JSON.stringify(located), officeHourId, oh.video);
    });
  }

  // Copies the askers' videos of the published questions asked on camera that have none yet, of
  // `officeHourId` or of every office hour, for players to load instead (see joiner.seekable). The
  // recordings are kept, for finishing to find the askers' faces in. One that fails is played as
  // recorded, and tried again on the next startup.
  async function copyAskerVideos(officeHourId = null) {
    if (!joiner.seekable) return;
    const rows = db
      .prepare(`SELECT id, asker_video FROM questions WHERE asker_video IS NOT NULL AND asker_video_copy IS NULL AND published_position IS NOT NULL${officeHourId == null ? '' : ' AND office_hour_id = ?'}`)
      .all(...(officeHourId == null ? [] : [officeHourId]));
    for (const q of rows) {
      const name = `${randomBytes(16).toString('hex')}.mp4`;
      try {
        await joiner.seekable(join(mediaDir, q.asker_video), join(mediaDir, name));
        db.prepare('UPDATE questions SET asker_video_copy = ? WHERE id = ?').run(name, q.id);
      } catch (err) {
        rmSync(join(mediaDir, name), { force: true });
        log(`[video] copying the asker's video of question ${q.id} failed, so players load it as recorded: ${err.message}`);
      }
    }
  }

  /** Queues joining a published office hour's answers, in their published order, after copying its askers' videos. */
  function joinAnswers(officeHourId) {
    db.prepare("UPDATE office_hours SET video_status = 'pending' WHERE id = ?").run(officeHourId);
    enqueue(() => copyAskerVideos(officeHourId));
    enqueue(() => render(officeHourId));
  }

  /**
   * Queues making a published office hour's video again, after one of its transcripts was
   * corrected, when its captions are burned in. One remake picks up every correction made before
   * it starts; until it's done, readers keep the current video.
   */
  function refresh(officeHourId) {
    if (!joiner.finishing || refreshing.has(officeHourId)) return;
    refreshing.add(officeHourId);
    enqueue(async () => {
      refreshing.delete(officeHourId);
      const oh = db.prepare('SELECT video_status, video_chapters FROM office_hours WHERE id = ?').get(officeHourId);
      if (oh?.video_status === 'ready' && JSON.parse(oh.video_chapters).some((c) => c[3])) await render(officeHourId, { remake: true });
    });
  }

  /**
   * Queues making a published office hour's video again if its copy for phones is out of date: not
   * upright (or missing), from before it was, or with captions burned in before they went under the
   * expert, framed to their face. Until then, readers keep the current one.
   */
  function refreshPhoneCopy(officeHourId) {
    enqueue(async () => {
      const oh = db.prepare("SELECT video_mobile, video_chapters FROM office_hours WHERE id = ? AND video_status = 'ready'").get(officeHourId);
      if (!oh) return;
      const unframed = joiner.finishing && JSON.parse(oh.video_chapters).some((c) => c[3] && c.length < 7);
      if (unframed || !(oh.video_mobile && (await joiner.upright(join(mediaDir, oh.video_mobile))))) await render(officeHourId, { remake: true });
    });
  }

  function resume() {
    const waiting = db.prepare("SELECT id FROM office_hours WHERE published_at IS NOT NULL AND (video_status IS NULL OR video_status = 'pending')").all();
    waiting.forEach((oh) => joinAnswers(oh.id));
    enqueue(() => copyAskerVideos()); // published before they were copied
    const joined = db.prepare("SELECT id, video_chapters FROM office_hours WHERE video_status = 'ready'").all();
    joined.filter((oh) => JSON.parse(oh.video_chapters).some((c) => c.length < 5)).forEach((oh) => relocate(oh.id));
    if (joiner.upright) joined.forEach((oh) => refreshPhoneCopy(oh.id));
  }

  return {
    join: joinAnswers,
    refresh,
    resume,
    /** Resolves once every queued job, including ones queued meanwhile, has finished. */
    async idle() {
      let seen;
      do {
        seen = tail;
        await seen;
      } while (seen !== tail);
    },
  };
}

const round = (secs) => Math.round(secs * 1000) / 1000;
