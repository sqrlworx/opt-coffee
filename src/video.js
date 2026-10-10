import { execFile, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const FFMPEG_TIMEOUT = 30 * 60_000; // a take is at most 10 minutes; re-encoding it is quicker than that
const WIDTH = 1280;
const HEIGHT = 720;

/**
 * Joins answer videos into one with ffmpeg. Each take is re-encoded to the same size, frame rate
 * and codecs first: takes can come from different browsers (MP4 or WebM) and cameras, and the
 * browser's recordings have no reliable durations. The re-encoded parts are then put end to end
 * without re-encoding again.
 *
 * Returns null when ffmpeg isn't on the PATH.
 */
export function createVideoJoiner({ log = console.warn } = {}) {
  if (spawnSync('ffmpeg', ['-version']).error || spawnSync('ffprobe', ['-version']).error) {
    log('[video] ffmpeg not found, so published answers are shown one by one instead of as one video');
    return null;
  }
  const ffmpeg = (args) => run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { timeout: FFMPEG_TIMEOUT, maxBuffer: 10_000_000 });
  const probe = async (file, entries) => (await run('ffprobe', ['-v', 'error', '-show_entries', entries, '-of', 'csv=p=0', file])).stdout.trim();

  return {
    /**
     * Writes the videos in `files`, in order, into one MP4 at `out`.
     * @returns {Promise<number[]>} how long each part is in the result, in seconds
     */
    async join(files, out) {
      const dir = mkdtempSync(join(tmpdir(), 'forum_join_'));
      try {
        const parts = [];
        for (const [i, file] of files.entries()) {
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
        // The concat demuxer starts each part where the previous one ends, by its duration.
        const durations = [];
        for (const part of parts) durations.push(Number(await probe(part, 'format=duration')));
        const list = join(dir, 'parts.txt');
        writeFileSync(list, parts.map((p) => `file '${p}'\n`).join(''));
        await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', `${out}.part`]);
        await rename(`${out}.part`, out);
        return durations;
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(`${out}.part`, { force: true });
      }
    },
  };
}

/**
 * Background work joining each published office hour's answers into one video, one at a time.
 * Progress lives in the database (office_hours.video_status), so `resume()` at startup picks up
 * anything pending, or published before joining existed.
 */
export function createVideoJobs({ db, joiner, mediaDir, log = console.error }) {
  let tail = Promise.resolve();
  const enqueue = (job) => {
    tail = tail.then(job).catch((err) => log(err));
  };

  /** Queues joining a published office hour's answers, in their published order. */
  function joinAnswers(officeHourId) {
    db.prepare("UPDATE office_hours SET video_status = 'pending' WHERE id = ?").run(officeHourId);
    enqueue(async () => {
      const answers = db
        .prepare('SELECT id, published_answer_video AS video FROM questions WHERE office_hour_id = ? AND published_position IS NOT NULL ORDER BY published_position')
        .all(officeHourId);
      const name = `${randomBytes(16).toString('hex')}.mp4`;
      try {
        if (!answers.length) throw new Error('nothing was published');
        const durations = await joiner.join(answers.map((a) => join(mediaDir, a.video)), join(mediaDir, name));
        // Where each answer starts and ends in the joined video: [question id, start, end] in seconds.
        let at = 0;
        const chapters = answers.map((a, i) => [a.id, round(at), round((at += durations[i]))]);
        db.prepare("UPDATE office_hours SET video = ?, video_status = 'ready', video_chapters = ? WHERE id = ?").run(name, JSON.stringify(chapters), officeHourId);
      } catch (err) {
        rmSync(join(mediaDir, name), { force: true });
        db.prepare("UPDATE office_hours SET video_status = 'failed' WHERE id = ?").run(officeHourId);
        log(`[video] joining the answers of office hour ${officeHourId} failed: ${err.message}`);
      }
    });
  }

  function resume() {
    const waiting = db.prepare("SELECT id FROM office_hours WHERE published_at IS NOT NULL AND (video_status IS NULL OR video_status = 'pending')").all();
    waiting.forEach((oh) => joinAnswers(oh.id));
  }

  return {
    join: joinAnswers,
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
