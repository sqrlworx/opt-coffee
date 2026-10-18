import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createModerator } from '../src/moderator/index.js';

let server;
let base;
let db;
let mediaDir;

before(async () => {
  db = openDb(':memory:');
  mediaDir = mkdtempSync(join(tmpdir(), 'forum_media_'));
  const moderator = await createModerator({ mode: 'heuristic' });
  server = createServer(createApp({ db, moderator, mediaDir }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});

after(() => {
  server.close();
  rmSync(mediaDir, { recursive: true, force: true });
});

// A tiny cookie-jar client per user. A Buffer body is sent raw as a recorded video.
function client() {
  let cookie = '';
  const call = async function call(method, path, body, { type = 'video/webm' } = {}) {
    const raw = Buffer.isBuffer(body);
    const res = await fetch(base + path, {
      method,
      headers: { ...(raw ? { 'Content-Type': type } : body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: raw ? body : body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const data = await res.json();
    return { status: res.status, ...data };
  };
  // Fetches a media URL as this user; returns the raw response.
  call.media = (url, headers = {}) => fetch(base + url, { headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) } });
  return call;
}

const fakeVideo = (label) => Buffer.from(`fake video bytes: ${label}`);

async function register(username) {
  const call = client();
  const res = await call('POST', '/api/auth/register', { username, displayName: username.toUpperCase(), password: 'password123' });
  assert.equal(res.status, 200, res.error);
  return { call, media: call.media, user: res.user };
}

const inDays = (d) => new Date(Date.now() + d * 86400_000).toISOString();

test('full office-hours lifecycle', async () => {
  const expert = await register('expert');
  const asker = await register('asker');
  const fan = await register('fan');
  const lurker = await register('lurker');

  // Profile drives moderator suggestions.
  let res = await expert.call('PATCH', '/api/me', { displayName: 'Ex Pert', bio: 'Built databases for 10 years.', expertise: 'databases, career growth' });
  assert.deepEqual(res.user.expertise, ['databases', 'career growth']);

  // Fan subscribes to the expert before the announcement.
  res = await fan.call('POST', '/api/subscriptions', { type: 'expert', id: expert.user.id });
  assert.equal(res.subscribed, true);
  assert.equal((await expert.call('POST', '/api/subscriptions', { type: 'expert', id: expert.user.id })).status, 400);

  // Announce.
  res = await expert.call('POST', '/api/office-hours', {
    title: 'Ask me about databases',
    topic: 'Databases',
    questionsDeadline: inDays(2),
    answersExpectedAt: inDays(4),
    allowAnonymous: true,
  });
  assert.equal(res.status, 200, res.error);
  const ohId = res.officeHour.id;
  assert.equal(res.officeHour.status, 'open');

  // Fan's feed shows the announcement; lurker's doesn't.
  res = await fan.call('GET', '/api/feed');
  assert.deepEqual(res.items.map((i) => i.type), ['announced']);
  assert.equal((await lurker.call('GET', '/api/feed')).items.length, 0);

  // Moderator suggests seeds; only the expert can ask for them.
  assert.equal((await asker.call('POST', `/api/office-hours/${ohId}/suggestions`, {})).status, 403);
  res = await expert.call('POST', `/api/office-hours/${ohId}/suggestions`, {});
  assert.ok(res.questions.length > 0);
  assert.ok(res.questions.some((q) => q.includes('Databases') || q.includes('databases')));
  res = await expert.call('POST', `/api/office-hours/${ohId}/seed`, { questions: res.questions.slice(0, 2) });
  assert.equal(res.added, 2);

  // Questions: named and anonymous.
  res = await asker.call('POST', `/api/office-hours/${ohId}/questions`, { body: 'How do you choose between Postgres and MySQL for a new database?' });
  assert.equal(res.status, 200, res.error);
  const q1 = res.question.id;
  res = await lurker.call('POST', `/api/office-hours/${ohId}/questions`, { body: 'How did you grow your career from junior to staff?', anonymous: true });
  const q2 = res.question.id;
  res = await fan.call('POST', `/api/office-hours/${ohId}/questions`, { body: 'Which database would you pick for a new startup, Postgres or MySQL?' });
  const q3 = res.question.id;

  // Votes are idempotent per user.
  await fan.call('POST', `/api/questions/${q1}/vote`);
  await fan.call('POST', `/api/questions/${q1}/vote`);
  res = await lurker.call('POST', `/api/questions/${q1}/vote`);
  assert.equal(res.votes, 2);
  res = await lurker.call('DELETE', `/api/questions/${q1}/vote`);
  assert.equal(res.votes, 1);

  // Public view: anonymous author hidden (even to the expert), answers/plan hidden.
  res = await asker.call('GET', `/api/office-hours/${ohId}`);
  const all = res.groups.flatMap((g) => g.questions);
  assert.equal(all.length, 5);
  const anon = all.find((q) => q.id === q2);
  assert.equal(anon.author, null);
  assert.equal(anon.anonymous, true);
  assert.equal(res.plan, undefined);
  assert.ok(all.every((q) => !('answer' in q)));
  // Similar database questions are grouped together.
  const groupOfQ = (id) => res.groups.findIndex((g) => g.questions.some((q) => q.id === id));
  assert.equal(groupOfQ(q1), groupOfQ(q3));

  res = await expert.call('GET', `/api/office-hours/${ohId}`);
  assert.equal(res.groups.flatMap((g) => g.questions).find((q) => q.id === q2).author, null);
  assert.equal(res.plan.suggestedOrder.length, 5);
  assert.equal(res.plan.suggestedOrder[0], q1); // most-voted, in the most popular group

  // Askers are auto-subscribed to the office hour.
  assert.equal((await asker.call('GET', `/api/office-hours/${ohId}`)).officeHour.subscribed, true);

  // Plan and video answers: only the expert; can't publish without a recorded answer.
  assert.equal((await asker.call('PUT', `/api/office-hours/${ohId}/plan`, { items: [] })).status, 403);
  assert.equal((await asker.call('PUT', `/api/questions/${q1}/video`, fakeVideo('impostor'))).status, 403);
  assert.equal((await expert.call('POST', `/api/office-hours/${ohId}/publish`)).status, 400);
  res = await expert.call('PUT', `/api/office-hours/${ohId}/plan`, { items: [{ questionId: q2 }, { questionId: q1 }, { questionId: q3 }] });
  assert.equal(res.ok, true);
  assert.equal((await expert.call('POST', `/api/office-hours/${ohId}/publish`)).status, 400);
  const v2 = (await expert.call('PUT', `/api/questions/${q2}/video`, fakeVideo('career'))).video;
  const v1 = (await expert.call('PUT', `/api/questions/${q1}/video`, fakeVideo('postgres'), { type: 'video/mp4;codecs=avc1' })).video;
  assert.match(v1, /^\/media\/[0-9a-f]{32}\.mp4$/);
  assert.equal((await expert.call('PUT', `/api/office-hours/${ohId}/plan`, { items: [{ questionId: 99999 }] })).status, 400);

  // Close early: no more questions or votes.
  res = await expert.call('POST', `/api/office-hours/${ohId}/close`);
  assert.equal(res.officeHour.status, 'closed');
  assert.equal((await asker.call('POST', `/api/office-hours/${ohId}/questions`, { body: 'Too late for this one?' })).status, 409);
  assert.equal((await asker.call('POST', `/api/questions/${q1}/vote`)).status, 409);

  // Publish: answered queue items in the expert's order; unanswered ones excluded.
  res = await expert.call('POST', `/api/office-hours/${ohId}/publish`);
  assert.equal(res.officeHour.status, 'published');
  res = await lurker.call('GET', `/api/office-hours/${ohId}`);
  assert.deepEqual(res.answers.map((a) => [a.id, a.video]), [[q2, v2], [q1, v1]]);
  const video = await lurker.media(v1);
  assert.equal(video.headers.get('content-type'), 'video/mp4');
  assert.equal(await video.text(), 'fake video bytes: postgres');

  // Feeds: fan (expert subscriber) sees both events, published first; asker (OH subscriber) sees published only.
  res = await fan.call('GET', '/api/feed');
  assert.deepEqual(res.items.map((i) => i.type), ['published', 'announced']);
  // Feed items are teasers: counts and question titles, never the answers themselves.
  assert.equal(res.items[0].answerCount, 2);
  assert.deepEqual(res.items[0].preview.map((q) => q.id), [q2, q1]);
  assert.ok(!('answers' in res.items[0]));
  assert.ok(res.items[0].preview.every((q) => Object.keys(q).sort().join() === 'body,id'));
  res = await asker.call('GET', '/api/feed');
  assert.deepEqual(res.items.map((i) => i.type), ['published']);
  // Lurker asked anonymously, so they follow the office hour too.
  assert.deepEqual((await lurker.call('GET', '/api/feed')).items.map((i) => i.type), ['published']);
});

test('validation and access control', async () => {
  const a = await register('alice_v');
  const anonCall = client();

  assert.equal((await anonCall('GET', '/api/feed')).status, 401);
  assert.equal((await anonCall('POST', '/api/auth/register', { username: 'alice_v', password: 'password123' })).status, 409);
  assert.equal((await anonCall('POST', '/api/auth/login', { username: 'alice_v', password: 'wrong' })).status, 401);
  assert.equal((await anonCall('POST', '/api/auth/login', { username: 'alice_v', password: 'password123' })).status, 200);

  // Deadline must be in the future; answers on/after deadline.
  let res = await a.call('POST', '/api/office-hours', { title: 'Past', questionsDeadline: inDays(-1), answersExpectedAt: inDays(1) });
  assert.equal(res.status, 400);
  res = await a.call('POST', '/api/office-hours', { title: 'Backwards', questionsDeadline: inDays(2), answersExpectedAt: inDays(1) });
  assert.equal(res.status, 400);

  // Anonymous only when enabled; topic optional.
  res = await a.call('POST', '/api/office-hours', { title: 'No topic here', questionsDeadline: inDays(1), answersExpectedAt: inDays(1) });
  assert.equal(res.officeHour.topic, null);
  const ohId = res.officeHour.id;
  const b = await register('bob_v');
  res = await b.call('POST', `/api/office-hours/${ohId}/questions`, { body: 'Can I be anonymous?', anonymous: true });
  assert.equal(res.status, 400);

  // Deadline passing closes the office hour without any action.
  db.prepare('UPDATE office_hours SET questions_deadline = ? WHERE id = ?').run(inDays(-0.01), ohId);
  res = await b.call('GET', `/api/office-hours/${ohId}`);
  assert.equal(res.officeHour.status, 'closed');
  assert.equal((await b.call('POST', `/api/office-hours/${ohId}/questions`, { body: 'After the deadline?' })).status, 409);

  // JSON content type required for bodies.
  const raw = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(raw.status, 415);
});

test('explore lists open office hours and people; static shell is served', async () => {
  const res = await client()('GET', '/api/explore');
  assert.ok(Array.isArray(res.open));
  assert.ok(res.people.some((p) => p.username === 'expert'));

  const html = await fetch(`${base}/`);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /<main id="app"/);
  const traversal = await fetch(`${base}/..%2fpackage.json`);
  assert.doesNotMatch(await traversal.text(), /"name": "forum"/);
});

test('the mobile app is served at /m/ once it is built', async () => {
  const mobileDir = mkdtempSync(join(tmpdir(), 'forum_mobile_'));
  const mobileServer = createServer(createApp({ db, moderator: await createModerator({ mode: 'heuristic' }), mobileDir }));
  await new Promise((resolve) => mobileServer.listen(0, resolve));
  const mobileBase = `http://localhost:${mobileServer.address().port}`;
  try {
    // Not built yet: it says how to build it.
    let res = await fetch(`${mobileBase}/m/`);
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /npm run build/);

    mkdirSync(join(mobileDir, 'assets'));
    writeFileSync(join(mobileDir, 'index.html'), '<div id="root"></div>');
    writeFileSync(join(mobileDir, 'assets', 'app.js'), 'console.log(1)');
    res = await fetch(`${mobileBase}/m`, { redirect: 'manual' });
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('location'), '/m/');
    res = await fetch(`${mobileBase}/m/`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '<div id="root"></div>');
    res = await fetch(`${mobileBase}/m/assets/app.js`);
    assert.equal(res.headers.get('content-type'), 'text/javascript');
    assert.equal(await res.text(), 'console.log(1)');
    // Unknown paths get its shell; nothing outside it is served.
    assert.equal(await (await fetch(`${mobileBase}/m/explore`)).text(), '<div id="root"></div>');
    assert.doesNotMatch(await (await fetch(`${mobileBase}/m/..%2f..%2fpackage.json`)).text(), /"name"/);
    // The page and the API are where they were.
    assert.match(await (await fetch(`${mobileBase}/`)).text(), /<main id="app"/);
    assert.equal((await fetch(`${mobileBase}/api/explore`)).status, 200);
  } finally {
    mobileServer.close();
    rmSync(mobileDir, { recursive: true, force: true });
  }
});

test('dev user switcher is off by default', async () => {
  const call = client();
  assert.equal((await call('GET', '/api/me')).devLogin, false);
  assert.equal((await call('GET', '/api/dev/users')).status, 404);
  assert.equal((await call('POST', '/api/dev/login', { username: 'expert' })).status, 404);
});

test('dev user switcher lists users and logs in without a password when enabled', async () => {
  const devServer = createServer(createApp({ db, moderator: await createModerator({ mode: 'heuristic' }), devLogin: true }));
  await new Promise((resolve) => devServer.listen(0, resolve));
  const devBase = `http://localhost:${devServer.address().port}`;
  try {
    let cookie = '';
    const call = async (method, path, body) => {
      const res = await fetch(devBase + path, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      cookie = res.headers.get('set-cookie')?.split(';')[0] ?? cookie;
      return { status: res.status, ...(await res.json()) };
    };
    assert.equal((await call('GET', '/api/me')).devLogin, true);
    const { users } = await call('GET', '/api/dev/users');
    assert.ok(users.some((u) => u.username === 'expert'));
    assert.ok(users.every((u) => !('password_hash' in u) && !('passwordHash' in u)));

    assert.equal((await call('POST', '/api/dev/login', { username: 'expert' })).user.username, 'expert');
    assert.equal((await call('GET', '/api/me')).user.username, 'expert');
    assert.equal((await call('POST', '/api/dev/login', { username: 'asker' })).status, 200);
    assert.equal((await call('GET', '/api/me')).user.username, 'asker');
    assert.equal((await call('POST', '/api/dev/login', { username: 'nobody' })).status, 404);
  } finally {
    devServer.close();
  }
});

test('publishing is final: answers can no longer be edited', async () => {
  const expert = await register('finisher');
  const reader = await register('reader');
  let res = await expert.call('POST', '/api/office-hours', { title: 'Final answers test', questionsDeadline: inDays(1), answersExpectedAt: inDays(2) });
  const ohId = res.officeHour.id;
  const { question: q1 } = await reader.call('POST', `/api/office-hours/${ohId}/questions`, { body: 'First question here?' });
  const { question: q2 } = await reader.call('POST', `/api/office-hours/${ohId}/questions`, { body: 'Second question here?' });
  const { question: q3 } = await reader.call('POST', `/api/office-hours/${ohId}/questions`, { body: 'Third question here?' });

  // Before publishing, the expert's work is private.
  await expert.call('PUT', `/api/office-hours/${ohId}/plan`, { items: [{ questionId: q1.id }, { questionId: q2.id }] });
  const answer = await expert.call('PUT', `/api/questions/${q1.id}/video`, fakeVideo('answer'));
  // q3 gets a recording but isn't queued, so it won't be published.
  const unqueued = await expert.call('PUT', `/api/questions/${q3.id}/video`, fakeVideo('unqueued'));
  assert.deepEqual((await reader.call('GET', `/api/office-hours/${ohId}`)).answers, []);
  assert.equal((await reader.media(answer.video)).status, 404);

  res = await expert.call('POST', `/api/office-hours/${ohId}/publish`);
  assert.equal(res.officeHour.status, 'published');
  const readerView = await reader.call('GET', `/api/office-hours/${ohId}`);
  assert.deepEqual(readerView.answers.map((a) => [a.id, a.video]), [[q1.id, answer.video]]);
  assert.ok(readerView.answers.every((a) => !('answerVideo' in a) && !('publishedAnswerVideo' in a) && !('planPosition' in a)));
  assert.equal((await reader.media(answer.video)).status, 200);
  // The recording that missed the cut can never be published, so it's deleted.
  assert.ok(!existsSync(join(mediaDir, unqueued.video.split('/').pop())));
  assert.equal((await expert.call('GET', `/api/office-hours/${ohId}`)).groups.flatMap((g) => g.questions).find((q) => q.id === q3.id).answerVideo, null);

  // Every way of changing the answers is now refused, and nothing changes for readers.
  const locked = [
    await expert.call('PUT', `/api/office-hours/${ohId}/plan`, { items: [{ questionId: q2.id }, { questionId: q1.id }] }),
    await expert.call('PUT', `/api/questions/${q1.id}/video`, fakeVideo('retake')),
    await expert.call('PUT', `/api/questions/${q2.id}/video`, fakeVideo('late')),
    await expert.call('DELETE', `/api/questions/${q1.id}/video`),
    await expert.call('POST', `/api/office-hours/${ohId}/publish`),
  ];
  assert.deepEqual(locked.map((r) => r.status), [409, 409, 409, 409, 409]);
  assert.match(locked[0].error, /can no longer be edited/);
  assert.deepEqual((await reader.call('GET', `/api/office-hours/${ohId}`)).answers.map((a) => [a.id, a.video]), [[q1.id, answer.video]]);
  assert.equal(await (await reader.media(answer.video)).text(), 'fake video bytes: answer');
  // Refused uploads don't leave files behind.
  assert.deepEqual(readdirSync(mediaDir).filter((f) => f.endsWith('.part')), []);
  // Other people still get 403, not a hint that it's locked.
  assert.equal((await reader.call('PUT', `/api/office-hours/${ohId}/plan`, { items: [] })).status, 403);
});

test('a video still uploading when the expert publishes is rejected', async () => {
  const expert = await register('racer');
  const asker = await register('race_asker');
  let res = await expert.call('POST', '/api/office-hours', { title: 'Race test', questionsDeadline: inDays(1), answersExpectedAt: inDays(2) });
  const ohId = res.officeHour.id;
  const { question: q1 } = await asker.call('POST', `/api/office-hours/${ohId}/questions`, { body: 'Answered in time?' });
  const { question: q2 } = await asker.call('POST', `/api/office-hours/${ohId}/questions`, { body: 'Answered too late?' });
  await expert.call('PUT', `/api/office-hours/${ohId}/plan`, { items: [{ questionId: q1.id }, { questionId: q2.id }] });
  await expert.call('PUT', `/api/questions/${q1.id}/video`, fakeVideo('on time'));
  const filesBefore = readdirSync(mediaDir).length;

  // Start uploading q2's video, publish mid-upload, then finish the upload.
  let finish;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(fakeVideo('first half'));
      finish = () => {
        controller.enqueue(fakeVideo('second half'));
        controller.close();
      };
    },
  });
  const cookie = (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'racer', password: 'password123' }) }))
    .headers.get('set-cookie')
    .split(';')[0];
  const upload = fetch(`${base}/api/questions/${q2.id}/video`, { method: 'PUT', headers: { 'Content-Type': 'video/webm', Cookie: cookie }, body, duplex: 'half' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await expert.call('POST', `/api/office-hours/${ohId}/publish`)).status, 200);
  finish();
  const late = await upload;
  assert.equal(late.status, 409);
  assert.deepEqual((await asker.call('GET', `/api/office-hours/${ohId}`)).answers.map((a) => a.id), [q1.id]);
  assert.equal(readdirSync(mediaDir).length, filesBefore);
});

test('opening a database from before drafts existed backfills the published answers', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'forum_migrate_'));
  try {
    const path = join(dir, 'old.db');
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE office_hours (id INTEGER PRIMARY KEY, published_at TEXT);
      CREATE TABLE questions (id INTEGER PRIMARY KEY, office_hour_id INTEGER, plan_position INTEGER, answer TEXT);
      INSERT INTO office_hours VALUES (1, '2026-01-01T00:00:00Z'), (2, NULL);
      INSERT INTO questions VALUES (1, 1, 1, 'live'), (2, 1, 2, ''), (3, 1, NULL, 'unqueued'), (4, 2, 1, 'draft');
    `);
    old.close();
    const migrated = openDb(path);
    const rows = migrated.prepare('SELECT id, published_position, published_answer FROM questions ORDER BY id').all().map((r) => ({ ...r }));
    migrated.close();
    assert.deepEqual(rows, [
      { id: 1, published_position: 1, published_answer: 'live' },
      { id: 2, published_position: null, published_answer: null },
      { id: 3, published_position: null, published_answer: null },
      { id: 4, published_position: null, published_answer: null },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('video answers: validation, access control, range requests and cleanup', async () => {
  const expert = await register('videographer');
  const asker = await register('viewer');
  const stranger = client();
  let res = await expert.call('POST', '/api/office-hours', { title: 'Video test', questionsDeadline: inDays(1), answersExpectedAt: inDays(2) });
  const ohId = res.officeHour.id;
  const { question: q } = await asker.call('POST', `/api/office-hours/${ohId}/questions`, { body: 'Will you answer on camera?' });

  // Only real recordings: video content types, non-empty, logged in.
  assert.equal((await expert.call('PUT', `/api/questions/${q.id}/video`, fakeVideo('x'), { type: 'text/plain' })).status, 415);
  assert.equal((await expert.call('PUT', `/api/questions/${q.id}/video`, Buffer.alloc(0))).status, 400);
  assert.equal((await stranger('PUT', `/api/questions/${q.id}/video`, fakeVideo('x'))).status, 401);
  assert.equal((await expert.call('PUT', '/api/questions/99999/video', fakeVideo('x'))).status, 404);
  // Failed uploads leave no files behind.
  const filesBefore = readdirSync(mediaDir).length;

  const first = await expert.call('PUT', `/api/questions/${q.id}/video`, fakeVideo('0123456789'));
  assert.equal(first.status, 200, first.error);
  assert.equal(readdirSync(mediaDir).length, filesBefore + 1);
  assert.equal((await expert.call('GET', `/api/office-hours/${ohId}`)).groups[0].questions[0].answerVideo, first.video);

  // Drafts are private to the expert.
  assert.equal((await asker.media(first.video)).status, 404);
  assert.equal((await stranger.media(first.video)).status, 404);
  assert.equal((await stranger.media('/media/../forum.db')).status, 404);

  // Range requests, which browsers use to seek.
  let r = await expert.media(first.video, { Range: 'bytes=0-3' });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), `bytes 0-3/${fakeVideo('0123456789').length}`);
  assert.equal(await r.text(), 'fake');
  r = await expert.media(first.video, { Range: 'bytes=-4' });
  assert.equal(await r.text(), '6789');
  assert.equal((await expert.media(first.video, { Range: 'bytes=9999-' })).status, 416);
  assert.equal((await expert.media(first.video)).headers.get('accept-ranges'), 'bytes');

  // Re-recording replaces the draft file; removing deletes it.
  const second = await expert.call('PUT', `/api/questions/${q.id}/video`, fakeVideo('second'));
  assert.equal(readdirSync(mediaDir).length, filesBefore + 1);
  assert.equal((await expert.media(first.video)).status, 404);
  assert.equal((await asker.call('DELETE', `/api/questions/${q.id}/video`)).status, 403);
  res = await expert.call('DELETE', `/api/questions/${q.id}/video`);
  assert.equal(res.video, null);
  assert.equal(readdirSync(mediaDir).length, filesBefore);
  assert.equal((await expert.media(second.video)).status, 404);

  // Once published, the video is public.
  const live = await expert.call('PUT', `/api/questions/${q.id}/video`, fakeVideo('live'));
  await expert.call('PUT', `/api/office-hours/${ohId}/plan`, { items: [{ questionId: q.id }] });
  await expert.call('POST', `/api/office-hours/${ohId}/publish`);
  assert.equal(await (await stranger.media(live.video)).text(), 'fake video bytes: live');
});

test('answers recorded in a session say where the answer starts, after the question', async () => {
  const expert = await register('host_of_sessions');
  const asker = await register('session_asker');
  let res = await expert.call('POST', '/api/office-hours', { title: 'Session test', questionsDeadline: inDays(1), answersExpectedAt: inDays(2) });
  const ohId = res.officeHour.id;
  const { question: q1 } = await asker.call('POST', `/api/office-hours/${ohId}/questions`, { body: 'First session question?' });
  const { question: q2 } = await asker.call('POST', `/api/office-hours/${ohId}/questions`, { body: 'Second session question?' });
  const { question: q3 } = await asker.call('POST', `/api/office-hours/${ohId}/questions`, { body: 'Third session question?' });
  const video = (qid, label, query = '') => expert.call('PUT', `/api/questions/${qid}/video${query}`, fakeVideo(label));

  for (const bad of ['-1', 'abc', '601', 'Infinity']) {
    assert.equal((await video(q1.id, 'bad', `?answerStart=${bad}`)).status, 400, bad);
  }
  assert.equal((await video(q1.id, 'first', '?answerStart=4.25')).status, 200);
  await video(q2.id, 'second'); // recorded without a question in front of it
  await video(q3.id, 'third', '?answerStart=3');
  const draft = () => expert.call('GET', `/api/office-hours/${ohId}`).then((r) => new Map(r.groups.flatMap((g) => g.questions).map((q) => [q.id, q])));
  assert.equal((await draft()).get(q1.id).answerStart, 4.25);
  assert.equal((await draft()).get(q2.id).answerStart, null);
  // The draft is private, like the video.
  assert.ok((await asker.call('GET', `/api/office-hours/${ohId}`)).groups.flatMap((g) => g.questions).every((q) => !('answerStart' in q)));

  // Re-recording replaces it; removing clears it.
  await video(q1.id, 'retake', '?answerStart=5.5');
  assert.equal((await draft()).get(q1.id).answerStart, 5.5);
  await expert.call('DELETE', `/api/questions/${q3.id}/video`);
  assert.equal((await draft()).get(q3.id).answerStart, null);

  await expert.call('PUT', `/api/office-hours/${ohId}/plan`, { items: [{ questionId: q1.id }, { questionId: q2.id }] });
  await expert.call('POST', `/api/office-hours/${ohId}/publish`);
  const { answers } = await asker.call('GET', `/api/office-hours/${ohId}`);
  assert.deepEqual(answers.map((a) => [a.id, a.answerStart]), [[q1.id, 5.5], [q2.id, null]]);
  assert.equal((await asker.call('GET', `/api/questions/${q1.id}`)).question.answerStart, 5.5);
});

test('discussion: replies to published answers, expert responses one level down, and likes', async () => {
  const expert = await register('discusser');
  const asker = await register('disc_asker');
  const reader = await register('disc_reader');
  let res = await expert.call('POST', '/api/office-hours', { title: 'Discussion test', questionsDeadline: inDays(1), answersExpectedAt: inDays(2) });
  const ohId = res.officeHour.id;
  const { question: q } = await asker.call('POST', `/api/office-hours/${ohId}/questions`, { body: 'How do indexes work?' });
  const { question: unanswered } = await asker.call('POST', `/api/office-hours/${ohId}/questions`, { body: 'Nobody answers this one?' });
  await expert.call('PUT', `/api/office-hours/${ohId}/plan`, { items: [{ questionId: q.id }] });
  await expert.call('PUT', `/api/questions/${q.id}/video`, fakeVideo('indexes'));

  // Nothing to discuss until it's published.
  assert.equal((await reader.call('POST', `/api/questions/${q.id}/replies`, { body: 'Too early' })).status, 409);
  await expert.call('POST', `/api/office-hours/${ohId}/publish`);
  assert.equal((await reader.call('POST', `/api/questions/${unanswered.id}/replies`, { body: 'Not answered' })).status, 409);

  // Anyone logged in replies to the answer; text only, and not empty.
  assert.equal((await client()('POST', `/api/questions/${q.id}/replies`, { body: 'Anonymous' })).status, 401);
  assert.equal((await reader.call('POST', `/api/questions/${q.id}/replies`, { body: '   ' })).status, 400);
  const { reply: r1 } = await reader.call('POST', `/api/questions/${q.id}/replies`, { body: 'What about composite indexes?' });
  assert.deepEqual([r1.body, r1.byExpert, r1.mine, r1.likes, r1.author.username], ['What about composite indexes?', false, true, 0, 'disc_reader']);
  const { reply: r2 } = await asker.call('POST', `/api/questions/${q.id}/replies`, { body: 'Thanks, that helped.' });

  // Only the expert responds to a reply, and only to a reply to the answer.
  assert.equal((await asker.call('POST', `/api/questions/${q.id}/replies`, { body: 'Me too', parentId: r1.id })).status, 403);
  res = await expert.call('POST', `/api/questions/${q.id}/replies`, { body: 'Column order matters.', parentId: r1.id });
  assert.equal(res.status, 200, res.error);
  assert.equal(res.reply.byExpert, true);
  const response = res.reply;
  assert.equal((await expert.call('POST', `/api/questions/${q.id}/replies`, { body: 'Deeper', parentId: response.id })).status, 400);

  // Likes: once per person, not on your own.
  assert.deepEqual(await asker.call('POST', `/api/replies/${r1.id}/like`), { status: 200, likes: 1, liked: true });
  assert.deepEqual(await asker.call('POST', `/api/replies/${r1.id}/like`), { status: 200, likes: 1, liked: true });
  await reader.call('POST', `/api/replies/${response.id}/like`);
  assert.equal((await reader.call('POST', `/api/replies/${r1.id}/like`)).status, 400);
  assert.deepEqual(await asker.call('DELETE', `/api/replies/${r2.id}/like`), { status: 400, error: "You can't like your own reply" });

  const { answers } = await asker.call('GET', `/api/office-hours/${ohId}`);
  const thread = answers.find((a) => a.id === q.id).discussion;
  assert.deepEqual(thread.map((r) => [r.body, r.likes, r.liked, r.mine, r.responses.map((x) => [x.body, x.byExpert, x.likes])]), [
    ['What about composite indexes?', 1, true, false, [['Column order matters.', true, 1]]],
    ['Thanks, that helped.', 0, false, true, []],
  ]);
});

test('follow-up Q&A: prefilled from a published office hour, with questions from its discussion', async () => {
  const expert = await register('follower');
  const reader = await register('fu_reader');
  const fan = await register('fu_fan');
  let res = await expert.call('POST', '/api/office-hours', { title: 'Caching basics', topic: 'Caching', description: 'All about caches.', questionsDeadline: inDays(1), answersExpectedAt: inDays(2), allowAnonymous: true });
  const ohId = res.officeHour.id;
  const { question: q } = await reader.call('POST', `/api/office-hours/${ohId}/questions`, { body: 'When should I cache?' });

  // Only the expert, and only once it's published.
  assert.equal((await expert.call('GET', `/api/office-hours/${ohId}/follow-up`)).status, 409);
  await expert.call('PUT', `/api/office-hours/${ohId}/plan`, { items: [{ questionId: q.id }] });
  await expert.call('PUT', `/api/questions/${q.id}/video`, fakeVideo('caching'));
  await expert.call('POST', `/api/office-hours/${ohId}/publish`);
  assert.equal((await reader.call('GET', `/api/office-hours/${ohId}/follow-up`)).status, 403);

  const { reply: answered } = await reader.call('POST', `/api/questions/${q.id}/replies`, { body: 'Great answer. How do you invalidate a cache safely?' });
  await expert.call('POST', `/api/questions/${q.id}/replies`, { body: 'Version your keys.', parentId: answered.id });
  const { reply: liked } = await reader.call('POST', `/api/questions/${q.id}/replies`, { body: 'What about caching at the CDN edge?' });
  await fan.call('POST', `/api/replies/${liked.id}/like`);
  await fan.call('POST', `/api/questions/${q.id}/replies`, { body: 'No question here, just thanks.' });
  await expert.call('POST', `/api/questions/${q.id}/replies`, { body: 'Should I cover Redis next?' });

  res = await expert.call('GET', `/api/office-hours/${ohId}/follow-up`);
  assert.equal(res.status, 200, res.error);
  const draft = res.followUp;
  assert.deepEqual([draft.title, draft.topic, draft.allowAnonymous, draft.followUpOf], ['Follow-up: Caching basics', 'Caching', true, { id: ohId, title: 'Caching basics' }]);
  assert.match(draft.description, /^A follow-up to "Caching basics".*\n\nAll about caches\.$/s);
  // People's questions, the ones the expert didn't respond to first; not the expert's own.
  assert.deepEqual(draft.questions, ['What about caching at the CDN edge?', 'How do you invalidate a cache safely?']);

  // Following up someone else's office hour, or an unpublished one, is refused.
  const base = { title: 'Follow-up', questionsDeadline: inDays(1), answersExpectedAt: inDays(2) };
  assert.equal((await reader.call('POST', '/api/office-hours', { ...base, followUpOf: ohId })).status, 403);
  const { officeHour: draftOh } = await expert.call('POST', '/api/office-hours', base);
  assert.equal((await expert.call('POST', '/api/office-hours', { ...base, followUpOf: draftOh.id })).status, 409);
  assert.equal((await expert.call('POST', '/api/office-hours', { ...base, followUpOf: ohId, questions: ['hi'] })).status, 400);

  res = await expert.call('POST', '/api/office-hours', { ...base, title: draft.title, description: draft.description, followUpOf: ohId, questions: draft.questions.slice(0, 1) });
  assert.equal(res.status, 200, res.error);
  assert.deepEqual(res.officeHour.followUpOf, { id: ohId, title: 'Caching basics' });
  const followUpView = await reader.call('GET', `/api/office-hours/${res.officeHour.id}`);
  assert.deepEqual(followUpView.groups.flatMap((g) => g.questions).map((x) => [x.body, x.source]), [['What about caching at the CDN edge?', 'moderator']]);
  assert.deepEqual((await reader.call('GET', `/api/office-hours/${ohId}`)).followUps, [{ id: res.officeHour.id, title: 'Follow-up: Caching basics' }]);
});
