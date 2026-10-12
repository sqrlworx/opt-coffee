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
// writes them one after another. A question with audio is found 0.06 seconds into its part, and
// `located` records what was looked for. `hold(t)` makes joining wait until released, `failNext`
// fails it. Takes come as {file, answerStart, cues, words}.
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
const located = [];
const fakeJoiner = {
  async join(takes, out) {
    await gate;
    if (failNext) {
      failNext = false;
      writeFileSync(out, 'half a video'); // a failed join mustn't leave this behind
      throw new Error('ffmpeg exited with code 1');
    }
    const videos = takes.map((t) => readFileSync(t.file, 'utf8'));
    joins.push(videos);
    writeFileSync(out, videos.join('\n'));
    return { durations: videos.map((v) => Number(/ ([\d.]+)s$/.exec(v)[1])), captioned: videos.map(() => false) };
  },
  async locate(video, questions) {
    located.push(questions);
    return questions.map((q) => (q.audio ? 0.06 : 0));
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
  assert.deepEqual(video.chapters, [{ questionId: ids[2], start: 0, end: 4, captions: false, questionStart: 0 }, { questionId: ids[0], start: 4, end: 11.5, captions: false, questionStart: 0 }]);
  assert.deepEqual((await reader('GET', `/api/office-hours/${ohId}/video`)).video, video);
  // Anyone can watch it, like the published answers.
  const res = await reader.media(video.src);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'take: Third question here? 4s\ntake: First question here? 7.5s');
  assert.equal(res.headers.get('content-type'), 'video/mp4');
});

test("the joined video says how far into each answer its question's sound starts", async () => {
  const expert = await register('locate_host');
  const asker = await register('locate_asker');
  const { ohId, ids } = await recorded(expert, asker, [['A question read aloud?', 6], ['One without sound?', 3]]);
  // The first was read aloud and played at the start of its take; the second has no audio.
  const audio = `${'c'.repeat(32)}.m4a`;
  db.prepare('UPDATE questions SET audio = ? WHERE id = ?').run(audio, ids[0]);
  await expert('PUT', `/api/questions/${ids[0]}/video?answerStart=2.5`, take('A question read aloud?', 6));
  await expert('POST', `/api/office-hours/${ohId}/publish`);
  await app.idle();
  assert.deepEqual(located.at(-1), [{ audio: join(mediaDir, audio), start: 0, length: 2.5 }, { audio: null, start: 6, length: null }]);
  const { video } = await client()('GET', `/api/office-hours/${ohId}`);
  assert.deepEqual(video.chapters.map((c) => [c.start, c.questionStart]), [[0, 0.06], [6, 0]]);
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
    // The third was joined before the questions were found in joined videos.
    oldDb.exec(`
      INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (1, 'old', 'Old', 'x', '2026-01-01');
      INSERT INTO office_hours (id, expert_id, title, questions_deadline, answers_expected_at, created_at, published_at, video, video_status, video_chapters) VALUES
        (1, 1, 'Old', '2026-01-02', '2026-01-03', '2026-01-01', '2026-01-04', NULL, NULL, NULL),
        (2, 1, 'Unpublished', '2026-01-02', '2026-01-03', '2026-01-01', NULL, NULL, NULL, NULL),
        (3, 1, 'Joined', '2026-01-02', '2026-01-03', '2026-01-01', '2026-01-04', '${'d'.repeat(32)}.mp4', 'ready', '[[2, 0, 5, 0]]');
      INSERT INTO questions (id, office_hour_id, author_id, body, created_at, published_position, published_answer_video, audio, published_answer_start) VALUES
        (1, 1, 1, 'Old question?', '2026-01-01', 1, '${'a'.repeat(32)}.webm', NULL, NULL),
        (2, 3, 1, 'Joined question?', '2026-01-01', 1, '${'e'.repeat(32)}.webm', '${'f'.repeat(32)}.m4a', 1.5);
    `);
    writeFileSync(join(dir, `${'a'.repeat(32)}.webm`), take('old', 9));
    const resumed = createApp({ db: oldDb, moderator: await createModerator({ mode: 'heuristic' }), mediaDir: dir, joiner: fakeJoiner });
    await resumed.idle();
    const rows = oldDb.prepare('SELECT id, video, video_status, video_chapters FROM office_hours ORDER BY id').all();
    assert.equal(rows[0].video_status, 'ready');
    assert.deepEqual(JSON.parse(rows[0].video_chapters), [[1, 0, 9, 0, 0]]);
    assert.ok(existsSync(join(dir, rows[0].video)));
    assert.equal(rows[1].video_status, null);
    // Not joined again: its question is found in the video it has.
    assert.deepEqual([rows[2].video, JSON.parse(rows[2].video_chapters)], [`${'d'.repeat(32)}.mp4`, [[2, 0, 5, 0, 0.06]]]);
    assert.deepEqual(located.at(-1), [{ audio: join(dir, `${'f'.repeat(32)}.m4a`), start: 0, length: 1.5 }]);
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
    const { durations, captioned } = await joiner.join(['a.webm', 'b.mp4', 'c.mp4'].map((f) => join(dir, f)), out);
    assert.deepEqual(captioned, [false, false, false]);
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

test("ffmpeg finds where a question's sound starts in a joined video", { skip: !hasFfmpeg && 'ffmpeg is not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forum_video_locate_'));
  const ffmpeg = (...args) => execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args]);
  try {
    // A question with an uneven rhythm, and a video whose second part, from 2 seconds in, plays it
    // 80 ms late, over some noise.
    const question = "aevalsrc='0.4*sin(2*PI*300*t)*gt(sin(2*PI*2.3*t)+sin(2*PI*3.7*t+1),0.4)':s=16000:d=2.5";
    ffmpeg('-f', 'lavfi', '-i', question, join(dir, 'q.m4a'));
    ffmpeg(
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=5', '-f', 'lavfi', '-i', 'anoisesrc=a=0.01:d=5', '-f', 'lavfi', '-i', question,
      '-filter_complex', '[2]adelay=2080:all=1[q];[1][q]amix=inputs=2:duration=first:normalize=0[a]', '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-c:a', 'aac', join(dir, 'joined.mp4'),
    );
    const logs = [];
    const found = await createVideoJoiner({ log: (msg) => logs.push(msg) }).locate(join(dir, 'joined.mp4'), [
      { audio: null, start: 0, length: 2 },
      { audio: join(dir, 'q.m4a'), start: 2, length: 2.5 },
      { audio: join(dir, 'missing.m4a'), start: 2, length: 2.5 },
    ]);
    assert.equal(found[0], 0);
    assert.ok(Math.abs(found[1] - 0.08) < 0.011, `found at ${found[1]}s`);
    assert.equal(found[2], 0); // it can't be found
    assert.match(logs.join('\n'), /finding a question in .*joined\.mp4 failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A joiner that finishes takes, as with src/finish: it records what it's given, and its captions
// are burned in for every take with a transcript. `gate` holds it until released.
function finishingJoiner() {
  const joiner = {
    calls: [],
    gate: null,
    finishing: true,
    async join(takes, out) {
      await joiner.gate;
      joiner.calls.push(takes.map(({ file, ...rest }) => ({ video: readFileSync(file, 'utf8'), ...rest })));
      writeFileSync(out, `finished, version ${joiner.calls.length}`);
      return { durations: takes.map(() => 5), captioned: takes.map((t) => Boolean(t.cues?.length)) };
    },
    locate: async (video, questions) => questions.map(() => 0),
  };
  return joiner;
}

async function finishingApp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'forum_video_finish_'));
  const fdb = openDb(':memory:');
  const joiner = finishingJoiner();
  const fapp = createApp({ db: fdb, moderator: await createModerator({ mode: 'heuristic' }), mediaDir: dir, joiner });
  const srv = createServer(fapp);
  await new Promise((resolve) => srv.listen(0, resolve));
  t.after(() => {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { db: fdb, app: fapp, joiner, dir, base: () => `http://localhost:${srv.address().port}` };
}

const answerVideo = (fdb, id) => fdb.prepare('SELECT answer_video FROM questions WHERE id = ?').get(id).answer_video;
const setTranscript = (fdb, media, status, cues = null, words = null) =>
  fdb
    .prepare(
      `INSERT INTO transcripts (media, status, text, cues, words, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (media) DO UPDATE SET status = excluded.status, text = excluded.text, cues = excluded.cues, words = excluded.words`,
    )
    .run(media, status, cues ? cues.map((c) => c[2]).join(' ') : null, cues && JSON.stringify(cues), words && JSON.stringify(words), new Date().toISOString());

test('finished joins wait for transcripts being made, and their chapters say which captions are burned in', async (t) => {
  const f = await finishingApp(t);
  const expert = await register('finish_host', f.base);
  const asker = await register('finish_asker', f.base);
  const { officeHour } = await expert('POST', '/api/office-hours', { title: 'Finishing', questionsDeadline: inDays(1), answersExpectedAt: inDays(2) });
  const ids = [];
  for (const body of ['Will this be captioned?', 'And this one?']) {
    const { question } = await asker('POST', `/api/office-hours/${officeHour.id}/questions`, { body });
    assert.equal((await expert('PUT', `/api/questions/${question.id}/video?answerStart=1.5`, take(body, 5))).status, 200);
    ids.push(question.id);
  }
  await expert('PUT', `/api/office-hours/${officeHour.id}/plan`, { items: ids.map((questionId) => ({ questionId })) });
  // The first answer's transcript is still being made; the second never got one. The question at
  // the start of the take was misheard.
  const cues = [[0, 1.4, 'Will this be caption?'], [1.6, 4, 'Yes, it will.']];
  const words = [[0, 0.3, ' Will'], [0.3, 0.5, ' this'], [0.5, 0.7, ' be'], [0.7, 1.4, ' caption?'], [1.6, 2, ' Yes,'], [2, 2.4, ' it'], [2.4, 4, ' will.']];
  setTranscript(f.db, answerVideo(f.db, ids[0]), 'pending');
  await expert('POST', `/api/office-hours/${officeHour.id}/publish`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(f.joiner.calls.length, 0); // waiting for it
  setTranscript(f.db, answerVideo(f.db, ids[0]), 'ready', cues, words);
  await f.app.idle();

  assert.equal(f.joiner.calls.length, 1);
  const [first, second] = f.joiner.calls[0];
  assert.deepEqual([first.video, first.answerStart], ['take: Will this be captioned? 5s', 1.5]);
  // The question is captioned as it was typed, spread over the time it's read aloud; then the answer.
  assert.deepEqual(first.cues, [[0, 1.5, 'Will this be captioned?'], [1.6, 4, 'Yes, it will.']]);
  assert.deepEqual(first.words, [[0, 0.313, ' Will'], [0.313, 0.625, ' this'], [0.625, 0.813, ' be'], [0.813, 1.5, ' captioned?'], ...words.slice(4)]);
  assert.deepEqual([second.video, second.cues], ['take: And this one? 5s', undefined]);
  const { video } = await asker('GET', `/api/office-hours/${officeHour.id}`);
  assert.equal(video.status, 'ready');
  assert.deepEqual(video.chapters, [{ questionId: ids[0], start: 0, end: 5, captions: true, questionStart: 0 }, { questionId: ids[1], start: 5, end: 10, captions: false, questionStart: 0 }]);
});

test('correcting a published transcript remakes a finished video, and readers keep the old one until then', async (t) => {
  const f = await finishingApp(t);
  const expert = await register('remake_host', f.base);
  const asker = await register('remake_asker', f.base);
  const reader = client(f.base);
  const { ohId, ids } = await recorded(expert, asker, [['Does a fix reach the captions?', 5]]);
  setTranscript(f.db, answerVideo(f.db, ids[0]), 'ready', [[0, 2, 'Does a fix reach the captions?'], [2, 4, 'It does, eventualy.']]);
  await expert('POST', `/api/office-hours/${ohId}/publish`);
  await f.app.idle();
  const before = (await reader('GET', `/api/office-hours/${ohId}`)).video.src;
  const oldFile = join(f.dir, before.split('/').pop());
  assert.ok(existsSync(oldFile));

  let release;
  f.joiner.gate = new Promise((resolve) => (release = resolve));
  t.after(() => release());
  const lines = ['Does a fix reach the captions?', 'It does, eventually.'];
  assert.equal((await expert('PUT', `/api/questions/${ids[0]}/answer-transcript`, { cues: lines })).status, 200);
  await expert('PUT', `/api/questions/${ids[0]}/answer-transcript`, { cues: lines }); // nothing changed: no second remake
  await new Promise((resolve) => setTimeout(resolve, 50));
  let page = await reader('GET', `/api/office-hours/${ohId}`);
  assert.deepEqual([page.video.status, page.video.src], ['ready', before]); // the remake is under way
  release();
  await f.app.idle();

  assert.equal(f.joiner.calls.length, 2);
  assert.deepEqual(f.joiner.calls[1][0].cues, [[0, 2, 'Does a fix reach the captions?'], [2, 4, 'It does, eventually.']]);
  page = await reader('GET', `/api/office-hours/${ohId}`);
  assert.notEqual(page.video.src, before);
  assert.equal(await (await reader.media(page.video.src)).text(), 'finished, version 2');
  assert.ok(!existsSync(oldFile)); // replaced
});

test('a joiner with a finisher joins the finished parts, or the takes as recorded if finishing fails', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forum_video_finisher_'));
  const ffmpeg = (...args) => execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args]);
  const probe = (file, entries) => execFileSync('ffprobe', ['-v', 'error', '-show_entries', entries, '-of', 'csv=p=0', file]).toString().trim();
  try {
    ffmpeg('-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=2', '-f', 'lavfi', '-i', 'sine=f=440:duration=2', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', join(dir, 'a.mp4'));
    ffmpeg('-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=1', '-f', 'lavfi', '-i', 'sine=f=660:duration=1', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', join(dir, 'b.mp4'));
    const takes = [{ file: join(dir, 'a.mp4'), answerStart: 0.5, cues: [[0, 1, 'Hello there.']], words: null }, { file: join(dir, 'b.mp4') }];
    // Stands in for src/finish: renders each take at 1080p, as the real one does.
    let given = null;
    const finisher = {
      async finish(jobs) {
        given = jobs;
        for (const job of jobs) ffmpeg('-i', job.input, '-vf', 'scale=1920:1080', '-c:v', 'libx264', '-c:a', 'aac', '-ar', '48000', '-ac', '2', job.output);
        return {};
      },
    };
    const finished = await createVideoJoiner({ finisher }).join(takes, join(dir, 'finished.mp4'));
    assert.deepEqual(given.map((j) => [j.answer_start, j.cues]), [[0.5, [[0, 1, 'Hello there.']]], [null, null]]);
    assert.deepEqual(finished.captioned, [true, false]);
    assert.deepEqual(probe(join(dir, 'finished.mp4'), 'stream=codec_name,width,height').split('\n').sort(), ['aac', 'h264,1920,1080']);
    assert.ok(Math.abs(Number(probe(join(dir, 'finished.mp4'), 'format=duration')) - 3) < 0.1);

    const logs = [];
    const failing = { finish: async () => Promise.reject(new Error('the models could not be downloaded')) };
    const plain = await createVideoJoiner({ finisher: failing, log: (msg) => logs.push(msg) }).join(takes, join(dir, 'plain.mp4'));
    assert.deepEqual(plain.captioned, [false, false]); // the player draws them instead
    assert.deepEqual(probe(join(dir, 'plain.mp4'), 'stream=codec_name,width,height').split('\n').sort(), ['aac', 'h264,1280,720']);
    assert.match(logs.join('\n'), /finishing failed, so the takes are joined as recorded: the models could not be downloaded/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
