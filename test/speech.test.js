import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createModerator } from '../src/moderator/index.js';
import { cuesFromWords, toVtt } from '../src/speech/captions.js';
import { createSpeech } from '../src/speech/index.js';

// Stands in for Whisper and Kokoro: a "recording" holds the text that was said, and reading
// text aloud writes a file holding that text. A "video" holds what was said too, which taking its
// sound out copies, unless it's "[silent]". Records which lane each transcription used.
// `hold(t)` makes background work wait, like a slow engine, until the returned function is called
// (or test `t` ends, so a failing assertion can't leave the queue stuck).
const lanes = [];
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
const fakeSpeech = {
  name: 'fake',
  async transcribe(file, { interactive = false } = {}) {
    if (!interactive) await gate;
    const said = readFileSync(file, 'utf8').replace(/^said:/, '').trim();
    if (said.includes('[garbled]')) throw new Error("couldn't decode the recording");
    lanes.push({ said, interactive });
    return { text: said, words: said.split(' ').filter(Boolean).map((w, i) => [i * 0.5, i * 0.5 + 0.4, ` ${w}`]) };
  },
  async extractSound(file, out) {
    const video = readFileSync(file, 'utf8');
    if (video.includes('[silent]')) throw new Error('Stream map 0:a:0 matches no streams');
    writeFileSync(out, video);
  },
  async speak(text, out) {
    await gate;
    if (text.includes('[mute]')) throw new Error('the text produced no speech');
    writeFileSync(out, `spoken: ${text}`);
  },
};

let server;
let app;
let base;
let db;
let mediaDir;

before(async () => {
  db = openDb(':memory:');
  mediaDir = mkdtempSync(join(tmpdir(), 'forum_speech_media_'));
  app = createApp({ db, moderator: await createModerator({ mode: 'heuristic' }), mediaDir, speech: fakeSpeech });
  server = createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});

after(() => {
  server.close();
  rmSync(mediaDir, { recursive: true, force: true });
});

// A cookie-jar client per user. A Buffer body is sent raw as a recording.
function client(baseUrl = () => base) {
  let cookie = '';
  const call = async function call(method, path, body, { type = 'audio/webm' } = {}) {
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
  const res = await call('POST', '/api/auth/register', { username, password: 'password123' });
  assert.equal(res.status, 200, res.error);
  return call;
}

const said = (text) => Buffer.from(`said: ${text}`);
const inDays = (d) => new Date(Date.now() + d * 86400_000).toISOString();
const officeHour = async (expert, fields = {}) =>
  (await expert('POST', '/api/office-hours', { title: 'Speech test', questionsDeadline: inDays(1), answersExpectedAt: inDays(2), ...fields })).officeHour.id;

// Asking out loud: the recording is transcribed into a draft, then asked with the transcript
// lines as the asker checked them (unchanged unless `lines` is given).
async function askOutLoud(call, ohId, recording, { type, anonymous = false, lines } = {}) {
  const draft = await call('POST', `/api/office-hours/${ohId}/recordings`, recording, type ? { type } : {});
  assert.equal(draft.status, 200, draft.error);
  return call('POST', `/api/office-hours/${ohId}/questions`, { recording: draft.recording.id, cues: lines ?? draft.recording.cues.map((c) => c[2]), anonymous });
}

// ---------- captions ----------

test('captions: cues end at sentences, pauses and length limits', () => {
  const words = (text, start = 0, step = 0.3) => text.split(' ').map((w, i) => [start + i * step, start + i * step + 0.25, ` ${w}`]);
  // A sentence end closes the cue once it has some length; very short sentences run on.
  assert.deepEqual(
    cuesFromWords(words('Great question. So the short answer is replicas. Ok.')).map((c) => c[2]),
    ['Great question. So the short answer is replicas.', 'Ok.'],
  );
  // A long pause starts a new cue.
  assert.deepEqual(cuesFromWords([...words('first part'), ...words('second part', 5)]).map((c) => c[2]), ['first part', 'second part']);
  // No cue runs past two subtitle lines or six seconds.
  const long = cuesFromWords(words(Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ')));
  assert.ok(long.length > 1);
  assert.ok(long.every(([start, end, text]) => text.length <= 84 && end - start <= 6));
  // Pieces of one word (no leading space) are joined back together.
  assert.deepEqual(cuesFromWords([[0, 0.3, ' a'], [0.3, 0.6, ' well'], [0.6, 0.9, '-tuned'], [0.9, 1.2, ' database.']]), [[0, 1.2, 'a well-tuned database.']]);
  assert.deepEqual(cuesFromWords([]), []);
  assert.deepEqual(cuesFromWords([[0, 1, '  ']]), []);
});

test('captions: WebVTT output with timestamps, line wrapping and escaping', () => {
  const vtt = toVtt([
    [0, 1.5, 'Hello <there> & welcome'],
    [61.25, 3725.004, 'This cue is long enough that it should wrap onto two lines'],
  ]);
  assert.equal(
    vtt,
    'WEBVTT\n\n' +
      '1\n00:00:00.000 --> 00:00:01.500\nHello &lt;there&gt; &amp; welcome\n\n' +
      '2\n00:01:01.250 --> 01:02:05.004\nThis cue is long enough that\nit should wrap onto two lines\n',
  );
});

// ---------- asking ----------

test('asking out loud: the transcript becomes the question, with public audio and captions', async () => {
  const expert = await register('speech_expert');
  const asker = await register('speech_asker');
  const stranger = client();
  const ohId = await officeHour(expert, { allowAnonymous: true });

  const res = await askOutLoud(asker, ohId, said('How do I scale Postgres reads with replicas?'), { anonymous: true });
  assert.equal(res.status, 200, res.error);
  const q = res.question;
  assert.equal(q.body, 'How do I scale Postgres reads with replicas?');
  assert.equal(q.askedWith, 'audio');
  assert.equal(q.anonymous, true);
  assert.equal(q.audioStatus, 'ready');
  assert.match(q.audio, /^\/media\/[0-9a-f]{32}\.weba$/);
  assert.equal(q.audioTranscript.status, 'ready');
  assert.equal(q.audioTranscript.text, q.body);
  assert.equal(q.audioTranscript.cues.map((c) => c[2]).join(' '), q.body);
  assert.equal(q.audioTranscript.captions, `${q.audio}.vtt`);
  assert.equal(q.audioTranscript.edited, false); // asked as transcribed
  // The asker is waiting, so this used the interactive lane.
  assert.deepEqual(lanes.at(-1), { said: q.body, interactive: true });

  // Everyone can hear the question and get its captions.
  const audio = await stranger.media(q.audio);
  assert.equal(audio.headers.get('content-type'), 'audio/webm');
  assert.equal(await audio.text(), 'said: How do I scale Postgres reads with replicas?');
  const vtt = await stranger.media(q.audioTranscript.captions);
  assert.equal(vtt.status, 200);
  assert.match(vtt.headers.get('content-type'), /^text\/vtt/);
  assert.match(await vtt.text(), /^WEBVTT\n\n1\n00:00:00\.000 --> .*\nHow do I scale/);

  // It's grouped and listed like any question, the author stays hidden, and the asker follows the office hour.
  const view = await stranger('GET', `/api/office-hours/${ohId}`);
  const listed = view.groups.flatMap((g) => g.questions).find((x) => x.id === q.id);
  assert.equal(listed.body, q.body);
  assert.equal(listed.author, null);
  assert.equal(listed.audio, q.audio);
  assert.equal((await asker('GET', `/api/office-hours/${ohId}`)).officeHour.subscribed, true);
  // MP4 and Ogg recordings work too.
  assert.match((await askOutLoud(asker, ohId, said('What about MySQL replicas?'), { type: 'audio/mp4' })).question.audio, /\.m4a$/);
  assert.match((await askOutLoud(asker, ohId, said('And for SQLite, any tips?'), { type: 'audio/ogg;codecs=opus' })).question.audio, /\.ogg$/);
});

test('asking out loud: bad recordings are refused and not kept', async () => {
  const expert = await register('strict_expert');
  const asker = await register('strict_asker');
  const ohId = await officeHour(expert);
  const filesBefore = readdirSync(mediaDir).length;
  const ask = (body, opts) => asker('POST', `/api/office-hours/${ohId}/recordings`, body, opts);

  assert.equal((await ask(said('Is this a video?'), { type: 'video/quicktime' })).status, 415);
  assert.equal((await ask(said('Plain text?'), { type: 'text/plain' })).status, 415);
  assert.equal((await ask(Buffer.alloc(0))).status, 400);
  assert.equal((await ask(said('  '))).status, 400); // nothing was heard
  const garbled = await ask(said('[garbled]'));
  assert.equal(garbled.status, 503);
  assert.match(garbled.error, /try again/);
  assert.equal((await ask(said('x'.repeat(2001)))).status, 400);
  assert.equal((await client()('POST', `/api/office-hours/${ohId}/recordings`, said('Logged out question?'))).status, 401);
  assert.equal(readdirSync(mediaDir).length, filesBefore);

  await expert('POST', `/api/office-hours/${ohId}/close`);
  assert.equal((await ask(said('Too late for this one?'))).status, 409);
  assert.equal(readdirSync(mediaDir).length, filesBefore);
});

test('asking on camera: the video goes with the question, and its sound is the recording', async () => {
  const expert = await register('camera_expert');
  const asker = await register('camera_asker');
  const stranger = client();
  const ohId = await officeHour(expert);
  const filesBefore = readdirSync(mediaDir).length;

  const draft = await asker('POST', `/api/office-hours/${ohId}/recordings`, said('Can you see me? How do I index JSON columns?'), { type: 'video/webm;codecs=vp8,opus' });
  assert.equal(draft.status, 200, draft.error);
  // The draft is known by its sound, and holds the transcript to check like any spoken question.
  assert.match(draft.recording.id, /^[0-9a-f]{32}\.m4a$/);
  assert.equal(draft.recording.text, 'Can you see me? How do I index JSON columns?');
  assert.equal(readdirSync(mediaDir).length, filesBefore + 2); // the video and its sound

  // The asker drops the line that wasn't part of the question.
  const res = await asker('POST', `/api/office-hours/${ohId}/questions`, { recording: draft.recording.id, cues: draft.recording.cues.map((c) => c[2].replace('Can you see me? ', '')) });
  assert.equal(res.status, 200, res.error);
  const q = res.question;
  assert.equal(q.body, 'How do I index JSON columns?');
  assert.equal(q.askedWith, 'audio');
  assert.equal(q.audio, `/media/${draft.recording.id}`);
  assert.match(q.askerVideo, /^\/media\/[0-9a-f]{32}\.webm$/);
  assert.equal(q.audioTranscript.edited, true);

  // Everyone can watch it, and it's listed and published with the question.
  const video = await stranger.media(q.askerVideo);
  assert.equal(video.status, 200);
  assert.equal(video.headers.get('content-type'), 'video/webm');
  assert.equal((await stranger.media(q.audio)).headers.get('content-type'), 'audio/mp4');
  assert.equal((await stranger('GET', `/api/office-hours/${ohId}`)).groups.flatMap((g) => g.questions).find((x) => x.id === q.id).askerVideo, q.askerVideo);
  await expert('PUT', `/api/office-hours/${ohId}/plan`, { items: [{ questionId: q.id }] });
  await expert('PUT', `/api/questions/${q.id}/video?answerStart=3`, said('Use a generated column.'), { type: 'video/mp4' });
  await expert('POST', `/api/office-hours/${ohId}/publish`);
  await app.idle();
  const [answer] = (await stranger('GET', `/api/office-hours/${ohId}`)).answers;
  assert.equal(answer.askerVideo, q.askerVideo);
  assert.equal(answer.audio, q.audio);
  assert.notEqual(answer.video, q.askerVideo);

  // MP4 works too.
  const mp4 = await askOutLoud(asker, await officeHour(expert), said('And from Safari?'), { type: 'video/mp4' });
  assert.match(mp4.question.askerVideo, /\.mp4$/);
});

test('asking on camera: a video without sound is refused; discarding one deletes the video too', async () => {
  const expert = await register('silent_expert');
  const asker = await register('silent_asker');
  const ohId = await officeHour(expert);
  const filesBefore = readdirSync(mediaDir).length;
  const record = (body) => asker('POST', `/api/office-hours/${ohId}/recordings`, body, { type: 'video/mp4' });

  const silent = await record(said('[silent] waving'));
  assert.equal(silent.status, 400);
  assert.match(silent.error, /microphone/);
  assert.equal(readdirSync(mediaDir).length, filesBefore);
  assert.equal((await record(said('  '))).status, 400); // nothing was heard
  assert.equal(readdirSync(mediaDir).length, filesBefore);

  const { recording } = await record(said('A question I will take back.'));
  assert.equal(readdirSync(mediaDir).length, filesBefore + 2);
  await asker('DELETE', `/api/recordings/${recording.id}`);
  assert.equal(readdirSync(mediaDir).length, filesBefore);

  // So is one abandoned for a day.
  const { recording: abandoned } = await record(said('Another one I forget about.'));
  db.prepare('UPDATE recordings SET created_at = ? WHERE media = ?').run(inDays(-2), abandoned.id);
  const { recording: fresh } = await record(said('A fresh question on camera.'));
  assert.equal(readdirSync(mediaDir).length, filesBefore + 2);
  await asker('DELETE', `/api/recordings/${fresh.id}`);
  assert.equal(readdirSync(mediaDir).length, filesBefore);
});

const hasFfmpeg = !spawnSync('ffmpeg', ['-version']).error;

test('ffmpeg takes the sound out of a question video, and fails on one without sound', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forum_extract_'));
  const ffmpeg = (...args) => execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args]);
  const speech = createSpeech({ mode: 'on' }); // the workers only start on a transcribe or speak request
  try {
    ffmpeg('-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=2', '-f', 'lavfi', '-i', 'sine=f=440:duration=2', '-c:v', 'libvpx', '-c:a', 'libopus', '-shortest', join(dir, 'q.webm'));
    ffmpeg('-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=1', '-c:v', 'libvpx', join(dir, 'silent.webm'));
    await speech.extractSound(join(dir, 'q.webm'), join(dir, 'q.m4a'));
    const streams = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name:format=duration', '-of', 'json', join(dir, 'q.m4a')], { encoding: 'utf8' });
    const { streams: [only, ...more], format } = JSON.parse(streams);
    assert.deepEqual([only.codec_type, only.codec_name, more.length], ['audio', 'aac', 0]);
    assert.ok(Math.abs(Number(format.duration) - 2) < 0.1);
    await assert.rejects(speech.extractSound(join(dir, 'silent.webm'), join(dir, 'silent.m4a')));
    assert.deepEqual(readdirSync(dir).sort(), ['q.m4a', 'q.webm', 'silent.webm']);
  } finally {
    speech.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('typed questions and moderator seeds are read aloud in the background', async () => {
  const expert = await register('reader_expert');
  const asker = await register('reader_asker');
  const stranger = client();
  const ohId = await officeHour(expert);

  const { question } = await asker('POST', `/api/office-hours/${ohId}/questions`, { body: 'What is your favorite index type?' });
  assert.equal(question.askedWith, 'text');
  assert.equal(question.audioStatus, 'pending');
  assert.equal(question.audio, null);
  assert.equal(question.audioTranscript, null);
  await expert('POST', `/api/office-hours/${ohId}/seed`, { questions: ['When should you denormalize?'] });
  const { question: muted } = await asker('POST', `/api/office-hours/${ohId}/questions`, { body: 'This one is [mute] somehow' });
  await app.idle();

  const read = (await stranger('GET', `/api/questions/${question.id}`)).question;
  assert.equal(read.audioStatus, 'ready');
  assert.match(read.audio, /^\/media\/[0-9a-f]{32}\.m4a$/);
  const audio = await stranger.media(read.audio);
  assert.equal(audio.headers.get('content-type'), 'audio/mp4');
  assert.equal(await audio.text(), 'spoken: What is your favorite index type?');
  const seed = (await stranger('GET', `/api/office-hours/${ohId}`)).groups.flatMap((g) => g.questions).find((q) => q.source === 'moderator');
  assert.equal(seed.audioStatus, 'ready');
  // A failure is reported, and leaves no file behind.
  assert.deepEqual(
    ((({ audio, audioStatus }) => ({ audio, audioStatus }))((await stranger('GET', `/api/questions/${muted.id}`)).question)),
    { audio: null, audioStatus: 'failed' },
  );
  assert.deepEqual(readdirSync(mediaDir).filter((f) => f.endsWith('.part')), []);
  assert.equal((await stranger('GET', '/api/questions/99999')).status, 404);
});

// ---------- answers ----------

test('answer videos are transcribed in the background; drafts stay private until published', async (t) => {
  const expert = await register('captioned');
  const asker = await register('captioned_asker');
  const stranger = client();
  const ohId = await officeHour(expert);
  const { question: q } = await asker('POST', `/api/office-hours/${ohId}/questions`, { body: 'How do you test migrations?' });
  await expert('PUT', `/api/office-hours/${ohId}/plan`, { items: [{ questionId: q.id }] });

  const release = hold(t);
  const first = await expert('PUT', `/api/questions/${q.id}/video`, said('First take.'), { type: 'video/webm' });
  assert.deepEqual(first.transcript, { status: 'pending', text: null, cues: [], captions: null, edited: false });
  // Re-recorded before the first take was transcribed: only the new take gets a transcript.
  const answer = await expert('PUT', `/api/questions/${q.id}/video`, said('Run them against a copy of production. Then check the row counts.'), { type: 'video/webm' });
  release();
  await app.idle();
  assert.ok(!lanes.some((l) => l.said === 'First take.'));
  assert.equal(lanes.at(-1).interactive, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transcripts WHERE media = ?').get(first.video.split('/').pop()).n, 0);

  const draft = (await expert('GET', `/api/questions/${q.id}`)).question.answerTranscript;
  assert.equal(draft.status, 'ready');
  assert.equal(draft.text, 'Run them against a copy of production. Then check the row counts.');
  assert.deepEqual(draft.cues.map((c) => c[2]), ['Run them against a copy of production.', 'Then check the row counts.']);
  assert.equal(draft.captions, `${answer.video}.vtt`);
  // Nobody else sees the draft or its captions.
  assert.ok(!('answerTranscript' in (await asker('GET', `/api/questions/${q.id}`)).question));
  assert.equal((await stranger.media(draft.captions)).status, 404);
  assert.equal((await expert.media(draft.captions)).status, 200);

  await expert('POST', `/api/office-hours/${ohId}/publish`);
  const published = (await stranger('GET', `/api/office-hours/${ohId}`)).answers[0];
  assert.equal(published.video, answer.video);
  assert.deepEqual(published.transcript, draft);
  assert.deepEqual((await stranger('GET', `/api/questions/${q.id}`)).question.transcript, draft);
  assert.match(await (await stranger.media(draft.captions)).text(), /00:00:00\.000 --> 00:00:03\.400\nRun them against a copy of production\.\n/);
  // Captions only exist for transcribed recordings: not for unknown files, or audio that was read aloud.
  assert.equal((await stranger.media(`/media/${'0'.repeat(32)}.webm.vtt`)).status, 404);
  const readAloud = (await stranger('GET', `/api/questions/${q.id}`)).question.audio;
  assert.match(readAloud, /\.m4a$/);
  assert.equal((await stranger.media(`${readAloud}.vtt`)).status, 404);
});

test('an answer published before its transcript is ready gets it afterwards; removing a take drops its transcript', async (t) => {
  const expert = await register('hasty');
  const asker = await register('hasty_asker');
  const ohId = await officeHour(expert);
  const { question: q1 } = await asker('POST', `/api/office-hours/${ohId}/questions`, { body: 'Published right away?' });
  const { question: q2 } = await asker('POST', `/api/office-hours/${ohId}/questions`, { body: 'Recorded then removed?' });
  await expert('PUT', `/api/office-hours/${ohId}/plan`, { items: [{ questionId: q1.id }, { questionId: q2.id }] });

  const release = hold(t);
  const removed = await expert('PUT', `/api/questions/${q2.id}/video`, said('Never mind.'), { type: 'video/webm' });
  await expert('DELETE', `/api/questions/${q2.id}/video`);
  const video = await expert('PUT', `/api/questions/${q1.id}/video`, said('Yes, straight away.'), { type: 'video/webm' });
  await expert('POST', `/api/office-hours/${ohId}/publish`);
  assert.equal((await asker('GET', `/api/office-hours/${ohId}`)).answers[0].transcript.status, 'pending');
  release();
  await app.idle();
  assert.equal((await asker('GET', `/api/office-hours/${ohId}`)).answers[0].transcript.text, 'Yes, straight away.');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transcripts WHERE media = ?').get(removed.video.split('/').pop()).n, 0);
  assert.ok(existsSync(join(mediaDir, video.video.split('/').pop())));
});

// ---------- startup and speech off ----------

test('on startup, unfinished and never-done speech work is picked up', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forum_speech_resume_'));
  try {
    const oldDb = openDb(':memory:');
    // Data from before speech existed: a typed question with no audio, an answer video with no transcript.
    oldDb.exec(`
      INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (1, 'old', 'Old', 'x', '2026-01-01');
      INSERT INTO office_hours (id, expert_id, title, questions_deadline, answers_expected_at, created_at) VALUES (1, 1, 'Old', '2026-01-02', '2026-01-03', '2026-01-01');
      INSERT INTO questions (id, office_hour_id, author_id, body, created_at, answer_video) VALUES (1, 1, 1, 'An old question?', '2026-01-01', '${'a'.repeat(32)}.webm');
    `);
    writeFileSync(join(dir, `${'a'.repeat(32)}.webm`), said('An old answer.'));
    const resumed = createApp({ db: oldDb, moderator: await createModerator({ mode: 'heuristic' }), mediaDir: dir, speech: fakeSpeech });
    await resumed.idle();
    const q = oldDb.prepare('SELECT audio, audio_status FROM questions WHERE id = 1').get();
    assert.equal(q.audio_status, 'ready');
    assert.equal(readFileSync(join(dir, q.audio), 'utf8'), 'spoken: An old question?');
    const transcript = oldDb.prepare('SELECT text, words FROM transcripts').get();
    assert.equal(transcript.text, 'An old answer.');
    // Word timings are kept too, for captions burned into a finished video.
    assert.deepEqual(JSON.parse(transcript.words), [[0, 0.4, ' An'], [0.5, 0.9, ' old'], [1, 1.4, ' answer.']]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with speech off, questions are typed only and nothing is read aloud or transcribed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forum_speech_off_'));
  const offServer = createServer(createApp({ db: openDb(':memory:'), moderator: await createModerator({ mode: 'heuristic' }), mediaDir: dir }));
  await new Promise((resolve) => offServer.listen(0, resolve));
  const offBase = () => `http://localhost:${offServer.address().port}`;
  try {
    const expert = await register('quiet_expert', offBase);
    const asker = await register('quiet_asker', offBase);
    assert.equal((await asker('GET', '/api/me')).speech, false);
    const ohId = await officeHour(expert);
    assert.equal((await asker('POST', `/api/office-hours/${ohId}/recordings`, said('Can you hear me?'))).status, 503);
    const { question } = await asker('POST', `/api/office-hours/${ohId}/questions`, { body: 'Typed question here?' });
    assert.equal(question.audioStatus, null);
    await expert('PUT', `/api/office-hours/${ohId}/plan`, { items: [{ questionId: question.id }] });
    assert.equal((await expert('PUT', `/api/questions/${question.id}/video`, said('An answer.'), { type: 'video/webm' })).transcript, null);
    assert.deepEqual(readdirSync(dir).length, 1);
  } finally {
    offServer.close();
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal((await client()('GET', '/api/me')).speech, true);
});

// ---------- correcting transcripts ----------

test('the asker checks and corrects the transcript before asking', async () => {
  const expert = await register('fixer_expert');
  const asker = await register('fixer_asker');
  const other = await register('fixer_other');
  const ohId = await officeHour(expert);
  const otherOhId = await officeHour(expert);
  const questionCount = async () => (await asker('GET', `/api/office-hours/${ohId}`)).officeHour.questionCount;

  // Recording only transcribes: nothing is asked yet, and nobody can play the draft.
  // Long enough for two cues: the first ends at the sentence break.
  const { recording } = await asker('POST', `/api/office-hours/${ohId}/recordings`, said('How do you shard a busy Postgres cluster? And when do red replicas stop helping'));
  assert.equal(recording.text, 'How do you shard a busy Postgres cluster? And when do red replicas stop helping');
  assert.equal(recording.cues.length, 2);
  assert.equal(await questionCount(), 0);
  assert.equal((await asker.media(`/media/${recording.id}`)).status, 404);
  const ask = (call, body, oh = ohId) => call('POST', `/api/office-hours/${oh}/questions`, { recording: recording.id, ...body });
  const first = recording.cues[0][2];

  // Only the asker, in that office hour; one line per cue; the result must still be a question.
  assert.equal((await ask(other, { cues: [first, 'x'] })).status, 404);
  assert.equal((await ask(asker, { cues: [first, 'x'] }, otherOhId)).status, 404);
  assert.equal((await ask(asker, { cues: ['only one line'] })).status, 400);
  assert.equal((await ask(asker, { cues: ['', ''] })).status, 400);
  assert.equal((await ask(asker, { cues: ['Hi?', ''] })).status, 400);
  assert.equal((await ask(asker, { cues: [42, 'y'] })).status, 400);
  assert.equal((await ask(asker, { cues: [first, 'x'], anonymous: true })).status, 400); // anonymous isn't enabled
  assert.equal(await questionCount(), 0);

  const res = await ask(asker, { cues: [first, '  And when do  read replicas stop helping?  '] });
  assert.equal(res.status, 200, res.error);
  const q = res.question;
  assert.equal(q.body, 'How do you shard a busy Postgres cluster? And when do read replicas stop helping?');
  assert.equal(q.askedWith, 'audio');
  assert.equal(q.audioTranscript.edited, true);
  // Timings are kept, and the captions say what the asker corrected.
  assert.deepEqual(q.audioTranscript.cues.map(([start, end]) => [start, end]), recording.cues.map(([start, end]) => [start, end]));
  assert.match(q.audioTranscript.captions, new RegExp(`^${q.audio}\\.vtt\\?v=\\d+$`));
  assert.match(await (await client().media(q.audioTranscript.captions)).text(), /\nAnd when do read replicas stop helping\?\n/);
  // A recording is asked once.
  assert.equal((await ask(asker, { cues: [first, 'Again?'] })).status, 404);

  // Clearing a line drops that cue.
  const dropped = await askOutLoud(asker, ohId, said('What is a good shard key? Um, never mind that last bit'), { lines: ['What is a good shard key?', ''] });
  assert.equal(dropped.question.body, 'What is a good shard key?');
  assert.equal(dropped.question.audioTranscript.cues.length, 1);
  await app.idle();
});

test('recordings that are discarded or abandoned are deleted; closed office hours refuse them', async () => {
  const expert = await register('tidy_expert');
  const asker = await register('tidy_asker');
  const other = await register('tidy_other');
  const ohId = await officeHour(expert);
  const record = async (text) => (await asker('POST', `/api/office-hours/${ohId}/recordings`, said(text))).recording;
  const exists = (r) => existsSync(join(mediaDir, r.id));

  // Discarding (re-recording, or giving up) deletes it; nobody else can.
  const discarded = await record('Should I ask this one?');
  await other('DELETE', `/api/recordings/${discarded.id}`);
  assert.ok(exists(discarded));
  assert.equal((await asker('DELETE', `/api/recordings/${discarded.id}`)).ok, true);
  assert.ok(!exists(discarded));
  assert.equal((await asker('POST', `/api/office-hours/${ohId}/questions`, { recording: discarded.id, cues: ['Should I ask this one?'] })).status, 404);

  // One left for over a day is cleaned up when someone next records.
  const abandoned = await record('I will come back to this one.');
  db.prepare('UPDATE recordings SET created_at = ? WHERE media = ?').run(inDays(-2), abandoned.id);
  const fresh = await record('A fresh question for you.');
  assert.ok(!exists(abandoned));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transcripts WHERE media = ?').get(abandoned.id).n, 0);
  assert.ok(exists(fresh));

  // Questions closed while the asker was checking the transcript.
  await expert('POST', `/api/office-hours/${ohId}/close`);
  assert.equal((await asker('POST', `/api/office-hours/${ohId}/questions`, { recording: fresh.id, cues: fresh.cues.map((c) => c[2]) })).status, 409);
});

test('the expert can correct an answer transcript, before and after publishing', async (t) => {
  const expert = await register('fixer_host');
  const asker = await register('fixer_reader');
  const ohId = await officeHour(expert);
  const { question: q } = await asker('POST', `/api/office-hours/${ohId}/questions`, { body: 'How do you test migrations?' });
  await expert('PUT', `/api/office-hours/${ohId}/plan`, { items: [{ questionId: q.id }] });
  const path = `/api/questions/${q.id}/answer-transcript`;
  assert.equal((await expert('PUT', path, { cues: [] })).status, 409); // nothing recorded yet

  const release = hold(t);
  await expert('PUT', `/api/questions/${q.id}/video`, said('Run them against a copy of production. Then check the roe counts.'), { type: 'video/webm' });
  assert.equal((await expert('PUT', path, { cues: ['x', 'y'] })).status, 409); // still transcribing
  release();
  await app.idle();

  assert.equal((await asker('PUT', path, { cues: ['x', 'y'] })).status, 403);
  let res = await expert('PUT', path, { cues: ['Run them against a copy of production.', 'Then check the row counts.'] });
  assert.equal(res.status, 200, res.error);
  assert.equal(res.transcript.text, 'Run them against a copy of production. Then check the row counts.');
  assert.equal(res.transcript.edited, true);
  assert.deepEqual((await expert('GET', `/api/questions/${q.id}`)).question.answerTranscript, res.transcript);

  // Readers get the corrected transcript, and the expert can still fix it after publishing.
  await expert('POST', `/api/office-hours/${ohId}/publish`);
  assert.equal((await asker('GET', `/api/office-hours/${ohId}`)).answers[0].transcript.text, res.transcript.text);
  res = await expert('PUT', path, { cues: ['Run them against a copy of production!', 'Then check the row counts.'] });
  assert.equal(res.status, 200, res.error);
  const published = (await asker('GET', `/api/office-hours/${ohId}`)).answers[0].transcript;
  assert.equal(published.text, 'Run them against a copy of production! Then check the row counts.');
  assert.match(await (await asker.media(published.captions)).text(), /production!\n/);
});

test('published answers get a summary once transcribed, of the answer after the question, and again when corrected', async (t) => {
  const expert = await register('summary_host');
  const asker = await register('summary_reader');
  const ohId = await officeHour(expert);
  const { question: q } = await asker('POST', `/api/office-hours/${ohId}/questions`, { body: 'How do you test migrations?' });
  await expert('PUT', `/api/office-hours/${ohId}/plan`, { items: [{ questionId: q.id }] });
  const release = hold(t);
  // The take starts with the question being played; the answer starts 2.2 seconds in.
  await expert('PUT', `/api/questions/${q.id}/video?answerStart=2.2`, said('How do you test migrations? Run them against a copy of production first. Then check that the row counts match.'), { type: 'video/webm' });
  await expert('POST', `/api/office-hours/${ohId}/publish`);
  assert.equal((await asker('GET', `/api/office-hours/${ohId}`)).answers[0].summary, null); // nothing to summarize yet
  release();
  await app.idle();

  const summary = {
    question: 'How do you test migrations?',
    points: ['Run them against a copy of production first.', 'Then check that the row counts match.'],
    pending: false,
  };
  assert.deepEqual((await asker('GET', `/api/office-hours/${ohId}`)).answers[0].summary, summary);
  assert.deepEqual((await asker('GET', `/api/questions/${q.id}`)).question.summary, summary);

  const res = await expert('PUT', `/api/questions/${q.id}/answer-transcript`, { cues: ['How do you test migrations?', 'Run them against a staging copy first.', 'Then check that the row counts match.'] });
  assert.equal(res.status, 200, res.error);
  assert.equal((await asker('GET', `/api/questions/${q.id}`)).question.summary.points[0], 'Run them against a staging copy first.');
});
