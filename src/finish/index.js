import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./finish.py', import.meta.url));
// The first run installs the dependencies and downloads the models; after that a take renders in
// about real time on a few cores, faster on more.
const TIMEOUT = 3 * 60 * 60_000;

/**
 * Finishing for the joined answer video: src/finish/finish.py, run with uv. Each take is lit and
 * graded like a studio interview at 1080p, its voice restored to sound like a studio microphone
 * (`voice: 'studio'`) or only cleaned up (`'natural'`), and its captions burned in.
 *
 * Returns null when finishing is off: `off`, or `auto` without uv on the PATH.
 * @param {{mode?: 'auto'|'on'|'off', voice?: 'studio'|'natural', workers?: number, log?: (msg: string) => void}} opts
 */
export function createFinisher({
  mode = process.env.FORUM_FINISH ?? 'auto',
  voice = process.env.FORUM_FINISH_VOICE ?? 'studio',
  workers = Number(process.env.FORUM_FINISH_WORKERS) || 0,
  log = console.warn,
} = {}) {
  if (mode === 'off') return null;
  if (mode === 'auto' && spawnSync('uv', ['--version']).error) {
    log('[finish] uv not found, so joined videos are not finished (lighting, sound, captions)');
    return null;
  }
  return {
    /**
     * Renders each take into a finished part; the parts join without re-encoding.
     * @param {{input: string, output: string, answer_start: number|null, cues: [number, number, string][]|null, words: [number, number, string][]|null,
     *   cutaway: {input: string, layout: 'split'|'corner', filter: string, mobile_filter: string|null}|null}[]} takes  cutaway: b-roll, split
     *   screen or full screen, and the filter graphs that cut it in, and into the phone's copy when it's full screen (see finish.py)
     * @param {string} dir  scratch directory for the job file
     * @returns {Promise<object>} the finisher's report: what was measured and done, per take
     */
    finish(takes, dir) {
      const job = join(dir, 'finish.json');
      writeFileSync(job, JSON.stringify({ takes, voice, workers }));
      return new Promise((resolve, reject) => {
        const child = spawn('uv', ['run', '--quiet', SCRIPT, job], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let tail = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => {
          process.stderr.write(d); // its progress, in the server's log
          tail = (tail + d).slice(-4000);
        });
        const timer = setTimeout(() => child.kill(), TIMEOUT);
        child.on('error', (err) => {
          clearTimeout(timer);
          reject(new Error(`Couldn't start finishing: ${err.message}`));
        });
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          if (code !== 0) return reject(new Error(`finishing exited (${signal ?? code}): ${tail.trim().split('\n').at(-1) ?? ''}`));
          try {
            resolve(JSON.parse(out.trim().split('\n').at(-1)));
          } catch {
            resolve({});
          }
        });
      });
    },
  };
}
