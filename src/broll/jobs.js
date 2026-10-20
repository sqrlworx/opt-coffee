import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const sleep = promisify(setTimeout);
const TRANSCRIPT_WAIT = 30 * 60_000; // longest placing b-roll waits for the take's transcript
const TRANSCRIPT_POLL = 1000;

/** Seconds of b-roll made, at most, unless the generator says otherwise (`broll.maxSeconds`): a cutaway, not a second video. */
export const MAX_CLIP = 5;

/**
 * Background work for answers' b-roll: making a clip from the expert's description (`broll`,
 * src/broll/index.js), one at a time, with what they say in the answer to pick the shot, then
 * placing it in the answer's take (the moderator picks where, unless the expert chose). Both wait
 * for the take's transcript. A clip the expert uploaded is placed the same way, right away rather
 * than after the clips being made, as is b-roll moved to where it fits in a new take, or to where
 * the expert chose. Progress lives in the
 * database (questions.broll_status), so `resume()` at startup picks up anything pending.
 */
export function createBrollJobs({ db, broll, moderator, mediaDir, log = console.error, transcriptWait = TRANSCRIPT_WAIT }) {
  let tail = Promise.resolve();
  const enqueue = (job) => {
    tail = tail.then(job).catch((err) => log(err));
  };
  const placing = new Set(); // placements under way outside the queue
  const question = (id) => db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
  // Still the b-roll this job is for: the expert may have asked for another, or removed it, meanwhile.
  const wanted = (id, clip) => question(id)?.broll_video === clip;
  let making = null; // the clip being made: { id, clip, stop: AbortController }

  // A take's transcript, once it's no longer being made (or the wait runs out): {cues, words}, or null.
  async function transcript(take) {
    const pending = db.prepare("SELECT 1 FROM transcripts WHERE media = ? AND status = 'pending'");
    for (const until = Date.now() + transcriptWait; pending.get(take) && Date.now() < until; ) await sleep(TRANSCRIPT_POLL);
    const t = db.prepare("SELECT cues, words FROM transcripts WHERE media = ? AND status = 'ready'").get(take);
    return t ? { cues: JSON.parse(t.cues), words: t.words ? JSON.parse(t.words) : null } : null;
  }

  /** How much b-roll an answer has room for (see moderator.brollRange), or null if it's too short for any. */
  const longest = broll.maxSeconds ?? MAX_CLIP;
  async function room(take, answerStart, clip = longest) {
    return moderator.brollRange({ clip, answerStart, end: await broll.duration(join(mediaDir, take)) });
  }

  /** Queues making a question's b-roll clip (broll_video names the file to make), then placing it. */
  function generate(id) {
    enqueue(async () => {
      const q = question(id);
      if (q?.broll_status !== 'pending' || !q.broll_video) return;
      const file = join(mediaDir, q.broll_video);
      // An uploaded clip that's gone can't be made again, nor can anything without a way to make it.
      if (!existsSync(file) && (q.broll_upload || !broll.generate)) {
        db.prepare("UPDATE questions SET broll_status = 'failed' WHERE id = ? AND broll_video = ?").run(id, q.broll_video);
        return log(`[broll] the b-roll for question ${id} is missing, and can't be made`);
      }
      if (!existsSync(file)) {
        making = { id, clip: q.broll_video, stop: new AbortController() };
        try {
          // Only as long as this take has room for, so no time goes into frames nobody sees.
          const fits = q.answer_video ? await room(q.answer_video, q.answer_start) : null;
          // What they say in the answer, after the question, so the shot can show their example.
          const said = q.answer_video ? (await transcript(q.answer_video))?.cues.filter(([start, end]) => (start + end) / 2 >= (q.answer_start ?? 0)) : null;
          const { shot } = await broll.generate(q.broll_prompt, file, {
            seconds: fits?.length ?? longest,
            question: q.body,
            answer: said?.length ? said.map(([, , text]) => text).join(' ') : null,
            signal: making.stop.signal,
          });
          db.prepare('UPDATE questions SET broll_shot = ? WHERE id = ? AND broll_video = ?').run(shot ?? null, id, q.broll_video);
        } catch (err) {
          rmSync(file, { force: true });
          const { changes } = db.prepare("UPDATE questions SET broll_status = 'failed' WHERE id = ? AND broll_video = ?").run(id, q.broll_video);
          if (changes) log(`[broll] making b-roll for question ${id} failed: ${err.message}`);
          return;
        } finally {
          making = null;
        }
        if (!wanted(id, q.broll_video)) return rmSync(file, { force: true });
      }
      await placeNow(id);
    });
  }

  /**
   * Places a question's b-roll, already there, in its current take: after a new take was recorded,
   * a clip uploaded, or the expert changed how it plays or chose where it goes. Right away, not
   * after clips being made, which can take minutes each. Resolves once it's placed.
   */
  function place(id) {
    db.prepare("UPDATE questions SET broll_status = 'pending', broll_start = NULL, broll_length = NULL WHERE id = ?").run(id);
    const job = placeNow(id)
      .catch((err) => log(err))
      .finally(() => placing.delete(job));
    placing.add(job);
    return job;
  }

  // Places the b-roll in the take the question has now, as it's to play now; if either changes
  // meanwhile (it's re-recorded, say), again for that. A new clip asked for meanwhile is placed by
  // its own job.
  async function placeNow(id) {
    const clip = question(id)?.broll_video;
    for (;;) {
      const q = question(id);
      if (q?.broll_status !== 'pending' || !clip || q.broll_video !== clip) return;
      const take = q.answer_video;
      const as = [take, q.broll_full, q.broll_past_end, q.broll_chosen];
      const still = db.prepare(
        `UPDATE questions SET broll_status = 'ready', broll_start = ?, broll_length = ?, broll_seconds = ?
         WHERE id = ? AND broll_video = ? AND answer_video IS ? AND broll_full = ? AND broll_past_end = ? AND broll_chosen IS ?`,
      );
      if (!take) return still.run(null, null, null, id, clip, ...as); // no answer to place it in until one's recorded
      try {
        // Where the expert chose needs no transcript.
        const t = q.broll_chosen == null ? await transcript(take) : null;
        const [end, seconds] = await Promise.all([broll.duration(join(mediaDir, take)), broll.duration(join(mediaDir, clip))]);
        const placed = await moderator.placeBroll({
          description: shows(q),
          question: q.body,
          clip: seconds,
          answerStart: q.answer_start,
          end,
          cues: t?.cues ?? null,
          words: t?.words ?? null,
          full: Boolean(q.broll_full),
          pastEnd: Boolean(q.broll_full && q.broll_past_end),
          start: q.broll_chosen,
        });
        // Too short for it, after a re-recording, or too late where the expert chose: it stays, unplaced.
        if (still.run(placed?.start ?? null, placed?.length ?? null, seconds, id, clip, ...as).changes) return;
      } catch (err) {
        const { changes } = db.prepare("UPDATE questions SET broll_status = 'failed' WHERE id = ? AND broll_video = ? AND answer_video IS ?").run(id, clip, take);
        if (changes) return log(`[broll] placing the b-roll of question ${id} failed: ${err.message}`);
      }
      // The take, or how it's to play, changed while this was being placed: go again with that.
    }
  }

  /** Stops making a question's clip if it's no longer wanted: the expert removed it or asked for another. */
  function cancel(id) {
    if (making?.id === id && !wanted(id, making.clip)) making.stop.abort();
  }

  function resume() {
    db.prepare("SELECT id FROM questions WHERE broll_status = 'pending'").all().forEach((q) => generate(q.id));
  }

  return {
    room,
    generate,
    place,
    cancel,
    resume,
    /** Resolves once every job, including ones started meanwhile, has finished. */
    async idle() {
      let seen;
      do {
        seen = tail;
        await Promise.all([seen, ...placing]);
      } while (seen !== tail || placing.size);
    },
  };
}

/**
 * What a question's b-roll shows, to place it by: the expert's description, or for a clip they
 * uploaded without one, its file's name ("chopping-onions.mov"), which often says.
 */
function shows(q) {
  if (q.broll_prompt || !q.broll_upload) return q.broll_prompt ?? '';
  return q.broll_upload.replace(/\.[^.]*$/, '').replace(/[._-]+/g, ' ').trim();
}
