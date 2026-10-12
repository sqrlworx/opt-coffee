import { execFile, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { takeCaptions } from './speech/captions.js';

const run = promisify(execFile);
const sleep = promisify(setTimeout);
const FFMPEG_TIMEOUT = 30 * 60_000; // a take is at most 10 minutes; re-encoding it is quicker than that
const TRANSCRIPT_WAIT = 30 * 60_000; // longest a finished join waits for transcripts to burn in
const TRANSCRIPT_POLL = 1000;
const WIDTH = 1280;
const HEIGHT = 720;
// Finding a question's sound in a video, by lining up how loud each is over time.
const LOUDNESS_RATE = 8000; // samples per second
const STEP = 0.005; // seconds between loudness measurements
const QUESTION_LATE = [-0.1, 0.5]; // how early or late a question's sound might start in its take, in seconds
const MIN_MATCH = 0.4; // correlation below which it isn't taken as found

/**
 * Joins answer videos into one with ffmpeg. Each take is re-encoded to the same size, frame rate
 * and codecs first: takes can come from different browsers (MP4 or WebM) and cameras, and the
 * browser's recordings have no reliable durations. The re-encoded parts are then put end to end
 * without re-encoding again.
 *
 * With a `finisher` (src/finish), each take is finished instead of just re-encoded: lit and graded
 * at 1080p, its sound cleaned up, and its captions burned in when it has a transcript. If that
 * fails, the takes are joined as recorded.
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

  // The takes as recorded, brought to the same size, frame rate and codecs.
  async function reencode(takes, dir) {
    const parts = [];
    for (const [i, { file }] of takes.entries()) {
      const part = join(dir, `${i}.mp4`);
      // Every take has sound, but a part without any would break joining, so give it silence.
      const silent = !(await probe(file, 'stream=codec_type')).includes('audio');
      await ffmpeg([
        '-i', file,
        ...(silent ? ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-shortest'] : []),
        '-vf', `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:-1:-1,setsar=1,fps=30,format=yuv420p`,
        '-af', 'aresample=48000:async=1',
        '-ac', '2',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k',
        part,
      ]);
      parts.push(part);
    }
    return parts;
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

  // The takes finished, or null if that failed.
  async function finish(takes, dir) {
    const parts = takes.map((_, i) => join(dir, `finished_${i}.mp4`));
    try {
      await finisher.finish(
        takes.map((t, i) => ({ input: t.file, output: parts[i], answer_start: t.answerStart ?? null, cues: t.cues ?? null, words: t.words ?? null })),
        dir,
      );
      return parts;
    } catch (err) {
      log(`[video] finishing failed, so the takes are joined as recorded: ${err.message}`);
      return null;
    }
  }

  return {
    /** Whether takes are finished, with their captions burned in: worth waiting for transcripts. */
    finishing: Boolean(finisher),

    /**
     * Writes the takes, in order, into one MP4 at `out`. A take is a file name, or
     * {file, answerStart, cues, words} with what finishing uses: where the answer starts after the
     * question, and the transcript's cues and word timings.
     * @returns {Promise<{durations: number[], captioned: boolean[]}>} how long each part is in the
     *   result, in seconds, and whether its captions are burned in
     */
    async join(takes, out) {
      const dir = mkdtempSync(join(tmpdir(), 'forum_join_'));
      try {
        takes = takes.map((t) => (typeof t === 'string' ? { file: t } : t));
        const finished = finisher ? await finish(takes, dir) : null;
        const parts = finished ?? (await reencode(takes, dir));
        // The concat demuxer starts each part where the previous one ends, by its duration.
        const durations = [];
        for (const part of parts) durations.push(Number(await probe(part, 'format=duration')));
        const list = join(dir, 'parts.txt');
        writeFileSync(list, parts.map((p) => `file '${p}'\n`).join(''));
        await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', `${out}.part`]);
        await rename(`${out}.part`, out);
        return { durations, captioned: takes.map((t) => Boolean(finished && t.cues?.length)) };
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(`${out}.part`, { force: true });
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
 * joined before that was done (see joiner.locate).
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
        `SELECT id, body, asked_with AS askedWith, audio, published_answer_video AS video, published_answer_start AS answerStart
         FROM questions WHERE office_hour_id = ? AND published_position IS NOT NULL ORDER BY published_position`,
      )
      .all(officeHourId);
    const name = `${randomBytes(16).toString('hex')}.mp4`;
    try {
      if (!answers.length) throw new Error('nothing was published');
      // The question at the start of each take is captioned as it was asked: a spoken one from its own transcript.
      const spoken = answers.filter((a) => a.askedWith === 'audio').map((a) => a.audio);
      const texts = joiner.finishing ? await transcripts([...answers.map((a) => a.video), ...spoken]) : new Map();
      const takes = answers.map((a) => {
        const take = texts.get(a.video);
        const asked = { body: a.body, ...(a.askedWith === 'audio' ? texts.get(a.audio) : null) };
        return { file: join(mediaDir, a.video), answerStart: a.answerStart, ...(take && takeCaptions(asked, take, a.answerStart)) };
      });
      const { durations, captioned } = await joiner.join(takes, join(mediaDir, name));
      // Where each answer starts and ends in the joined video, and where its question's sound
      // starts in it: [question id, start, end, captions burned in, question start] in seconds.
      let at = 0;
      const spans = durations.map((d) => [at, (at += d)]);
      const heard = await joiner.locate(join(mediaDir, name), questionsIn(answers, spans));
      const chapters = answers.map((a, i) => [a.id, round(spans[i][0]), round(spans[i][1]), captioned[i] ? 1 : 0, round(heard[i])]);
      const old = db.prepare('SELECT video FROM office_hours WHERE id = ?').get(officeHourId)?.video;
      db.prepare("UPDATE office_hours SET video = ?, video_status = 'ready', video_chapters = ? WHERE id = ?").run(name, JSON.stringify(chapters), officeHourId);
      if (old) rmSync(join(mediaDir, old), { force: true });
    } catch (err) {
      rmSync(join(mediaDir, name), { force: true });
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
      const located = chapters.map((c, i) => [...c.slice(0, 4), round(heard[i])]);
      db.prepare('UPDATE office_hours SET video_chapters = ? WHERE id = ? AND video = ?').run(JSON.stringify(located), officeHourId, oh.video);
    });
  }

  /** Queues joining a published office hour's answers, in their published order. */
  function joinAnswers(officeHourId) {
    db.prepare("UPDATE office_hours SET video_status = 'pending' WHERE id = ?").run(officeHourId);
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

  function resume() {
    const waiting = db.prepare("SELECT id FROM office_hours WHERE published_at IS NOT NULL AND (video_status IS NULL OR video_status = 'pending')").all();
    waiting.forEach((oh) => joinAnswers(oh.id));
    const joined = db.prepare("SELECT id, video_chapters FROM office_hours WHERE video_status = 'ready'").all();
    joined.filter((oh) => JSON.parse(oh.video_chapters).some((c) => c.length < 5)).forEach((oh) => relocate(oh.id));
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
