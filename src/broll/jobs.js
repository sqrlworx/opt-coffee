import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const sleep = promisify(setTimeout);
const TRANSCRIPT_WAIT = 30 * 60_000; // longest placing b-roll waits for the take's transcript
const TRANSCRIPT_POLL = 1000;

/** Seconds of b-roll made, at most, unless the generator says otherwise (`broll.maxSeconds`): a cutaway, not a second video. */
export const MAX_CLIP = 5;

/**
 * Background work for answers' b-roll clips (the brolls table): making a clip from the expert's
 * description (`broll`, src/broll/index.js), one at a time, with what they say in the answer to pick
 * the shot, then placing it in the answer's take around the answer's other clips (the moderator picks
 * where, unless the expert chose). Both wait for the take's transcript. A clip the expert uploaded is
 * placed the same way, right away rather than after the clips being made, as are clips moved to where
 * they fit in a new take, or to where the expert chose. An answer's clips are placed one at a time,
 * each knowing where the ones before it went. Progress lives in the database (brolls.status), so
 * `resume()` at startup picks up anything pending.
 */
export function createBrollJobs({ db, broll, moderator, mediaDir, log = console.error, transcriptWait = TRANSCRIPT_WAIT }) {
  let tail = Promise.resolve();
  const enqueue = (job) => {
    tail = tail.then(job).catch((err) => log(err));
  };
  const answers = new Map(); // question id -> the placements in its answer, one after another
  const placing = new Set(); // placements under way outside the queue
  const clipOf = (id) => db.prepare('SELECT * FROM brolls WHERE id = ?').get(id);
  const question = (id) => db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
  let making = null; // the clip being made: { id, stop: AbortController }

  // A take's transcript, once it's no longer being made (or the wait runs out): {cues, words}, or null.
  async function transcript(take) {
    const pending = db.prepare("SELECT 1 FROM transcripts WHERE media = ? AND status = 'pending'");
    for (const until = Date.now() + transcriptWait; pending.get(take) && Date.now() < until; ) await sleep(TRANSCRIPT_POLL);
    const t = db.prepare("SELECT cues, words FROM transcripts WHERE media = ? AND status = 'ready'").get(take);
    return t ? { cues: JSON.parse(t.cues), words: t.words ? JSON.parse(t.words) : null } : null;
  }

  // The clips placed in a question's answer other than `except`, which another can't overlap; with
  // `chosen`, only those cut in where the expert chose, which b-roll they choose a place for can't.
  function others(questionId, except, { chosen = false } = {}) {
    return db
      .prepare(`SELECT * FROM brolls WHERE question_id = ? AND id IS NOT ? AND status = 'ready' AND start IS NOT NULL${chosen ? ' AND chosen IS NOT NULL' : ''} ORDER BY start`)
      .all(questionId, except)
      .map((b) => ({ id: b.id, start: b.start, length: b.length, description: shows(b) }));
  }

  /**
   * How much b-roll a question's answer has room for, around its clips other than `except` (see
   * moderator.brollRange), for a clip `clip` seconds long, or null if there's no room for any.
   */
  const longest = broll.maxSeconds ?? MAX_CLIP;
  async function room(q, { clip = longest, except = null } = {}) {
    return moderator.brollRange({ clip, answerStart: q.answer_start, end: await broll.duration(join(mediaDir, q.answer_video)), others: others(q.id, except) });
  }

  /** Queues making a clip (brolls.video names the file to make), then placing it. */
  function generate(id) {
    enqueue(async () => {
      const b = clipOf(id);
      if (b?.status !== 'pending') return;
      const file = join(mediaDir, b.video);
      // An uploaded clip that's gone can't be made again, nor can anything without a way to make it.
      if (!existsSync(file) && (b.upload || !broll.generate)) {
        db.prepare("UPDATE brolls SET status = 'failed' WHERE id = ?").run(id);
        return log(`[broll] b-roll clip ${id} is missing, and can't be made`);
      }
      if (!existsSync(file)) {
        making = { id, stop: new AbortController() };
        try {
          const q = question(b.question_id);
          // Only as long as this take has room for, so no time goes into frames nobody sees.
          const fits = q.answer_video ? await room(q, { except: id }) : null;
          // What they say in the answer, after the question, so the shot can show their example.
          const said = q.answer_video ? (await transcript(q.answer_video))?.cues.filter(([start, end]) => (start + end) / 2 >= (q.answer_start ?? 0)) : null;
          const { shot } = await broll.generate(b.prompt, file, {
            seconds: fits?.length ?? longest,
            question: q.body,
            answer: said?.length ? said.map(([, , text]) => text).join(' ') : null,
            signal: making.stop.signal,
          });
          db.prepare('UPDATE brolls SET shot = ? WHERE id = ?').run(shot ?? null, id);
        } catch (err) {
          rmSync(file, { force: true });
          const { changes } = db.prepare("UPDATE brolls SET status = 'failed' WHERE id = ?").run(id);
          if (changes) log(`[broll] making b-roll clip ${id} failed: ${err.message}`);
          return;
        } finally {
          making = null;
        }
        // The expert may have removed it meanwhile.
        if (!clipOf(id)) return rmSync(file, { force: true });
      }
      await inAnswer(b.question_id, () => placeNow(id));
    });
  }

  // Runs `job` once the placements in a question's answer before it are done; resolves once it is.
  function inAnswer(questionId, job) {
    const run = (answers.get(questionId) ?? Promise.resolve()).then(job).catch((err) => log(err));
    answers.set(questionId, run);
    placing.add(run);
    run.finally(() => {
      placing.delete(run);
      if (answers.get(questionId) === run) answers.delete(questionId);
    });
    return run;
  }

  /**
   * Places a clip, already there, in its answer's current take: after it was uploaded, or the expert
   * changed how it plays or chose where it goes. Right away, not after clips being made, which can
   * take minutes each. Resolves once it's placed, with any clip it moved.
   */
  function place(id) {
    const b = clipOf(id);
    if (!b) return Promise.resolve();
    db.prepare("UPDATE brolls SET status = 'pending', start = NULL, length = NULL WHERE id = ?").run(id);
    if (!existsSync(join(mediaDir, b.video))) return Promise.resolve(); // still being made: placed once it is
    return inAnswer(b.question_id, () => placeNow(id));
  }

  /**
   * Places all of a question's clips that are there again, one after another: after a new take was
   * recorded. One still being made is placed once it's made. With `leftOut`, only those that were
   * left out for want of room, which may have some now: after a clip was removed.
   */
  function placeAll(questionId, { leftOut = false } = {}) {
    const which = leftOut ? "status = 'ready' AND start IS NULL AND chosen IS NULL" : "status IN ('ready', 'pending')";
    const ids = db
      .prepare(`SELECT id, video FROM brolls WHERE question_id = ? AND ${which} ORDER BY id`)
      .all(questionId)
      .filter((b) => existsSync(join(mediaDir, b.video)))
      .map((b) => b.id);
    if (!ids.length) return Promise.resolve();
    const unplace = db.prepare("UPDATE brolls SET status = 'pending', start = NULL, length = NULL WHERE id = ?");
    ids.forEach((id) => unplace.run(id));
    return inAnswer(questionId, async () => {
      for (const id of ids) await placeNow(id);
    });
  }

  // Places a pending clip in the take its answer has now, as it's to play now, around the answer's
  // other clips. If either changes meanwhile (it's re-recorded, say), whatever changed it places it
  // again, after this. Cut in where the expert chose, it moves clips the moderator placed there.
  async function placeNow(id) {
    const b = clipOf(id);
    if (b?.status !== 'pending') return;
    const q = question(b.question_id);
    const take = q.answer_video;
    const still = db.prepare(
      `UPDATE brolls SET status = 'ready', start = ?, length = ?, seconds = ?
       WHERE id = ? AND status = 'pending' AND full = ? AND past_end = ? AND chosen IS ? AND (SELECT answer_video FROM questions WHERE questions.id = brolls.question_id) IS ?`,
    );
    const as = [b.full, b.past_end, b.chosen, take];
    if (!take) return still.run(null, null, b.seconds, id, ...as); // no answer to place it in until one's recorded
    let placed;
    try {
      // Where the expert chose needs no transcript.
      const t = b.chosen == null ? await transcript(take) : null;
      const [end, seconds] = await Promise.all([broll.duration(join(mediaDir, take)), broll.duration(join(mediaDir, b.video))]);
      placed = await moderator.placeBroll({
        description: shows(b),
        question: q.body,
        clip: seconds,
        answerStart: q.answer_start,
        end,
        cues: t?.cues ?? null,
        words: t?.words ?? null,
        full: Boolean(b.full),
        pastEnd: Boolean(b.full && b.past_end),
        start: b.chosen,
        others: others(q.id, id, { chosen: b.chosen != null }),
      });
      // No room for it, after a re-recording, or too late where the expert chose: it stays, unplaced.
      if (!still.run(placed?.start ?? null, placed?.length ?? null, seconds, id, ...as).changes) return;
    } catch (err) {
      const { changes } = db.prepare("UPDATE brolls SET status = 'failed' WHERE id = ? AND status = 'pending'").run(id);
      if (changes) log(`[broll] placing b-roll clip ${id} failed: ${err.message}`);
      return;
    }
    if (!placed || b.chosen == null) return;
    const until = placed.start + placed.length;
    const unplace = db.prepare("UPDATE brolls SET status = 'pending', start = NULL, length = NULL WHERE id = ?");
    for (const o of others(q.id, id)) {
      if (o.start >= until || o.start + o.length <= placed.start || clipOf(o.id).chosen != null) continue;
      unplace.run(o.id);
      await placeNow(o.id);
    }
  }

  /** Stops making a clip if it's no longer wanted: the expert removed it. */
  function cancel(id) {
    if (making?.id === id && !clipOf(id)) making.stop.abort();
  }

  function resume() {
    db.prepare("SELECT id FROM brolls WHERE status = 'pending' ORDER BY id").all().forEach((b) => generate(b.id));
  }

  return {
    room,
    generate,
    place,
    placeAll,
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
 * What a clip shows, to place it by: the expert's description, or for a clip they uploaded without
 * one, its file's name ("chopping-onions.mov"), which often says.
 */
export function shows(b) {
  if (b.prompt || !b.upload) return b.prompt ?? '';
  return b.upload.replace(/\.[^.]*$/, '').replace(/[._-]+/g, ' ').trim();
}
