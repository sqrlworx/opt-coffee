import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createBroll, mediaDuration } from '../src/broll/index.js';
import { createModerator } from '../src/moderator/index.js';

// Stands in for LTX-Video and ffprobe: a "video" says how long it is ("take: <label> <seconds>s"),
// and making b-roll writes one of those, as long as it was asked for, recording what was asked in
// `made`. The shot it films is the description, written up. A description with "[fail]" fails.
// `hold(t)` makes it wait until released, or stopped (recorded in `stopped`).
let gate = null;
const hold = (t) => {
  let resolve;
  gate = new Promise((r) => (resolve = r));
  const release = () => {
    gate = null;
    resolve();
  };
  t.after(release);
  return release;
};
const made = [];
const stopped = [];
const fakeBroll = {
  name: 'fake',
  async generate(prompt, out, { seconds, question, answer, signal }) {
    await Promise.race([gate, new Promise((resolve, reject) => signal?.addEventListener('abort', () => (stopped.push(prompt), reject(new Error('killed')))))]);
    if (prompt.includes('[fail]')) throw new Error('out of memory');
    made.push({ prompt, seconds, question, answer });
    writeFileSync(out, `broll: ${prompt} ${seconds}s`);
    return { seconds, shot: `A scene showing: ${prompt}` };
  },
  async duration(file) {
    return Number(/ ([\d.]+)s$/.exec(readFileSync(file, 'utf8'))[1]);
  },
};
// Records the takes each join is given.
const joins = [];
const fakeJoiner = {
  async join(takes, out) {
    joins.push(takes);
    writeFileSync(out, 'joined');
    return { durations: takes.map(() => 10), captioned: takes.map(() => false) };
  },
  locate: async (video, questions) => questions.map(() => 0),
};

let server;
let app;
let base;
let db;
let mediaDir;

before(async () => {
  db = openDb(':memory:');
  mediaDir = mkdtempSync(join(tmpdir(), 'forum_broll_media_'));
  app = createApp({ db, moderator: await createModerator({ mode: 'heuristic' }), mediaDir, joiner: fakeJoiner, broll: fakeBroll });
  server = createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});

after(() => {
  server.close();
  rmSync(mediaDir, { recursive: true, force: true });
});

function client(baseUrl = () => base) {
  let cookie = '';
  const call = async function call(method, path, body) {
    const raw = Buffer.isBuffer(body);
    const res = await fetch(baseUrl() + path, {
      method,
      headers: { ...(raw ? { 'Content-Type': 'video/webm' } : body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: raw ? body : body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, ...(await res.json()) };
  };
  call.media = (url) => fetch(baseUrl() + url, { headers: cookie ? { Cookie: cookie } : {} });
  return call;
}

async function register(username, baseUrl) {
  const call = client(baseUrl);
  assert.equal((await call('POST', '/api/auth/register', { username, password: 'password123' })).status, 200);
  return call;
}

const take = (label, secs) => Buffer.from(`take: ${label} ${secs}s`);
const inDays = (d) => new Date(Date.now() + d * 86400_000).toISOString();
const row = (id) => db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
const brollFiles = () => readdirSync(mediaDir).filter((f) => f.endsWith('.mp4') && readFileSync(join(mediaDir, f), 'utf8').startsWith('broll:'));

// An answer's transcript, as speech-to-text would leave it: words a third of a second apart from
// `at` seconds into the take, with a pause after each sentence.
function transcribed(media, text, at) {
  const words = [];
  for (const w of text.split(' ')) {
    words.push([Math.round(at * 100) / 100, Math.round((at + 0.3) * 100) / 100, ` ${w}`]);
    at += /[.?!]$/.test(w) ? 0.9 : 0.35;
  }
  const cues = [[words[0][0], words.at(-1)[1], text]];
  db.prepare("INSERT INTO transcripts (media, status, text, cues, words, updated_at) VALUES (?, 'ready', ?, ?, ?, ?)").run(media, text, JSON.stringify(cues), JSON.stringify(words), new Date().toISOString());
  return words;
}

// An office hour with one question, answered in a take of `secs` seconds whose answer starts at
// `answerStart`, and queued.
async function answered(expert, asker, secs = 12, answerStart = 2) {
  const { officeHour } = await expert('POST', '/api/office-hours', { title: 'B-roll test', questionsDeadline: inDays(1), answersExpectedAt: inDays(2) });
  const { question } = await asker('POST', `/api/office-hours/${officeHour.id}/questions`, { body: 'How do you cook on a weeknight?' });
  assert.equal((await expert('PUT', `/api/questions/${question.id}/video?answerStart=${answerStart}`, take('answer', secs))).status, 200);
  await expert('PUT', `/api/office-hours/${officeHour.id}/plan`, { items: [{ questionId: question.id }] });
  return { ohId: officeHour.id, qid: question.id };
}

test('the expert describes b-roll for an answer; it is made to fit, and placed where they talk about it', async () => {
  const expert = await register('broll_host');
  const asker = await register('broll_asker');
  assert.equal((await expert('GET', '/api/me')).broll, true);
  const { ohId, qid } = await answered(expert, asker, 20, 2);
  const words = transcribed(row(qid).answer_video, 'First, plan the week. Then chop the onions and peppers for the sauce. Cook it slowly, and taste it as you go.', 3);
  const prompt = 'Close-up of a knife chopping onions on a wooden board';

  // Only the expert, only for a recorded answer, and only with a description.
  assert.equal((await asker('POST', `/api/questions/${qid}/broll`, { prompt })).status, 403);
  assert.equal((await expert('POST', `/api/questions/${qid}/broll`, { prompt: '' })).status, 400);
  const { question: unanswered } = await asker('POST', `/api/office-hours/${ohId}/questions`, { body: 'Not answered yet?' });
  assert.equal((await expert('POST', `/api/questions/${unanswered.id}/broll`, { prompt })).status, 409);

  const res = await expert('POST', `/api/questions/${qid}/broll`, { prompt: `  ${prompt}\n` });
  assert.equal(res.status, 200);
  assert.deepEqual(res.broll, { prompt, status: 'pending', shot: null, video: null, start: null, length: null });
  await app.idle();

  // As long as the answer has room for: 5 seconds, the most made, out of an 18-second answer. The
  // shot is picked knowing the question and what's said in the answer.
  assert.deepEqual(made.at(-1), {
    prompt,
    seconds: 5,
    question: 'How do you cook on a weeknight?',
    answer: 'First, plan the week. Then chop the onions and peppers for the sauce. Cook it slowly, and taste it as you go.',
  });
  const { question } = await expert('GET', `/api/questions/${qid}`);
  assert.equal(question.broll.status, 'ready');
  assert.equal(question.broll.shot, `A scene showing: ${prompt}`);
  assert.match(question.broll.video, /^\/media\/[0-9a-f]{32}\.mp4$/);
  // Cut in as they start talking about chopping the onions, after the answer starts and before it ends.
  assert.deepEqual([question.broll.start, question.broll.length], [words.find(([, , w]) => w === ' Then')[0], 5]);
  // Draft b-roll is the expert's alone.
  assert.equal((await expert.media(question.broll.video)).status, 200);
  assert.equal((await asker.media(question.broll.video)).status, 404);
  assert.ok(!('broll' in (await asker('GET', `/api/questions/${qid}`)).question));
  const page = await asker('GET', `/api/office-hours/${ohId}`);
  assert.ok(page.groups.flatMap((g) => g.questions).every((q) => !('broll' in q)));
});

test('answers too short for b-roll are refused, and b-roll moves with a re-recorded answer', async () => {
  const expert = await register('rerecord_host');
  const asker = await register('rerecord_asker');
  const { qid } = await answered(expert, asker, 3, 1.5); // 1.5 seconds of answer
  assert.deepEqual(await expert('POST', `/api/questions/${qid}/broll`, { prompt: 'A city skyline at dusk' }), { status: 400, error: 'This answer is too short for b-roll' });

  await expert('PUT', `/api/questions/${qid}/video?answerStart=1`, take('longer', 9));
  assert.equal((await expert('POST', `/api/questions/${qid}/broll`, { prompt: 'A city skyline at dusk' })).status, 200);
  await app.idle();
  assert.deepEqual([made.at(-1).prompt, made.at(-1).seconds, made.at(-1).answer], ['A city skyline at dusk', 4.8, null]); // 60% of the 8-second answer, which has no transcript
  // A third of the way in, without a transcript, but with time on camera before and after.
  assert.deepEqual([row(qid).broll_start, row(qid).broll_length], [2.7, 4.8]);

  // A new take: the b-roll is placed again, in that one.
  const res = await expert('PUT', `/api/questions/${qid}/video?answerStart=2`, take('again', 20));
  assert.equal(res.broll.status, 'pending');
  await app.idle();
  let { broll } = (await expert('GET', `/api/questions/${qid}`)).question;
  assert.deepEqual([broll.status, broll.start, broll.length], ['ready', 8, 4.8]);
  assert.equal(made.filter((m) => m.prompt === 'A city skyline at dusk').length, 1); // not made again

  // Removing the answer keeps the b-roll for the next take, unplaced.
  const removed = await expert('DELETE', `/api/questions/${qid}/video`);
  assert.deepEqual([removed.broll.status, removed.broll.start, removed.broll.video], ['ready', null, broll.video]);
  // A take too short for it leaves it out.
  await expert('PUT', `/api/questions/${qid}/video?answerStart=1`, take('short', 3));
  await app.idle();
  ({ broll } = (await expert('GET', `/api/questions/${qid}`)).question);
  assert.deepEqual([broll.status, broll.start, broll.length], ['ready', null, null]);
  assert.ok(existsSync(join(mediaDir, broll.video.split('/').pop())));
});

test('asking again replaces the b-roll, removing it deletes it, and failures are marked', async (t) => {
  const expert = await register('replace_host');
  const asker = await register('replace_asker');
  const { qid } = await answered(expert, asker);
  await expert('POST', `/api/questions/${qid}/broll`, { prompt: 'Steam rising from a pot' });
  await app.idle();
  const first = row(qid).broll_video;
  assert.ok(existsSync(join(mediaDir, first)));
  await expert('POST', `/api/questions/${qid}/broll`, { prompt: 'Steam rising from a big pot' });
  assert.ok(!existsSync(join(mediaDir, first)));
  await app.idle();
  assert.equal(row(qid).broll_prompt, 'Steam rising from a big pot');

  // Removed while it's being made: making it stops, and nothing is left behind.
  const before = new Set(brollFiles());
  const release = hold(t);
  await expert('POST', `/api/questions/${qid}/broll`, { prompt: 'Garlic sizzling in a pan' });
  await new Promise((resolve) => setTimeout(resolve, 20)); // it's started
  assert.deepEqual(await expert('DELETE', `/api/questions/${qid}/broll`), { status: 200, broll: null });
  await app.idle();
  release();
  assert.deepEqual(stopped, ['Garlic sizzling in a pan']);
  assert.ok(!made.some((m) => m.prompt === 'Garlic sizzling in a pan'));
  assert.equal(row(qid).broll_status, null);
  assert.deepEqual(brollFiles().filter((f) => !before.has(f)), []);
  assert.equal(brollFiles().filter((f) => before.has(f)).length, before.size - 1); // the one before was removed too

  const res = await expert('POST', `/api/questions/${qid}/broll`, { prompt: 'A pan on fire [fail]' });
  assert.equal(res.status, 200);
  await app.idle();
  const { broll } = (await expert('GET', `/api/questions/${qid}`)).question;
  assert.deepEqual(broll, { prompt: 'A pan on fire [fail]', status: 'failed', shot: null, video: null, start: null, length: null });
  assert.ok(!existsSync(join(mediaDir, row(qid).broll_video)));
});

test('publishing waits for b-roll being made, then publishes it with the answer and joins it in', async (t) => {
  const expert = await register('publish_host');
  const asker = await register('publish_asker');
  const reader = client();
  const { ohId, qid } = await answered(expert, asker, 12, 2);
  // Another answer, with b-roll, that isn't in the answer order: its b-roll can never be published.
  const { question: other } = await asker('POST', `/api/office-hours/${ohId}/questions`, { body: 'Left out of the answers?' });
  await expert('PUT', `/api/questions/${other.id}/video`, take('left out', 8));
  await expert('POST', `/api/questions/${other.id}/broll`, { prompt: 'Rain on a window' });
  await app.idle();
  const leftOver = row(other.id).broll_video;

  const release = hold(t);
  await expert('POST', `/api/questions/${qid}/broll`, { prompt: 'A busy farmers market' });
  const refused = await expert('POST', `/api/office-hours/${ohId}/publish`);
  assert.deepEqual(refused, { status: 409, error: 'The b-roll for question 1 is still being made. Wait for it, or remove it, before publishing.' });
  release();
  await app.idle();
  assert.equal((await expert('POST', `/api/office-hours/${ohId}/publish`)).status, 200);
  await app.idle();

  const q = row(qid);
  assert.deepEqual(joins.at(-1).map((tk) => tk.broll), [{ file: join(mediaDir, q.broll_video), start: q.broll_start, length: q.broll_length }]);
  const { answers } = await reader('GET', `/api/office-hours/${ohId}`);
  assert.deepEqual(answers[0].broll, { video: `/media/${q.broll_video}`, start: q.broll_start, length: q.broll_length });
  assert.equal((await reader.media(answers[0].broll.video)).status, 200); // public, like the answer
  assert.ok(!existsSync(join(mediaDir, leftOver)));
  assert.equal(row(other.id).broll_status, null);
  // Published answers are final, b-roll included.
  assert.equal((await expert('POST', `/api/questions/${qid}/broll`, { prompt: 'Something else' })).status, 409);
  assert.equal((await expert('DELETE', `/api/questions/${qid}/broll`)).status, 409);
});

test('on startup, b-roll that was being made is made and placed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forum_broll_resume_'));
  try {
    const oldDb = openDb(':memory:');
    const [answer, clip] = [`${'a'.repeat(32)}.webm`, `${'b'.repeat(32)}.mp4`];
    oldDb.exec(`
      INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (1, 'old', 'Old', 'x', '2026-01-01');
      INSERT INTO office_hours (id, expert_id, title, questions_deadline, answers_expected_at, created_at) VALUES (1, 1, 'Old', '2026-01-02', '2026-01-03', '2026-01-01');
      INSERT INTO questions (id, office_hour_id, author_id, body, created_at, plan_position, answer_video, answer_start, broll_prompt, broll_status, broll_video) VALUES
        (1, 1, 1, 'Old question?', '2026-01-01', 1, '${answer}', 1, 'Waves on a beach', 'pending', '${clip}');
    `);
    writeFileSync(join(dir, answer), take('old', 6));
    const resumed = createApp({ db: oldDb, moderator: await createModerator({ mode: 'heuristic' }), mediaDir: dir, broll: fakeBroll });
    await resumed.idle();
    const q = oldDb.prepare('SELECT broll_status, broll_start, broll_length FROM questions WHERE id = 1').get();
    assert.deepEqual({ ...q }, { broll_status: 'ready', broll_start: 2, broll_length: 3 });
    assert.ok(existsSync(join(dir, clip)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without b-roll, experts are told it is not available', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forum_broll_off_'));
  const offServer = createServer(createApp({ db: openDb(':memory:'), moderator: await createModerator({ mode: 'heuristic' }), mediaDir: dir }));
  await new Promise((resolve) => offServer.listen(0, resolve));
  const offBase = () => `http://localhost:${offServer.address().port}`;
  try {
    const expert = await register('plain_broll_host', offBase);
    const asker = await register('plain_broll_asker', offBase);
    assert.equal((await expert('GET', '/api/me')).broll, false);
    const { qid } = await answered(expert, asker);
    assert.deepEqual(await expert('POST', `/api/questions/${qid}/broll`, { prompt: 'Waves on a beach' }), { status: 503, error: 'B-roll is not available on this server' });
  } finally {
    offServer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('b-roll is off when asked, or when ffmpeg is missing', () => {
  assert.equal(createBroll({ mode: 'off' }), null);
  const oldPath = process.env.PATH;
  process.env.PATH = '/nonexistent';
  try {
    const logs = [];
    assert.equal(createBroll({ mode: 'auto', gemini: null, log: (msg) => logs.push(msg) }), null);
    assert.match(logs[0], /ffmpeg and ffprobe not found/);
  } finally {
    process.env.PATH = oldPath;
  }
});

const hasFfmpeg = !spawnSync('ffmpeg', ['-version']).error && !spawnSync('ffprobe', ['-version']).error;

test("a recording's duration, even when its header doesn't say", { skip: !hasFfmpeg && 'ffmpeg is not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forum_broll_duration_'));
  try {
    // Written to a pipe, as MediaRecorder streams it, a WebM can't go back to note its duration.
    const webm = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=30:duration=2.5', '-c:v', 'libvpx', '-f', 'webm', '-']);
    writeFileSync(join(dir, 'streamed.webm'), webm);
    const stated = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', join(dir, 'streamed.webm')]).toString().trim();
    assert.equal(stated, 'N/A');
    const secs = await mediaDuration(join(dir, 'streamed.webm'));
    assert.ok(Math.abs(secs - 2.5) < 0.05, `${secs}s`);
    await assert.rejects(mediaDuration(join(dir, 'missing.webm')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// OpenAI, stood in for by a fake fetch: records each request, and answers from `reply(path, body)`.
async function withFakeOpenAI(t, reply) {
  const { createOpenAIPlanner } = await import('../src/broll/openai.js');
  const realFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const path = String(url).replace('https://api.openai.com/v1/', '');
    const body = JSON.parse(init.body);
    requests.push({ path, body, auth: init.headers.Authorization });
    const [status, data] = await reply(path, body);
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => (globalThis.fetch = realFetch));
  return { planner: createOpenAIPlanner({ apiKey: 'sk-test', textModel: 'gpt-test', imageModel: 'image-test' }), requests };
}
const shotReply = (shot, frame) => [200, { status: 'completed', output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ shot, frame }) }] }] }];

test('with an OpenAI key, GPT writes up the shot and gpt-image draws its first frame', async (t) => {
  const shot = 'A worried clerk holds out the last concert ticket while two customers reach for it with cash at a small box office.';
  const { planner, requests } = await withFakeOpenAI(t, (path) => (path === 'responses' ? shotReply(`  ${shot}\n`, 'A clerk holds one ticket between two customers.') : [200, { data: [{ b64_json: Buffer.from('png bytes').toString('base64') }] }]));
  assert.equal(planner.name, 'gpt-test + image-test');
  const plan = await planner.plan({ prompt: 'show when eventual consistency is dangerous', question: 'When is it dangerous?', answer: 'You sell the last ticket twice.' });
  assert.deepEqual(plan, { shot, frame: 'A clerk holds one ticket between two customers.' });
  const [ask] = requests;
  assert.equal(ask.auth, 'Bearer sk-test');
  assert.equal(ask.body.model, 'gpt-test');
  assert.match(ask.body.instructions, /Never turn a diagram into a scene/); // the local writer's rules, shot.md
  assert.match(ask.body.instructions, /first frame as a still image/);
  assert.equal(ask.body.input, '<question>\nWhen is it dangerous?\n</question>\n<answer>\nYou sell the last ticket twice.\n</answer>\n<b_roll>\nshow when eventual consistency is dangerous\n</b_roll>');
  assert.equal(ask.body.text.format.type, 'json_schema');

  const dir = mkdtempSync(join(tmpdir(), 'forum_broll_openai_'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await planner.draw(plan.frame, join(dir, 'frame.png'));
  assert.equal(readFileSync(join(dir, 'frame.png'), 'utf8'), 'png bytes');
  assert.deepEqual([requests[1].path, requests[1].body.model, requests[1].body.size], ['images/generations', 'image-test', '1536x1024']);
  assert.match(requests[1].body.prompt, /^A clerk holds one ticket between two customers\.\n\n.*No captions/);
});

test("OpenAI's errors and empty shots are reported, and there's no planner without a key", async (t) => {
  const { createOpenAIPlanner } = await import('../src/broll/openai.js');
  assert.equal(createOpenAIPlanner({ apiKey: '' }), null);
  let next = [429, { error: { message: 'Rate limit reached' } }];
  const { planner } = await withFakeOpenAI(t, () => next);
  await assert.rejects(planner.plan({ prompt: 'anything' }), /OpenAI responses failed \(429\): Rate limit reached/);
  next = shotReply('A park.', 'A park.');
  await assert.rejects(planner.plan({ prompt: 'anything' }), /shot came out as/);
  next = [200, { data: [] }];
  await assert.rejects(planner.draw('A park.', join(tmpdir(), 'unused.png')), /drew no image/);
});

test('when planning with OpenAI fails, the shot is written up locally instead', async () => {
  const logs = [];
  const planner = { name: 'fake', plan: async () => Promise.reject(new Error('Rate limit reached')), draw: async () => {} };
  const oldPath = process.env.PATH;
  process.env.PATH = '/nonexistent'; // so the generator itself can't start, once planning is done
  try {
    const broll = createBroll({ mode: 'on', planner, gemini: null, log: (msg) => logs.push(msg) });
    assert.equal(broll.name, 'ltx-video 2b, shots written by fake');
    await assert.rejects(broll.generate('Waves on a beach', join(tmpdir(), 'unused.mp4'), { seconds: 4 }), /Couldn't start making b-roll/);
    assert.match(logs.join('\n'), /writing up the shot with fake failed, so it's written up locally: Rate limit reached/);
  } finally {
    process.env.PATH = oldPath;
  }
});

// The Gemini API, stood in for by a fake fetch: records each request, and answers from `reply(url, body)`.
async function withFakeGemini(t, reply) {
  const { createGemini } = await import('../src/broll/gemini.js');
  const realFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ url: String(url), body, key: init.headers?.['x-goog-api-key'] });
    const [status, data] = await reply(String(url), body);
    return new Response(typeof data === 'string' ? data : JSON.stringify(data), { status });
  };
  t.after(() => (globalThis.fetch = realFetch));
  return { gemini: createGemini({ apiKey: 'gm-test', videoModel: 'veo-test', textModel: 'gemini-test', poll: 1 }), requests };
}
const API = 'https://generativelanguage.googleapis.com/v1beta';

test('with a Gemini key, Veo films the shot: started, waited for, then downloaded', async (t) => {
  let polls = 0;
  const { gemini, requests } = await withFakeGemini(t, (url) => {
    if (url.endsWith(':predictLongRunning')) return [200, { name: 'models/veo-test/operations/op1' }];
    if (url.endsWith('/operations/op1')) return [200, ++polls < 2 ? { name: 'models/veo-test/operations/op1', done: false } : { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://files.example/v1.mp4' } }] } } }];
    if (url === 'https://files.example/v1.mp4') return [200, 'mp4 bytes'];
    return [404, {}];
  });
  assert.equal(gemini.maxSeconds, 8);
  const dir = mkdtempSync(join(tmpdir(), 'forum_broll_veo_'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // 5 seconds asked for: Veo makes 4, 6 or 8, so 6.
  assert.deepEqual(await gemini.film('A clerk holds out one ticket.', join(dir, 'clip.mp4'), { seconds: 5 }), { seconds: 6 });
  assert.equal(readFileSync(join(dir, 'clip.mp4'), 'utf8'), 'mp4 bytes');
  assert.deepEqual(readdirSync(dir), ['clip.mp4']);
  assert.equal(requests[0].url, `${API}/models/veo-test:predictLongRunning`);
  assert.deepEqual(requests[0].body.instances, [{ prompt: 'A clerk holds out one ticket.' }]);
  assert.deepEqual([requests[0].body.parameters.aspectRatio, requests[0].body.parameters.durationSeconds], ['16:9', 6]);
  assert.ok(requests.every((r) => r.key === 'gm-test')); // the download too
  assert.equal(requests.length, 4); // started, waited for twice, downloaded
});

test("Veo's refusals and errors are reported, and Gemini writes up the shot", async (t) => {
  let next;
  const { gemini, requests } = await withFakeGemini(t, (url) => next(url));
  const dir = mkdtempSync(join(tmpdir(), 'forum_broll_veo_'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  next = () => [429, { error: { message: 'You exceeded your current quota, please check your plan and billing details.' } }];
  await assert.rejects(gemini.film('Anything.', join(dir, 'a.mp4'), { seconds: 4 }), /Gemini predictLongRunning failed \(429\): You exceeded your current quota/);
  next = (url) => [200, url.endsWith(':predictLongRunning') ? { name: 'op2' } : { done: true, response: { generateVideoResponse: { raiMediaFilteredReasons: ['The prompt was blocked.'] } } }];
  await assert.rejects(gemini.film('Anything.', join(dir, 'a.mp4'), { seconds: 4 }), /Veo made no video: The prompt was blocked\./);
  assert.deepEqual(readdirSync(dir), []);

  next = () => [200, { candidates: [{ content: { parts: [{ text: '  Two guests reach for the last VIP pass on a marble counter at the same moment.\n' }] } }] }];
  const plan = await gemini.plan({ prompt: 'eventual consistency', question: 'When is it dangerous?', answer: null });
  assert.deepEqual(plan, { shot: 'Two guests reach for the last VIP pass on a marble counter at the same moment.' });
  const ask = requests.at(-1);
  assert.equal(ask.url, `${API}/models/gemini-test:generateContent`);
  assert.match(ask.body.systemInstruction.parts[0].text, /Never turn a diagram into a scene/);
  assert.equal(ask.body.contents[0].parts[0].text, '<question>\nWhen is it dangerous?\n</question>\n<b_roll>\neventual consistency\n</b_roll>');
});

test("b-roll is filmed by Veo when it can be, and locally when it can't", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'forum_broll_engine_'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filmed = [];
  let veoFails = false;
  const gemini = {
    videoName: 'veo-fake',
    textName: 'gemini-fake',
    maxSeconds: 8,
    async film(shot, out, { seconds }) {
      if (veoFails) throw new Error('You exceeded your current quota');
      filmed.push({ shot, seconds });
      writeFileSync(out, 'veo clip');
      return { seconds: 6 };
    },
    plan: async ({ prompt }) => ({ shot: `Gemini's shot of ${prompt}` }),
  };
  const planner = { name: 'gpt-fake', plan: async ({ prompt }) => ({ shot: `GPT's shot of ${prompt}`, frame: 'a frame' }), draw: async () => {} };
  const logs = [];
  const log = (msg) => logs.push(msg);

  // GPT writes the shot when there's an OpenAI key, else Gemini; Veo films it.
  let broll = createBroll({ mode: 'on', planner, gemini, log });
  assert.equal(broll.name, 'veo-fake, or ltx-video 2b locally, shots written by gpt-fake');
  assert.equal(broll.maxSeconds, 8);
  assert.deepEqual(await broll.generate('a ticket counter', join(dir, 'a.mp4'), { seconds: 5 }), { seconds: 6, shot: "GPT's shot of a ticket counter" });
  broll = createBroll({ mode: 'on', planner: null, gemini, log });
  assert.equal((await broll.generate('a ticket counter', join(dir, 'b.mp4'), { seconds: 5 })).shot, "Gemini's shot of a ticket counter");
  assert.deepEqual(filmed.map((f) => f.seconds), [5, 5]);

  // Out of Veo quota: filmed locally instead (here, where uv can't start, that fails too).
  veoFails = true;
  const oldPath = process.env.PATH;
  process.env.PATH = '/nonexistent';
  try {
    await assert.rejects(broll.generate('a ticket counter', join(dir, 'c.mp4'), { seconds: 5 }), /Couldn't start making b-roll/);
    assert.match(logs.join('\n'), /Veo couldn't film it, so it's filmed locally: You exceeded your current quota/);
    // Without uv there's nothing to fall back on, so Veo's error is the one reported.
    const veoOnly = createBroll({ mode: 'auto', planner: null, gemini, log });
    assert.equal(veoOnly, null); // nor ffmpeg, in this PATH
  } finally {
    process.env.PATH = oldPath;
  }
});
