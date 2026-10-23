import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { transaction } from '../db.js';
import { Refused } from './index.js';

const FAILED = "Couldn't draw your characters right now. Please try again.";

/**
 * Background work for people's characters: drawing the three a user asked for (`avatars`,
 * src/avatar/index.js) to pick one from as their profile picture. Each user's are drawn as soon as
 * they ask, alongside anyone else's, since the drawing is done elsewhere. Progress lives in the
 * database (users.avatar_status), so `resume()` at startup picks up anything pending.
 */
export function createAvatarJobs({ db, avatars, mediaDir, log = console.error }) {
  const drawing = new Map(); // user id -> AbortController, for the characters being drawn
  const running = new Set();

  /** Draws the characters a user asked for (users.avatar_prompt), then offers them (avatars.offered). */
  function make(userId) {
    drawing.get(userId)?.abort();
    const stop = new AbortController();
    drawing.set(userId, stop);
    const job = (async () => {
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      if (u?.avatar_status !== 'pending') return;
      const about = { displayName: u.display_name, bio: u.bio, expertise: u.expertise.split(',').map((t) => t.trim()).filter(Boolean) };
      let options;
      try {
        options = await avatars.make({ prompt: u.avatar_prompt ?? '', about, signal: stop.signal });
      } catch (err) {
        if (stop.signal.aborted) return;
        if (!(err instanceof Refused)) log(`[avatar] drawing characters for user ${userId} failed: ${err.message}`);
        db.prepare("UPDATE users SET avatar_status = 'failed', avatar_error = ? WHERE id = ? AND avatar_status = 'pending'").run(err instanceof Refused ? err.message : FAILED, userId);
        return;
      }
      if (stop.signal.aborted) return;
      const files = options.map(({ picture, base }) => {
        const names = [picture, base].map(() => `${randomBytes(16).toString('hex')}.webp`);
        writeFileSync(join(mediaDir, names[0]), picture);
        writeFileSync(join(mediaDir, names[1]), base);
        return names;
      });
      const offered = transaction(db, () => {
        if (db.prepare('SELECT avatar_status FROM users WHERE id = ?').get(userId)?.avatar_status !== 'pending') return false;
        const insert = db.prepare('INSERT INTO avatars (user_id, character, picture, base, rig, offered, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)');
        options.forEach((o, i) => insert.run(userId, o.character, files[i][0], files[i][1], JSON.stringify(o.rig), new Date().toISOString()));
        db.prepare("UPDATE users SET avatar_status = 'ready', avatar_error = NULL WHERE id = ?").run(userId);
        return true;
      });
      if (!offered) for (const name of files.flat()) rmSync(join(mediaDir, name), { force: true });
    })()
      .catch((err) => log(err))
      .finally(() => {
        if (drawing.get(userId) === stop) drawing.delete(userId);
        running.delete(job);
      });
    running.add(job);
  }

  return {
    make,
    /** Picks up characters that were being drawn when the server stopped. */
    resume() {
      for (const { id } of db.prepare("SELECT id FROM users WHERE avatar_status = 'pending'").all()) make(id);
    },
    /** Resolves when nothing is being drawn (for tests). */
    async idle() {
      while (running.size) await Promise.all(running);
    },
  };
}
