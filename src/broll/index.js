import { execFile, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createGemini } from './gemini.js';
import { createOpenAIPlanner } from './openai.js';

const SCRIPT = fileURLToPath(new URL('./broll.py', import.meta.url));
// Made locally, the first run installs the dependencies and downloads the models (about 42 GB);
// after that a clip takes a few minutes on a large CPU, longer on a small one.
const TIMEOUT = 2 * 60 * 60_000;
const PROBE_TIMEOUT = 60_000;
const PREPARE_TIMEOUT = 10 * 60_000; // getting an uploaded clip ready: seconds, or minutes for a long one in 4K
const LOCAL_MAX = 5; // seconds of b-roll made locally, at most: a few minutes on a large CPU
const UPLOAD_SIZE = 1920; // pixels on its longest side, at most, of an uploaded clip once it's ready: the finished video's width
const UPLOAD_FPS = 30; // and frames a second, the joined video's
const HDR = new Set(['smpte2084', 'arib-std-b67']); // PQ and HLG, as phones film by default
// HDR brought into ordinary range, so it isn't washed out: linearised, its highlights rolled off
// (mobius keeps the rest as it was, so it isn't darkened), and converted to BT.709.
const TO_SDR = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=mobius:desat=0,zscale=t=bt709:m=bt709:r=tv';
const run = promisify(execFile);

/**
 * B-roll for answers: a short clip made from the expert's description of it, written up as a
 * concrete shot first (an idea can't be filmed as it is), or one the expert uploads. One clip at a
 * time is made (see jobs.js).
 *
 * - Filming: with a Gemini API key, Veo films it (src/broll/gemini.js). Otherwise, or if Veo
 *   can't (out of quota, filtered, down), src/broll/broll.py does, run with uv: LTX-Video on the
 *   CPU, each clip in its own process so the models' memory is given back between clips.
 * - Writing up the shot: with an OpenAI API key, GPT (the `planner`, src/broll/openai.js), which
 *   also has gpt-image draw a first frame for LTX-Video to animate; else Gemini; else broll.py
 *   does it with Qwen3. If GPT or Gemini fails, the next one down does it.
 * - Uploaded clips only need ffmpeg (see prepareUpload).
 *
 * Returns null when b-roll is off: `off`, or `auto` without ffmpeg. With neither a Gemini key nor
 * uv on the PATH, clips can only be uploaded: `generate` is null.
 * @param {{mode?: 'auto'|'on'|'off', planner?: object|null, gemini?: object|null, log?: (msg: string) => void}} opts
 */
export function createBroll({ mode = process.env.FORUM_BROLL ?? 'auto', planner = createOpenAIPlanner(), gemini = createGemini(), log = console.warn } = {}) {
  if (mode === 'off') return null;
  const has = (tool) => !spawnSync(tool, ['-version']).error;
  const local = mode === 'on' || has('uv');
  const uploads = {
    /** Makes a video the expert uploaded into a clip (see prepareUpload). */
    prepare: prepareUpload,
    /** How long a recording is, in seconds. */
    duration: mediaDuration,
  };
  if (mode === 'auto') {
    const missing = ['ffmpeg', 'ffprobe'].filter((tool) => !has(tool));
    if (missing.length) {
      log(`[broll] ${missing.join(' and ')} not found, so experts can't add b-roll to their answers`);
      return null;
    }
    if (!(local || gemini)) {
      log("[broll] no Gemini API key, and uv not found, so experts can upload b-roll but it can't be made for them");
      return { name: 'uploaded only', generate: null, ...uploads };
    }
  }
  const writer = planner ?? gemini;
  const filmedBy = gemini ? `${gemini.videoName}${local ? ', or ltx-video 2b locally' : ''}` : 'ltx-video 2b';

  return {
    name: `${filmedBy}, shots written by ${planner?.name ?? gemini?.textName ?? 'qwen3 8b'}`,
    /** The model that films clips, as the planner names it: Veo's, else LTX-Video locally. */
    model: gemini?.videoName ?? 'LTX-Video 2B',
    /** The longest clip it makes. */
    maxSeconds: gemini?.maxSeconds ?? LOCAL_MAX,

    /**
     * Makes a clip of `prompt` at least `seconds` long (it may come out a little longer), as an MP4
     * at `out`. The `question` and the `answer` (its transcript), if known, help pick the shot.
     * Aborting `signal` stops it.
     * @returns {Promise<{seconds: number, shot: string}>} how long it is, and the shot that was filmed
     */
    async generate(prompt, out, { seconds, question = null, answer = null, seed = Math.floor(Math.random() * 2 ** 31), signal = null }) {
      let plan = null;
      if (writer) {
        try {
          plan = await writer.plan({ prompt, question, answer, signal });
        } catch (err) {
          if (signal?.aborted) throw err;
          log(`[broll] writing up the shot with ${planner?.name ?? gemini.textName} failed, so ${gemini ? 'the description is filmed as it is' : "it's written up locally"}: ${err.message}`);
        }
      }
      if (gemini) {
        const shot = plan?.shot ?? prompt;
        try {
          return { ...(await gemini.film(shot, out, { seconds, signal })), shot };
        } catch (err) {
          if (signal?.aborted || !local) throw err;
          log(`[broll] Veo couldn't film it, so it's filmed locally: ${err.message}`);
        }
      }
      return filmLocally(prompt, out, { seconds, seed, question, answer, shot: plan?.shot ?? null, frame: plan?.frame ?? null, signal });
    },

    ...uploads,
  };

  // LTX-Video, with broll.py: from a first frame drawn for the shot when the planner can draw one.
  async function filmLocally(prompt, out, { seconds, seed, question, answer, shot, frame, signal }) {
    const dir = mkdtempSync(join(tmpdir(), 'forum_broll_'));
    const job = join(dir, 'broll.json');
    let image = null;
    if (frame && planner?.draw) {
      try {
        image = join(dir, 'frame.png');
        await planner.draw(frame, image, { signal });
      } catch (err) {
        if (signal?.aborted) {
          rmSync(dir, { recursive: true, force: true });
          throw err;
        }
        log(`[broll] drawing the first frame failed, so it's filmed without one: ${err.message}`);
        image = null;
      }
    }
    writeFileSync(job, JSON.stringify({ prompt, out, seconds, seed, question, answer, shot, image }));
    return new Promise((resolve, reject) => {
      const child = spawn('uv', ['run', '--quiet', SCRIPT, job], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let tail = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => {
        process.stderr.write(d); // its progress, in the server's log
        tail = (tail + d).slice(-4000);
      });
      const timer = setTimeout(() => child.kill(), TIMEOUT);
      const stop = () => child.kill();
      signal?.addEventListener('abort', stop, { once: true });
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
        rmSync(dir, { recursive: true, force: true });
      };
      child.on('error', (err) => {
        done();
        reject(new Error(`Couldn't start making b-roll: ${err.message}`));
      });
      child.on('close', (code, signal) => {
        done();
        if (code !== 0) return reject(new Error(`making b-roll exited (${signal ?? code}): ${tail.trim().split('\n').at(-1) ?? ''}`));
        try {
          resolve(JSON.parse(stdout.trim().split('\n').at(-1)));
        } catch {
          reject(new Error("making b-roll didn't report the clip"));
        }
      });
    });
  }
}

/**
 * Makes a video the expert uploaded as b-roll (`src`: anything ffmpeg reads, like a phone's MOV)
 * into a clip like the ones that are made, at `out`: an H.264 MP4 that every browser plays, of its
 * first `seconds` at most, no bigger than 1080p at 30 fps, in ordinary range (HDR is tone mapped),
 * and without its sound (the answer's carries on over b-roll) or metadata (a phone's says where it
 * was filmed).
 * @returns {Promise<{seconds: number, original: number|null}>} how long the clip is, and how long the
 *   upload was, if it says
 */
export async function prepareUpload(src, out, { seconds }) {
  // `V`: video, not a cover picture, which an audio file can have.
  const { streams = [], format = {} } = JSON.parse(
    (await run('ffprobe', ['-v', 'error', '-select_streams', 'V', '-show_entries', 'stream=color_transfer:format=duration', '-of', 'json', src], { timeout: PROBE_TIMEOUT })).stdout,
  );
  if (!streams.length) throw new Error(`${src} has no video`);
  const part = `${out}.part`;
  const encode = (tonemap) =>
    run('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error', '-i', src,
      '-map', '0:V:0', '-t', String(seconds), '-an', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
      '-vf', [`scale='min(iw,${UPLOAD_SIZE})':'min(ih,${UPLOAD_SIZE})':force_original_aspect_ratio=decrease:force_divisible_by=2`, ...(tonemap ? [TO_SDR] : []), 'format=yuv420p'].join(','),
      '-fpsmax', String(UPLOAD_FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-movflags', '+faststart', '-f', 'mp4', part,
    ], { timeout: PREPARE_TIMEOUT, maxBuffer: 10_000_000 });
  try {
    const hdr = HDR.has(streams[0].color_transfer);
    try {
      await encode(hdr);
    } catch (err) {
      if (!hdr) throw err;
      await encode(false); // an ffmpeg without zscale: kept in its own range, then
    }
    renameSync(part, out);
  } catch (err) {
    rmSync(part, { force: true });
    throw err;
  }
  const original = Number(format.duration);
  return { seconds: await mediaDuration(out), original: original > 0 ? original : null };
}

/**
 * How long a recording is, in seconds. The browser's recordings often don't say (WebM from
 * MediaRecorder has no duration in its header), so it's taken from the last packet then.
 */
export async function mediaDuration(file) {
  const probe = async (...args) => (await run('ffprobe', ['-v', 'error', ...args, '-of', 'csv=p=0', file], { timeout: PROBE_TIMEOUT, maxBuffer: 50_000_000 })).stdout;
  const stated = Number((await probe('-show_entries', 'format=duration')).trim());
  if (Number.isFinite(stated) && stated > 0) return stated;
  const ends = (await probe('-show_entries', 'packet=pts_time,duration_time'))
    .split('\n')
    .map((line) => line.split(',').map(Number))
    .filter(([pts]) => Number.isFinite(pts))
    .map(([pts, length]) => pts + (Number.isFinite(length) ? length : 0));
  if (!ends.length) throw new Error(`${file} has no packets`);
  return Math.max(...ends);
}
