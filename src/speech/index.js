import { execFile, spawn, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { voicesFor } from './voices.js';

const WORKER = fileURLToPath(new URL('./worker.py', import.meta.url));
const INTERACTIVE_TIMEOUT = 120_000; // an asker is waiting on the response
const BACKGROUND_TIMEOUT = 30 * 60_000; // includes downloading models on first use
const EXTRACT_TIMEOUT = 60_000; // a question asked on camera is at most 90 seconds
const run = promisify(execFile);

/**
 * Speech for the app: speech-to-text for recordings and text-to-speech for typed questions.
 * Questions asked on camera have their sound taken out with ffmpeg first.
 *
 * Runs src/speech/worker.py (faster-whisper + Kokoro) with uv as two long-lived processes, so
 * models load once: one for askers waiting on their question's transcript, and one for
 * background work (answer transcripts, reading questions aloud). A long answer video never
 * holds up an asker.
 *
 * `voice` reads questions aloud unless the asker picks another of `voices` (see voices.js).
 *
 * Returns null when speech is off: `off`, or `auto` without uv on the PATH.
 * @param {{mode?: 'auto'|'on'|'off', whisperModel?: string, voice?: string, log?: (msg:string)=>void}} opts
 */
export function createSpeech({
  mode = process.env.FORUM_SPEECH ?? 'auto',
  whisperModel = process.env.FORUM_WHISPER_MODEL ?? 'small.en',
  voice = process.env.FORUM_VOICE ?? 'af_heart',
  log = console.warn,
} = {}) {
  if (mode === 'off') return null;
  if (mode === 'auto' && spawnSync('uv', ['--version']).error) {
    log('[speech] uv not found, so speech is off (no audio questions, read-aloud or transcripts)');
    return null;
  }
  const args = ['run', '--quiet', WORKER, '--whisper-model', whisperModel, '--voice', voice];
  const interactive = worker(args, 'interactive', log);
  const background = worker(args, 'background', log);

  return {
    name: `whisper ${whisperModel} + kokoro ${voice}`,
    voice,
    voices: voicesFor(voice),

    /** @returns {Promise<{text: string, words: [number, number, string][]}>} */
    transcribe(file, { interactive: now = false } = {}) {
      return now ? interactive.request({ op: 'transcribe', file }, INTERACTIVE_TIMEOUT) : background.request({ op: 'transcribe', file }, BACKGROUND_TIMEOUT);
    },

    /**
     * The sound of a question asked on camera, as an M4A file at `out`: it's transcribed, and
     * played to the expert like any spoken question. Fails if the video has no sound.
     */
    async extractSound(file, out) {
      const part = `${out}.part`;
      try {
        await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:a:0', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-f', 'mp4', part], { timeout: EXTRACT_TIMEOUT });
        await rename(part, out);
      } finally {
        rmSync(part, { force: true });
      }
    },

    /**
     * Reads `text` aloud into an M4A file at `out`, in `voice` (the default without one).
     * `interactive` when someone is waiting on it, like an asker previewing a voice.
     * @returns {Promise<{mouth: {fps: number, frames: [number, number, number][]}}>} its lip sync (see lipsync.py)
     */
    speak(text, out, { voice: chosen = null, interactive: now = false } = {}) {
      const message = { op: 'speak', text, out, voice: chosen };
      return now ? interactive.request(message, INTERACTIVE_TIMEOUT) : background.request(message, BACKGROUND_TIMEOUT);
    },

    /**
     * The lip sync for a recording, from its `words` as transcribed (it's transcribed again
     * without them).
     * @returns {Promise<{mouth: {fps: number, frames: [number, number, number][]}}>}
     */
    lipSync(file, words = null) {
      return background.request({ op: 'lipsync', file, words }, BACKGROUND_TIMEOUT);
    },

    /** Starts the workers and loads models now, so the first asker doesn't wait for that. */
    warmup() {
      const report = (err) => log(`[speech] warmup failed: ${err.message}`);
      interactive.request({ op: 'load', models: ['whisper'] }, BACKGROUND_TIMEOUT).catch(report);
      background.request({ op: 'load', models: ['whisper', 'kokoro'] }, BACKGROUND_TIMEOUT).catch(report);
    },

    close() {
      interactive.close();
      background.close();
    },
  };
}

// One worker process, started on first use and restarted on the next request if it dies.
function worker(args, label, log) {
  let current = null; // { child, pending: Map<id, {resolve, reject, timer}> }
  let nextId = 1;

  function start() {
    const child = spawn('uv', args, { stdio: ['pipe', 'pipe', 'inherit'] });
    const state = { child, pending: new Map() };
    const fail = (err) => {
      if (current === state) current = null;
      for (const p of state.pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      state.pending.clear();
    };
    child.on('error', (err) => fail(new Error(`Couldn't start the speech worker: ${err.message}`)));
    child.on('exit', (code, signal) => {
      if (state.pending.size) log(`[speech] ${label} worker exited (${signal ?? code})`);
      fail(new Error('The speech worker stopped'));
    });
    child.stdin.on('error', () => {}); // the exit handler reports a dead worker
    createInterface({ input: child.stdout }).on('line', (line) => {
      let reply;
      try {
        reply = JSON.parse(line);
      } catch {
        return log(`[speech] ${label}: ${line}`);
      }
      const p = state.pending.get(reply.id);
      if (!p) return; // timed out already
      state.pending.delete(reply.id);
      clearTimeout(p.timer);
      if (reply.ok) p.resolve(reply);
      else p.reject(new Error(reply.error));
    });
    return state;
  }

  return {
    request(message, timeout) {
      current ??= start();
      const { child, pending } = current;
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('Speech processing timed out'));
        }, timeout);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, ...message })}\n`);
      });
    },
    close() {
      current?.child.kill();
      current = null;
    },
  };
}
