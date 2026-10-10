import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createModerator } from '../src/moderator/index.js';
import { createVideoJoiner } from '../src/video.js';

// Stands in for ffmpeg: a "video" says how long it is ("take: <label> <seconds>s"), and joining
// writes them one after another. `hold(t)` makes joining wait until released, `failNext` fails it.
let gate = null;
let failNext = false;
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
const joins = [];
const fakeJoiner = {
  async join(files, out) {
    await gate;
    if (failNext) {
      failNext = false;
      writeFileSync(out, 'half a video'); // a failed join mustn't leave this behind
      throw new Error('ffmpeg exited with code 1');
    }
    const takes = files.map((f) => readFileSync(f, 'utf8'));
    joins.push(takes);
    writeFileSync(out, takes.join('\n'));
    return takes.map((t) => Number(/ ([\d.]+)s$/.exec(t)[1]));
  },
};

let server;
let app;
let base;
let db;
let mediaDir;

before(async () => {
  db = openDb(':memory:');
  mediaDir = mkdtempSync(join(tmpdir(), 'forum_video_media_'));
  app = createApp({ db, moderator: await createModerator({ mode: 'heuristic' }), mediaDir, joiner: fakeJoiner });
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

// An office hour with an answer recorded for each of `answers` ([question, seconds]), queued in that order.
async function recorded(expert, asker, answers) {
  const { officeHour } = await expert('POST', '/api/office-hours', { title: 'Video test', questionsDeadline: inDays(1), answersExpectedAt: inDays(2) });
  const ids = [];
  for (const [body, secs] of answers) {
    const { question } = await asker('POST', `/api/office-hours/${officeHour.id}/questions`, { body });
    assert.equal((await expert('PUT', `/api/questions/${question.id}/video`, take(body, secs))).status, 200);
    ids.push(question.id);
  }
  await expert('PUT', `/api/office-hours/${officeHour.id}/plan`, { items: ids.map((questionId) => ({ questionId })) });
  return { ohId: officeHour.id, ids };
}

test('publishing joins the answers into one public video, in the published order', async (t) => {
  const expert = await register('joiner_host');
  const asker = await register('joiner_asker');
  const reader = client();
  const { ohId, ids } = await recorded(expert, asker, [['First question here?', 7.5], ['Second question here?', 12.25], ['Third question here?', 4]]);
  // Reordered, and the second one left out of the answer order.
  await expert('PUT', `/api/office-hours/${ohId}/plan`, { items: [{ questionId: ids[2] }, { questionId: ids[0] }] });
  assert.equal((await reader('GET', `/api/office-hours/${ohId}`)).video, null); // not published yet

  const release = hold(t);
  await expert('POST', `/api/office-hours/${ohId}/publish`);
  // While it's being joined, readers see the office hour as closed: no answers, nothing in feeds.
  let page = await reader('GET', `/api/office-hours/${ohId}`);
  assert.equal(page.officeHour.status, 'closed');
  assert.equal(page.officeHour.publishedAt, null);
  assert.equal(page.officeHour.processing, false);
  assert.deepEqual([page.answers, page.video], [[], null]);
  assert.ok(!('publishedAnswerVideo' in (await reader('GET', `/api/questions/${ids[0]}`)).question));
  assert.ok(!(await asker('GET', '/api/feed')).items.some((i) => i.type === 'published' && i.officeHour.id === ohId));
  assert.ok(!(await reader('GET', '/api/explore')).published.some((oh) => oh.id === ohId));
  // The expert sees it's published and being processed.
  page = await expert('GET', `/api/office-hours/${ohId}`);
  assert.deepEqual([page.officeHour.status, page.officeHour.processing], ['published', true]);
  assert.deepEqual(page.video, { status: 'pending', src: null, chapters: [] });
  assert.deepEqual((await expert('GET', `/api/office-hours/${ohId}/video`)).video, { status: 'pending', src: null, chapters: [] });
  release();
  await app.idle();

  page = await reader('GET', `/api/office-hours/${ohId}`);
  assert.deepEqual([page.officeHour.status, page.officeHour.processing, page.answers.length], ['published', false, 2]);
  assert.ok((await asker('GET', '/api/feed')).items.some((i) => i.type === 'published' && i.officeHour.id === ohId));
  assert.ok((await reader('GET', '/api/explore')).published.some((oh) => oh.id === ohId));

  assert.deepEqual(joins.at(-1), ['take: Third question here? 4s', 'take: First question here? 7.5s']);
  const { video } = await reader('GET', `/api/office-hours/${ohId}`);
  assert.equal(video.status, 'ready');
  assert.match(video.src, /^\/media\/[0-9a-f]{32}\.mp4$/);
  assert.deepEqual(video.chapters, [{ questionId: ids[2], start: 0, end: 4 }, { questionId: ids[0], start: 4, end: 11.5 }]);
  assert.deepEqual((await reader('GET', `/api/office-hours/${ohId}/video`)).video, video);
  // Anyone can watch it, like the published answers.
  const res = await reader.media(video.src);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'take: Third question here? 4s\ntake: First question here? 7.5s');
  assert.equal(res.headers.get('content-type'), 'video/mp4');
});

test("a join that fails is marked failed and leaves no file behind; the answers are shown one by one", async () => {
  const expert = await register('unlucky_host');
  const asker = await register('unlucky_asker');
  const { ohId } = await recorded(expert, asker, [['Will this one join?', 3]]);
  const before = new Set(readdirSync(mediaDir));
  failNext = true;
  await expert('POST', `/api/office-hours/${ohId}/publish`);
  await app.idle();
  const page = await client()('GET', `/api/office-hours/${ohId}`);
  assert.deepEqual(page.video, { status: 'failed', src: null, chapters: [] });
  assert.equal(page.answers.length, 1); // still there, one by one
  assert.deepEqual(readdirSync(mediaDir).filter((f) => !before.has(f)), []);
});

test('on startup, office hours published before joining existed, or mid-join, are joined', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forum_video_resume_'));
  try {
    const oldDb = openDb(':memory:');
    oldDb.exec(`
      INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (1, 'old', 'Old', 'x', '2026-01-01');
      INSERT INTO office_hours (id, expert_id, title, questions_deadline, answers_expected_at, created_at, published_at) VALUES
        (1, 1, 'Old', '2026-01-02', '2026-01-03', '2026-01-01', '2026-01-04'),
        (2, 1, 'Unpublished', '2026-01-02', '2026-01-03', '2026-01-01', NULL);
      INSERT INTO questions (id, office_hour_id, author_id, body, created_at, published_position, published_answer_video) VALUES
        (1, 1, 1, 'Old question?', '2026-01-01', 1, '${'a'.repeat(32)}.webm');
    `);
    writeFileSync(join(dir, `${'a'.repeat(32)}.webm`), take('old', 9));
    const resumed = createApp({ db: oldDb, moderator: await createModerator({ mode: 'heuristic' }), mediaDir: dir, joiner: fakeJoiner });
    await resumed.idle();
    const rows = oldDb.prepare('SELECT id, video, video_status, video_chapters FROM office_hours ORDER BY id').all();
    assert.equal(rows[0].video_status, 'ready');
    assert.deepEqual(JSON.parse(rows[0].video_chapters), [[1, 0, 9]]);
    assert.ok(existsSync(join(dir, rows[0].video)));
    assert.equal(rows[1].video_status, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without ffmpeg, published answers have no joined video', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forum_video_off_'));
  const offServer = createServer(createApp({ db: openDb(':memory:'), moderator: await createModerator({ mode: 'heuristic' }), mediaDir: dir }));
  await new Promise((resolve) => offServer.listen(0, resolve));
  const offBase = () => `http://localhost:${offServer.address().port}`;
  try {
    const expert = await register('plain_host', offBase);
    const asker = await register('plain_asker', offBase);
    const { ohId } = await recorded(expert, asker, [['Any joined video?', 3]]);
    await expert('POST', `/api/office-hours/${ohId}/publish`);
    const page = await asker('GET', `/api/office-hours/${ohId}`);
    assert.equal(page.video, null);
    assert.equal(page.answers.length, 1);
  } finally {
    offServer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const hasFfmpeg = !spawnSync('ffmpeg', ['-version']).error && !spawnSync('ffprobe', ['-version']).error;

test('ffmpeg joins takes of different formats, sizes and frame rates', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forum_video_ffmpeg_'));
  const ffmpeg = (...args) => execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args]);
  const probe = (file, entries) => execFileSync('ffprobe', ['-v', 'error', '-show_entries', entries, '-of', 'csv=p=0', file]).toString().trim();
  try {
    // What different browsers record: WebM from Firefox, MP4 from Chrome and Safari, and a
    // portrait phone camera. One has no sound at all.
    ffmpeg('-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=24:duration=2', '-f', 'lavfi', '-i', 'sine=f=440:duration=2', '-c:v', 'libvpx', '-c:a', 'libopus', '-shortest', join(dir, 'a.webm'));
    ffmpeg('-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=1.5', '-f', 'lavfi', '-i', 'sine=f=660:duration=1.5', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', join(dir, 'b.mp4'));
    ffmpeg('-f', 'lavfi', '-i', 'testsrc=size=360x640:rate=25:duration=1', '-c:v', 'libx264', join(dir, 'c.mp4'));
    const joiner = createVideoJoiner();
    const out = join(dir, 'joined.mp4');
    const durations = await joiner.join(['a.webm', 'b.mp4', 'c.mp4'].map((f) => join(dir, f)), out);
    assert.equal(durations.length, 3);
    [2, 1.5, 1].forEach((secs, i) => assert.ok(Math.abs(durations[i] - secs) < 0.1, `part ${i}: ${durations[i]}s`));
    const total = Number(probe(out, 'format=duration'));
    assert.ok(Math.abs(total - durations.reduce((a, b) => a + b)) < 0.1, `joined: ${total}s`);
    assert.deepEqual(probe(out, 'stream=codec_name,width,height').split('\n').sort(), ['aac', 'h264,1280,720']);
    assert.deepEqual(readdirSync(dir).sort(), ['a.webm', 'b.mp4', 'c.mp4', 'joined.mp4']); // nothing left over
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
