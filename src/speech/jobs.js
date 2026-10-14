import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { cuesFromWords } from './captions.js';

const now = () => new Date().toISOString();

/**
 * Background speech work, run one job at a time: transcribing answer videos, reading typed
 * questions aloud, and the lip sync of questions' speech. Progress lives in the database
 * (transcripts.status, questions.audio_status, questions.lip_sync), so `resume()` at startup
 * picks up anything that was pending, or never done because it predates speech support (or lip
 * sync).
 */
export function createSpeechJobs({ db, speech, mediaDir, log = console.error }) {
  let tail = Promise.resolve();
  const enqueue = (job) => {
    tail = tail.then(job).catch((err) => log(err));
  };

  /** Queues a transcript for a recording in the media dir. Readers see "pending" until it's done. */
  function transcribe(name) {
    db.prepare(
      `INSERT INTO transcripts (media, status, updated_at) VALUES (?, 'pending', ?)
       ON CONFLICT (media) DO UPDATE SET status = 'pending', updated_at = excluded.updated_at`,
    ).run(name, now());
    enqueue(async () => {
      // The recording may have been re-recorded or removed while this job waited.
      if (!db.prepare('SELECT 1 FROM transcripts WHERE media = ?').get(name)) return;
      try {
        const { text, words } = await speech.transcribe(join(mediaDir, name));
        db.prepare("UPDATE transcripts SET status = 'ready', text = ?, cues = ?, words = ?, updated_at = ? WHERE media = ?").run(text, JSON.stringify(cuesFromWords(words)), JSON.stringify(words), now(), name);
      } catch (err) {
        // A recording deleted mid-job has no transcript left to mark, and nothing worth reporting.
        const { changes } = db.prepare("UPDATE transcripts SET status = 'failed', updated_at = ? WHERE media = ?").run(now(), name);
        if (changes) log(`[speech] transcribing ${name} failed: ${err.message}`);
      }
    });
  }

  /** Queues reading a typed question aloud into an audio file, in its voice, with its lip sync. */
  function speak(questionId) {
    db.prepare("UPDATE questions SET audio_status = 'pending' WHERE id = ?").run(questionId);
    enqueue(async () => {
      const q = db.prepare('SELECT body, voice FROM questions WHERE id = ?').get(questionId);
      if (!q) return;
      const name = `${randomBytes(16).toString('hex')}.m4a`;
      try {
        const { mouth } = await speech.speak(q.body, join(mediaDir, name), { voice: q.voice });
        db.prepare("UPDATE questions SET audio = ?, audio_status = 'ready', lip_sync = ? WHERE id = ?").run(name, mouth ? JSON.stringify(mouth) : null, questionId);
      } catch (err) {
        log(`[speech] reading question ${questionId} aloud failed: ${err.message}`);
        rmSync(join(mediaDir, name), { force: true });
        db.prepare("UPDATE questions SET audio_status = 'failed' WHERE id = ?").run(questionId);
      }
    });
  }

  /**
   * Queues the lip sync for a question's audio, if it hasn't got one: a spoken question's, from
   * its words as transcribed, or audio read aloud before lip sync existed. One that fails is
   * tried again at the next startup.
   */
  function lipSync(questionId) {
    enqueue(async () => {
      const q = db.prepare('SELECT audio FROM questions WHERE id = ? AND audio IS NOT NULL AND lip_sync IS NULL').get(questionId);
      if (!q) return;
      const heard = db.prepare("SELECT words FROM transcripts WHERE media = ? AND status = 'ready'").get(q.audio);
      try {
        const { mouth } = await speech.lipSync(join(mediaDir, q.audio), heard?.words ? JSON.parse(heard.words) : null);
        db.prepare('UPDATE questions SET lip_sync = ? WHERE id = ? AND audio = ?').run(JSON.stringify(mouth), questionId, q.audio);
      } catch (err) {
        log(`[speech] lip-syncing question ${questionId} failed: ${err.message}`);
      }
    });
  }

  function resume() {
    const recordings = db
      .prepare(
        `SELECT media FROM transcripts WHERE status = 'pending'
         UNION
         SELECT v FROM (SELECT answer_video AS v FROM questions UNION SELECT published_answer_video FROM questions)
         WHERE v IS NOT NULL AND v NOT IN (SELECT media FROM transcripts)`,
      )
      .all();
    recordings.forEach((r) => transcribe(r.media));
    const unspoken = db.prepare("SELECT id FROM questions WHERE asked_with = 'text' AND audio IS NULL AND (audio_status IS NULL OR audio_status = 'pending')").all();
    unspoken.forEach((q) => speak(q.id));
    db.prepare('SELECT id FROM questions WHERE audio IS NOT NULL AND lip_sync IS NULL').all().forEach((q) => lipSync(q.id));
  }

  return {
    transcribe,
    speak,
    lipSync,
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
