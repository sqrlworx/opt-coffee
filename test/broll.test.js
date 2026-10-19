import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createBroll, mediaDuration, prepareUpload } from '../src/broll/index.js';
import { createModerator } from '../src/moderator/index.js';

// Stands in for LTX-Video, ffmpeg and ffprobe: a "video" says how long it is ("take: <label> <seconds>s"),
// and making b-roll writes one of those, as long as it was asked for, recording what was asked in
// `made`. The shot it films is the description, written up. A description with "[fail]" fails.
// `hold(t)` makes it wait until released, or stopped (recorded in `stopped`). An uploaded video is
// one too, and getting it ready keeps as much of it as was asked for, recording what was asked in
// `prepared`; one saying "[unreadable]" can't be read.
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
const prepared = [];
const fakeBroll = {
  name: 'fake',
  model: 'fake-video',
  async generate(prompt, out, { seconds, question, answer, signal }) {
    await Promise.race([gate, new Promise((resolve, reject) => signal?.addEventListener('abort', () => (stopped.push(prompt), reject(new Error('killed')))))]);
    if (prompt.includes('[fail]')) throw new Error('out of memory');
    made.push({ prompt, seconds, question, answer });
    writeFileSync(out, `broll: ${prompt} ${seconds}s`);
    return { seconds, shot: `A scene showing: ${prompt}` };
  },
  async prepare(src, out, { seconds }) {
    const upload = readFileSync(src, 'utf8');
    if (upload.includes('[unreadable]')) throw new Error('Invalid data found when processing input');
    prepared.push({ upload, seconds });
    const original = Number(/ ([\d.]+)s$/.exec(upload)[1]);
    writeFileSync(out, `broll: ${upload} ${Math.min(original, seconds)}s`);
    return { seconds: Math.min(original, seconds), original };
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
  const call = async function call(method, path, body, type = 'video/webm') {
    const raw = Buffer.isBuffer(body);
    const res = await fetch(baseUrl() + path, {
      method,
      headers: { ...(raw ? { 'Content-Type': type } : body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
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
  const me = await expert('GET', '/api/me');
  assert.deepEqual([me.broll, me.makesBroll, me.brollModel], [true, true, 'fake-video']); // the planner names the model
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
  assert.deepEqual(res.broll, { prompt, upload: null, status: 'pending', shot: null, video: null, start: null, length: null, full: false });
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
  assert.deepEqual(broll, { prompt: 'A pan on fire [fail]', upload: null, status: 'failed', shot: null, video: null, start: null, length: null, full: false });
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
  assert.deepEqual(joins.at(-1).map((tk) => tk.broll), [{ file: join(mediaDir, q.broll_video), start: q.broll_start, length: q.broll_length, full: false }]);
  const { answers } = await reader('GET', `/api/office-hours/${ohId}`);
  assert.deepEqual(answers[0].broll, { video: `/media/${q.broll_video}`, start: q.broll_start, length: q.broll_length, full: false });
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

test('the expert uploads a video of their own as b-roll; as much of its start as fits is placed where they talk about it', async () => {
  const expert = await register('upload_host');
  const asker = await register('upload_asker');
  assert.equal((await expert('GET', '/api/me')).makesBroll, true);
  const { ohId, qid } = await answered(expert, asker, 20, 2);
  const words = transcribed(row(qid).answer_video, 'First, plan the week. Then chop the onions and peppers for the sauce. Cook it slowly, and taste it as you go.', 3);
  const upload = (query, body, type) => expert('PUT', `/api/questions/${qid}/broll/video?${new URLSearchParams(query)}`, body, type);

  // Only the expert, only for a recorded answer, and only a video.
  assert.equal((await asker('PUT', `/api/questions/${qid}/broll/video?name=a.mov`, take('clip', 4))).status, 403);
  assert.deepEqual(await upload({ name: 'notes.txt' }, Buffer.from('hello'), 'text/plain'), { status: 415, error: 'Expected a video' });
  const { question: unanswered } = await asker('POST', `/api/office-hours/${ohId}/questions`, { body: 'Not answered yet?' });
  assert.equal((await expert('PUT', `/api/questions/${unanswered.id}/broll/video?name=a.mov`, take('clip', 4))).status, 409);
  // Nothing is kept of what can't be read as a video, or is too short to cut away to.
  const files = readdirSync(mediaDir).length;
  assert.deepEqual(await upload({ name: 'broken.mov' }, take('[unreadable]', 4), 'video/quicktime'), { status: 415, error: "That file couldn't be read as a video. Try an MP4, MOV or WebM." });
  assert.deepEqual(await upload({ name: 'blink.mov' }, take('blink', 1)), { status: 400, error: 'This clip is too short for b-roll' });
  assert.equal(readdirSync(mediaDir).length, files);

  // 30 seconds of video for an 18-second answer, which has room for 10.8 seconds of b-roll: its
  // first 10.8 seconds are used, which the expert is told.
  const res = await upload({ name: 'Kitchen\tprep.mov\n', description: '  Chopping onions\n on a board ' }, take('kitchen', 30), 'video/quicktime');
  assert.equal(res.status, 200);
  assert.deepEqual(res.broll, { prompt: 'Chopping onions on a board', upload: 'Kitchen prep.mov', status: 'pending', shot: null, video: null, start: null, length: null, full: false });
  assert.deepEqual(res.trimmed, { from: 30, to: 10.8 });
  assert.deepEqual(prepared.at(-1), { upload: 'take: kitchen 30s', seconds: 10.8 });
  assert.equal(readdirSync(mediaDir).length, files + 1); // the clip; not the upload itself
  await app.idle();
  const { question } = await expert('GET', `/api/questions/${qid}`);
  assert.deepEqual([question.broll.status, question.broll.shot], ['ready', null]);
  // Cut in as they start talking about chopping the onions.
  assert.deepEqual([question.broll.start, question.broll.length], [words.find(([, , w]) => w === ' Then')[0], 10.8]);
  assert.equal(readFileSync(join(mediaDir, question.broll.video.split('/').pop()), 'utf8'), 'broll: take: kitchen 30s 10.8s');
  assert.equal((await expert.media(question.broll.video)).status, 200);
  assert.equal((await asker.media(question.broll.video)).status, 404); // the expert's alone until published

  // Making b-roll instead replaces it, and the clip is deleted.
  const uploaded = row(qid).broll_video;
  await expert('POST', `/api/questions/${qid}/broll`, { prompt: 'Onions sizzling in a pan' });
  assert.ok(!existsSync(join(mediaDir, uploaded)));
  assert.equal(row(qid).broll_upload, null);
  await app.idle();
});

test('an uploaded video is placed right away, even while other b-roll is being made, and by its name without a description', async (t) => {
  const expert = await register('upload_queue_host');
  const asker = await register('upload_queue_asker');
  const first = await answered(expert, asker, 20, 2);
  const second = await answered(expert, asker, 20, 2);
  const words = transcribed(row(second.qid).answer_video, 'Start with the basics. Taste the sauce as it simmers, then season it.', 3);
  // B-roll being made for the first answer, which takes minutes.
  const release = hold(t);
  await expert('POST', `/api/questions/${first.qid}/broll`, { prompt: 'Steam over a pot of soup' });
  await new Promise((resolve) => setTimeout(resolve, 20)); // it's started

  const res = await expert('PUT', `/api/questions/${second.qid}/broll/video?name=simmering_sauce-closeup.MOV`, take('sauce', 4), 'application/octet-stream');
  assert.deepEqual([res.status, res.broll.prompt, res.broll.upload, res.trimmed], [200, null, 'simmering_sauce-closeup.MOV', null]);
  for (let i = 0; row(second.qid).broll_status === 'pending' && i < 200; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(row(first.qid).broll_status, 'pending');
  // Cut in as they talk about the sauce simmering, which its name says it shows.
  assert.deepEqual([row(second.qid).broll_status, row(second.qid).broll_start, row(second.qid).broll_length], ['ready', words.find(([, , w]) => w === ' Taste')[0], 4]);

  // Uploading one for the first answer stops the b-roll being made for it.
  assert.equal((await expert('PUT', `/api/questions/${first.qid}/broll/video?name=soup.mp4`, take('soup', 6), 'video/mp4')).status, 200);
  await app.idle();
  release();
  assert.ok(stopped.includes('Steam over a pot of soup'));
  assert.ok(!made.some((m) => m.prompt === 'Steam over a pot of soup'));
  assert.deepEqual([row(first.qid).broll_status, row(first.qid).broll_upload, row(first.qid).broll_prompt], ['ready', 'soup.mp4', null]);
});

test('an uploaded video can be full screen instead of split screen, through re-recording, publishing and joining', async () => {
  const expert = await register('full_host');
  const asker = await register('full_asker');
  const reader = client();
  const { ohId, qid } = await answered(expert, asker, 20, 2);
  const upload = (query) => expert('PUT', `/api/questions/${qid}/broll/video?${new URLSearchParams({ name: 'whisking.mov', ...query })}`, take('whisking', 4), 'video/quicktime');

  const res = await upload({ full: '1' });
  assert.deepEqual([res.status, res.broll.full], [200, true]);
  await app.idle();
  assert.deepEqual([row(qid).broll_status, row(qid).broll_full], ['ready', 1]);
  // Placed again in a new take, it's still full screen.
  await expert('PUT', `/api/questions/${qid}/video?answerStart=2`, take('again', 16));
  await app.idle();
  const { broll } = (await expert('GET', `/api/questions/${qid}`)).question;
  assert.deepEqual([broll.status, broll.start != null, broll.full], ['ready', true, true]);

  // Uploading again without it, making b-roll and removing it all go back to split screen.
  assert.equal((await upload({})).broll.full, false);
  assert.equal((await upload({ full: '1' })).broll.full, true);
  assert.equal((await expert('POST', `/api/questions/${qid}/broll`, { prompt: 'A whisk beating eggs' })).broll.full, false);
  await app.idle();
  assert.equal((await upload({ full: '1' })).broll.full, true);
  await expert('DELETE', `/api/questions/${qid}/broll`);
  assert.equal(row(qid).broll_full, 0);

  // Published, and joined, full screen; readers get it that way.
  assert.equal((await upload({ full: '1' })).status, 200);
  await app.idle();
  assert.equal((await expert('POST', `/api/office-hours/${ohId}/publish`)).status, 200);
  await app.idle();
  const q = row(qid);
  assert.deepEqual(joins.at(-1).map((tk) => tk.broll), [{ file: join(mediaDir, q.broll_video), start: q.broll_start, length: q.broll_length, full: true }]);
  const { answers } = await reader('GET', `/api/office-hours/${ohId}`);
  assert.equal(answers[0].broll.full, true);
});

test('on startup, an uploaded video being placed is placed, and one that has gone is marked failed, not made', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forum_broll_resume_upload_'));
  try {
    const oldDb = openDb(':memory:');
    const [answer, clip, gone] = [`${'a'.repeat(32)}.webm`, `${'c'.repeat(32)}.mp4`, `${'d'.repeat(32)}.mp4`];
    oldDb.exec(`
      INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (1, 'old', 'Old', 'x', '2026-01-01');
      INSERT INTO office_hours (id, expert_id, title, questions_deadline, answers_expected_at, created_at) VALUES (1, 1, 'Old', '2026-01-02', '2026-01-03', '2026-01-01');
      INSERT INTO questions (id, office_hour_id, author_id, body, created_at, plan_position, answer_video, answer_start, broll_prompt, broll_upload, broll_status, broll_video) VALUES
        (1, 1, 1, 'Old question?', '2026-01-01', 1, '${answer}', 1, NULL, 'waves.mov', 'pending', '${clip}'),
        (2, 1, 1, 'Another one?', '2026-01-01', 2, '${answer}', 1, 'Gulls over the sea', 'gulls.mov', 'pending', '${gone}');
    `);
    writeFileSync(join(dir, answer), take('old', 6));
    writeFileSync(join(dir, clip), 'broll: waves 3s');
    const resumed = createApp({ db: oldDb, moderator: await createModerator({ mode: 'heuristic' }), mediaDir: dir, broll: fakeBroll });
    await resumed.idle();
    const q = (id) => ({ ...oldDb.prepare('SELECT broll_status, broll_start, broll_length FROM questions WHERE id = ?').get(id) });
    assert.deepEqual(q(1), { broll_status: 'ready', broll_start: 2, broll_length: 3 });
    assert.deepEqual(q(2), { broll_status: 'failed', broll_start: null, broll_length: null });
    assert.ok(!made.some((m) => m.prompt === 'Gulls over the sea'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with nothing to make b-roll with, it can still be uploaded", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'forum_broll_uploads_only_'));
  const onlyApp = createApp({ db: openDb(':memory:'), moderator: await createModerator({ mode: 'heuristic' }), mediaDir: dir, broll: { ...fakeBroll, generate: null } });
  const onlyServer = createServer(onlyApp);
  await new Promise((resolve) => onlyServer.listen(0, resolve));
  t.after(() => {
    onlyServer.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const onlyBase = () => `http://localhost:${onlyServer.address().port}`;
  const expert = await register('uploads_only_host', onlyBase);
  const asker = await register('uploads_only_asker', onlyBase);
  const me = await expert('GET', '/api/me');
  assert.deepEqual([me.broll, me.makesBroll, me.brollModel], [true, false, null]);
  const { qid } = await answered(expert, asker);
  assert.deepEqual(await expert('POST', `/api/questions/${qid}/broll`, { prompt: 'Waves on a beach' }), { status: 503, error: "B-roll can't be made on this server, only uploaded" });
  assert.equal((await expert('PUT', `/api/questions/${qid}/broll/video?name=waves.mp4`, take('waves', 4), 'video/mp4')).status, 200);
  await onlyApp.idle();
  assert.equal((await expert('GET', `/api/questions/${qid}`)).question.broll.status, 'ready');
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
    assert.deepEqual(await expert('PUT', `/api/questions/${qid}/broll/video?name=waves.mp4`, take('waves', 4)), { status: 503, error: 'B-roll is not available on this server' });
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

test('with ffmpeg but neither a Gemini key nor uv, b-roll can only be uploaded', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, (t) => {
  // A PATH with ffmpeg and ffprobe on it, and nothing else.
  const bin = mkdtempSync(join(tmpdir(), 'forum_broll_bin_'));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  for (const tool of ['ffmpeg', 'ffprobe']) symlinkSync(process.env.PATH.split(':').map((dir) => join(dir, tool)).find((path) => existsSync(path)), join(bin, tool));
  const oldPath = process.env.PATH;
  process.env.PATH = bin;
  try {
    const logs = [];
    const broll = createBroll({ mode: 'auto', planner: null, gemini: null, log: (msg) => logs.push(msg) });
    assert.deepEqual([broll.name, broll.generate, broll.prepare], ['uploaded only', null, prepareUpload]);
    assert.match(logs[0], /experts can upload b-roll but it can't be made for them/);
  } finally {
    process.env.PATH = oldPath;
  }
});

test('an uploaded video is made into a clip like those that are made: H.264, at most 1080p and 30 fps, without its sound or metadata', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'forum_broll_prepare_'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ffmpeg = (...args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args]);
  const probe = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,avg_frame_rate,color_transfer:format_tags', '-of', 'json', file]));

  // As a camera films it: bigger than 1080p, at 60 fps, with sound and where it was filmed.
  ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=2560x1440:rate=60:duration=3', '-f', 'lavfi', '-i', 'sine=duration=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-metadata', 'location=+37.4848-122.1484/', join(dir, 'camera.mov'));
  const { seconds, original } = await prepareUpload(join(dir, 'camera.mov'), join(dir, 'clip.mp4'), { seconds: 2 });
  assert.equal(seconds, 2);
  assert.ok(Math.abs(original - 3) < 0.05, `${original}s`);
  const { streams, format } = probe(join(dir, 'clip.mp4'));
  assert.deepEqual(streams.map((s) => [s.codec_type, s.codec_name, s.width, s.height, s.avg_frame_rate]), [['video', 'h264', 1920, 1080, '30/1']]);
  assert.ok(!('location' in (format.tags ?? {})));
  assert.deepEqual(readdirSync(dir).sort(), ['camera.mov', 'clip.mp4']); // nothing left half made

  // HDR, as phones film by default, is brought into ordinary range (with zscale, which ffmpeg usually has).
  ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=2', '-vf', 'setparams=range=tv:color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, 'hdr.mp4'));
  assert.equal(probe(join(dir, 'hdr.mp4')).streams[0].color_transfer, 'arib-std-b67');
  await prepareUpload(join(dir, 'hdr.mp4'), join(dir, 'sdr.mp4'), { seconds: 5 });
  const zscale = execFileSync('ffmpeg', ['-hide_banner', '-filters']).toString().includes(' zscale ');
  assert.equal(probe(join(dir, 'sdr.mp4')).streams[0].color_transfer, zscale ? 'bt709' : 'arib-std-b67');

  // Sound with a cover picture, or something that isn't a video at all, can't be made into one.
  ffmpeg('-f', 'lavfi', '-i', 'color=red:size=64x64', '-frames:v', '1', join(dir, 'cover.jpg'));
  ffmpeg('-f', 'lavfi', '-i', 'sine=duration=2', '-i', join(dir, 'cover.jpg'), '-map', '0', '-map', '1', '-c:a', 'aac', '-c:v', 'copy', '-disposition:v:0', 'attached_pic', join(dir, 'song.m4a'));
  await assert.rejects(prepareUpload(join(dir, 'song.m4a'), join(dir, 'song.mp4'), { seconds: 2 }), /has no video/);
  writeFileSync(join(dir, 'notes.mov'), 'not a video');
  await assert.rejects(prepareUpload(join(dir, 'notes.mov'), join(dir, 'notes.mp4'), { seconds: 2 }));
  assert.ok(!existsSync(join(dir, 'song.mp4')) && !existsSync(join(dir, 'notes.mp4')));
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
    assert.equal(broll.model, 'LTX-Video 2B');
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
  assert.equal(broll.model, 'veo-fake');
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
