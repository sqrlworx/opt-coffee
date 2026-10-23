import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createModerator } from '../src/moderator/index.js';
import { createAvatars, Refused } from '../src/avatar/index.js';
import { backdropOf, readPng, rig } from '../src/avatar/rig.js';

const SKIN = [250, 190, 125];
const BACKGROUND = [240, 230, 200];

// A character's face as the image model draws one: a round face on a plain background, two solid
// black oval eyes with a white highlight, and a smile drawn as one dark line, its middle at
// (200, 260) and its corners 10 pixels higher, 100 wide.
function face({ size = 400 } = {}) {
  const data = new Uint8Array(size * size * 4);
  const put = (x, y, [r, g, b]) => data.set([r, g, b, 255], (y * size + x) * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      put(x, y, Math.hypot(x - 200, y - 210) < 150 ? SKIN : BACKGROUND);
      for (const ex of [150, 250]) {
        if (((x - ex) / 14) ** 2 + ((y - 180) / 22) ** 2 <= 1) put(x, y, Math.hypot(x - ex - 4, y - 172) <= 4 ? [255, 255, 255] : [16, 13, 11]);
      }
      if (x >= 150 && x <= 250 && Math.abs(y - (260 - 10 * ((x - 200) / 50) ** 2)) <= 2) put(x, y, [70, 40, 20]);
    }
  }
  return { width: size, height: size, data };
}
// Where the LLM sees its features: a few pixels out, as it is.
const SEEN = { leftEye: [139, 161, 167, 205], rightEye: [233, 155, 267, 201], mouth: [147, 246, 255, 266], head: [50, 60, 350, 360] };
const near = (actual, expected, within, what) => assert.ok(Math.abs(actual - expected) <= within, `${what}: ${actual}, not within ${within} of ${expected}`);
const colourAt = (img, x, y) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)];

test('a character is rigged: its eyes and mouth are found near where they were seen, painted out, and placed for the players', () => {
  const img = face();
  const { rig: r, picture } = rig(img, SEEN);
  assert.equal(r.eyes.length, 2);
  for (const [eye, x] of [[r.eyes[0], 150], [r.eyes[1], 250]]) {
    near(eye.at[0], x, 0.5, 'eye x');
    near(eye.at[1], 180, 0.5, 'eye y');
    near(eye.r[0], 14, 1, 'eye width');
    near(eye.r[1], 22, 1, 'eye height');
    near(eye.shine[0], x + 4, 1, 'highlight x');
    near(eye.shine[1], 172, 1, 'highlight y');
  }
  assert.equal(r.ink, '#100d0b');
  assert.equal(r.shineColor, '255, 255, 255');
  near(r.mouth.at[0], 200, 1, 'mouth x');
  near(r.mouth.at[1], 260, 1, 'mouth y');
  near(r.mouth.sag, 10, 1.5, 'smile');
  near(r.mouth.line, 5, 1, 'line');
  near(r.mouth.halfWidth, 48, 2, 'mouth half width');
  assert.equal(r.mouth.ink, '#462814');
  assert.ok(r.mouth.jaw > 0 && r.mouth.jaw <= 0.15 * 100);
  assert.equal(r.backdrop, '#f0e6c8');
  // What's shown keeps clear of the edges, for it to sway into: 4:3 for the page, square for the
  // phone's bubble and the profile picture.
  const [vx, vy, vw, vh] = r.view;
  assert.ok(vx > 0 && vy > 0 && vx + vw < 400 && vy + vh < 400);
  near(vw / vh, 4 / 3, 0.01, 'view');
  assert.deepEqual(picture, r.bubble);
  assert.equal(r.bubble[2], r.bubble[3]);
  assert.ok(r.bubble[0] > 0 && r.bubble[1] > 0 && r.bubble[0] + r.bubble[2] < 400 && r.bubble[1] + r.bubble[3] < 400);
  assert.ok(r.pivot[1] > 400, 'it sways on a point below the picture');
  // Painted out with the face around them, highlight and all.
  for (const [x, y] of [[150, 180], [154, 172], [250, 180], [200, 260], [155, 251]]) colourAt(img, x, y).forEach((c, i) => near(c, SKIN[i], 2, `colour at ${x},${y}`));
});

test("a character whose eyes or mouth can't be found isn't rigged, and its picture is left as it was", () => {
  const img = face();
  const before = img.data.slice();
  assert.equal(rig(img, { ...SEEN, leftEye: [60, 300, 90, 340] }), null); // plain skin there
  assert.equal(rig(img, { ...SEEN, mouth: [150, 300, 250, 320] }), null);
  assert.deepEqual(img.data, before);
  assert.equal(backdropOf(img), '#f0e6c8');
});

// Characters drawn by a fake artist, which draws `face()` unless told otherwise.
const ffmpeg = !spawnSync('ffmpeg', ['-version']).error;
const png = (img) => execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${img.width}x${img.height}`, '-i', 'pipe:0', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], { input: img.data });
function fakeArtist({ flagged = () => false, design = null, drawings = [] } = {}) {
  const artist = {
    name: 'fake artist',
    drawn: 0,
    flagged: async (input) => flagged(input),
    design: async ({ prompt }) => design ?? { allowed: true, reason: '', characters: [`${prompt} one`, `${prompt} two`, `${prompt} three`] },
    draw: async () => drawings[artist.drawn++] ?? png(face()),
    look: async () => ({ appropriate: true, animatable: true, problem: '', ...SEEN }),
  };
  return artist;
}

test('characters are drawn three at a time, rigged, and as WebP: their profile picture and the picture players animate', { skip: !ffmpeg && 'needs ffmpeg' }, async () => {
  const artist = fakeArtist();
  const avatars = createAvatars({ artist, log: () => {} });
  const options = await avatars.make({ prompt: 'an owl', about: { displayName: 'Maya', bio: '', expertise: [] } });
  assert.deepEqual(options.map((o) => o.character), ['an owl one', 'an owl two', 'an owl three']);
  for (const o of options) {
    for (const file of [o.picture, o.base]) assert.equal(file.subarray(8, 12).toString(), 'WEBP');
    near(o.rig.eyes[0].at[0], 150, 0.5, 'eye x');
  }
  // The profile picture still has its eyes and mouth; the picture players animate doesn't.
  const pixels = (webp) => readPng(execFileSync('ffmpeg', ['-loglevel', 'error', '-i', 'pipe:0', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], { input: webp }));
  const [picture, base] = await Promise.all([pixels(options[0].picture), pixels(options[0].base)]);
  assert.equal(picture.width, 256);
  const scale = 256 / options[0].rig.bubble[2];
  const eye = colourAt(picture, Math.round((150 - options[0].rig.bubble[0]) * scale), Math.round((185 - options[0].rig.bubble[1]) * scale));
  assert.ok(eye.every((c) => c < 60), `the eye in the profile picture is ${eye}`);
  colourAt(base, 150, 185).forEach((c, i) => near(c, SKIN[i], 6, 'painted out'));
});

test("a drawing that can't be animated, or isn't fit to show, is drawn again; what isn't fit to draw is refused", { skip: !ffmpeg && 'needs ffmpeg' }, async () => {
  const about = { displayName: 'Maya', bio: '', expertise: [] };
  // The first drawing has no mouth to find; the next does.
  const noMouth = face();
  for (let i = 0; i < noMouth.data.length; i += 4) if (noMouth.data[i] === 70) noMouth.data.set(SKIN, i);
  let artist = fakeArtist({ design: { allowed: true, reason: '', characters: ['a fox'] }, drawings: [png(noMouth)] });
  let options = await createAvatars({ artist, log: () => {} }).make({ prompt: '', about });
  assert.equal(options.length, 1);
  assert.equal(artist.drawn, 2);
  // If none of them can be animated, it says so.
  artist = fakeArtist({ design: { allowed: true, reason: '', characters: ['a heron'] }, drawings: [noMouth, noMouth, noMouth].map(png) });
  await assert.rejects(createAvatars({ artist, log: () => {} }).make({ prompt: 'a heron', about }), (err) => err instanceof Refused && /face can talk/.test(err.message));
  // Drawings the moderation model flags are drawn again, and if all of them are, it's refused.
  artist = fakeArtist({ design: { allowed: true, reason: '', characters: ['a fox'] }, flagged: (input) => Buffer.isBuffer(input) });
  await assert.rejects(createAvatars({ artist, log: () => {} }).make({ prompt: 'a fox', about }), Refused);
  assert.equal(artist.drawn, 3);
  // What was asked for is flagged, or the designer turns it down, saying why: nothing is drawn.
  artist = fakeArtist({ flagged: (input) => input === 'something rude' });
  await assert.rejects(createAvatars({ artist, log: () => {} }).make({ prompt: 'something rude', about }), { name: 'Error', message: "That isn't something we can draw. Try describing a different character." });
  artist = fakeArtist({ design: { allowed: false, reason: "We can't draw weapons.", characters: [] } });
  await assert.rejects(createAvatars({ artist, log: () => {} }).make({ prompt: 'a knight with a sword dripping blood', about }), (err) => err instanceof Refused && err.message === "We can't draw weapons.");
  assert.equal(artist.drawn, 0);
});

test('characters are off without an OpenAI key', () => {
  assert.equal(createAvatars({ artist: null, log: () => {} }), null);
});

// ---------- over the API ----------

let server;
let base;
let db;
let app;
let mediaDir;
const made = []; // what the fake avatars were asked for
let gate = null; // while set, drawing waits for it

// Draws three "characters" right away, unless asked for something rude or broken.
const fakeAvatars = {
  name: 'fake avatars',
  async make({ prompt, about }) {
    made.push({ prompt, about });
    if (gate) await gate.promise;
    if (prompt.includes('rude')) throw new Refused("That isn't something we can draw.");
    if (prompt.includes('broken')) throw new Error('the artist is out');
    const rigFor = (i) => ({ size: [400, 400], view: [24, 24, 352, 264], bubble: [50, 30, 300, 300], pivot: [200, 600], backdrop: '#f0e6c8', ink: '#100d0b', shineColor: '255, 255, 255', eyes: [], mouth: { at: [200, 260], halfWidth: 48, sag: 10, jaw: 15, line: 5, ink: '#462814' }, i });
    return [1, 2, 3].map((i) => ({ character: `${prompt || 'from the profile'} #${i}`, picture: Buffer.from(`picture ${i}`), base: Buffer.from(`base ${i}`), rig: rigFor(i) }));
  },
};

before(async () => {
  db = openDb(':memory:');
  mediaDir = mkdtempSync(join(tmpdir(), 'forum_avatar_media_'));
  app = createApp({ db, moderator: await createModerator({ mode: 'heuristic' }), mediaDir, avatars: fakeAvatars });
  server = createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});

after(() => {
  server.close();
  rmSync(mediaDir, { recursive: true, force: true });
});

function client() {
  let cookie = '';
  const call = async (method, path, body, { type = 'video/webm' } = {}) => {
    const raw = Buffer.isBuffer(body);
    const res = await fetch(base + path, {
      method,
      headers: { ...(raw ? { 'Content-Type': type } : body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: raw ? body : body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, ...(await res.json()) };
  };
  call.media = (url) => fetch(base + url, { headers: cookie ? { Cookie: cookie } : {} });
  return call;
}

async function register(username) {
  const call = client();
  const res = await call('POST', '/api/auth/register', { username, displayName: username.toUpperCase(), password: 'password123' });
  assert.equal(res.status, 200, res.error);
  return { call, user: res.user };
}

const fileOf = (url) => join(mediaDir, url.slice('/media/'.length));

// Asks for characters and waits for them to be drawn.
async function drawn(person, prompt) {
  const res = await person.call('POST', '/api/me/avatar', { prompt });
  assert.equal(res.status, 200, res.error);
  assert.equal(res.avatar.status, 'pending');
  await app.idle();
  return (await person.call('GET', '/api/me/avatar')).avatar;
}

test('people draw three characters, pick one as their profile picture, and the others are discarded', async () => {
  const maya = await register('maya');
  const leo = await register('leo');
  await maya.call('PATCH', '/api/me', { displayName: 'Maya', bio: 'I bake bread.', expertise: 'baking' });
  assert.equal((await maya.call('GET', '/api/me')).avatars, true);
  assert.equal(maya.user.avatar, null);
  let state = (await maya.call('GET', '/api/me/avatar')).avatar;
  assert.deepEqual(state, { status: null, prompt: null, error: null, options: [], current: null });
  assert.equal((await maya.call('POST', '/api/me/avatar', { prompt: 'x'.repeat(301) })).status, 400);

  // Nothing asked for: it's left to their profile.
  state = await drawn(maya, '');
  assert.deepEqual(made.at(-1), { prompt: '', about: { displayName: 'Maya', bio: 'I bake bread.', expertise: ['baking'] } });
  assert.equal(state.status, 'ready');
  assert.equal(state.options.length, 3);
  const [first, second, third] = state.options;
  assert.match(first.picture, /^\/media\/[0-9a-f]{32}\.webp$/);
  assert.match(first.rig.src, /^\/media\/[0-9a-f]{32}\.webp$/);
  assert.equal(first.rig.i, 1);
  // The ones offered are theirs alone until picked.
  assert.equal((await maya.call.media(first.picture)).status, 200);
  assert.equal(await (await maya.call.media(first.rig.src)).text(), 'base 1');
  assert.equal((await leo.call.media(first.picture)).status, 404);

  // Drawing more replaces them; a description is kept.
  state = await drawn(maya, '  a cheerful   owl ');
  assert.equal(made.at(-1).prompt, 'a cheerful owl');
  assert.equal(state.prompt, 'a cheerful owl');
  assert.ok([first, second, third].every((o) => !existsSync(fileOf(o.picture)) && !existsSync(fileOf(o.rig.src))));
  assert.equal((await maya.call('PUT', '/api/me/avatar', { id: first.id })).status, 404);
  const [owl, other] = state.options;
  assert.equal((await leo.call('PUT', '/api/me/avatar', { id: owl.id })).status, 404);

  let res = await maya.call('PUT', '/api/me/avatar', { id: owl.id });
  assert.equal(res.user.avatar, owl.picture);
  assert.deepEqual(res.avatar.current, owl);
  assert.deepEqual(res.avatar.options, []);
  assert.equal(res.avatar.status, null);
  assert.ok(!existsSync(fileOf(other.picture)));
  // It's public now, and their picture wherever they're shown.
  assert.equal((await leo.call.media(owl.picture)).status, 200);
  assert.equal((await leo.call('GET', '/api/users/maya')).user.avatar, owl.picture);
  assert.equal((await maya.call('GET', '/api/me')).user.avatar, owl.picture);

  // Going back to their initial deletes it, as nothing else has it.
  res = await maya.call('DELETE', '/api/me/avatar');
  assert.equal(res.user.avatar, null);
  assert.ok(!existsSync(fileOf(owl.picture)) && !existsSync(fileOf(owl.rig.src)));
});

test("drawing waits its turn, and what can't be drawn says why", async () => {
  const sam = await register('sam');
  let release;
  gate = { promise: new Promise((resolve) => (release = resolve)) };
  assert.equal((await sam.call('POST', '/api/me/avatar', { prompt: 'a robot' })).status, 200);
  assert.equal((await sam.call('POST', '/api/me/avatar', { prompt: 'a cat' })).status, 409);
  gate = null;
  release();
  await app.idle();
  assert.equal((await sam.call('GET', '/api/me/avatar')).avatar.options.length, 3);

  let state = await drawn(sam, 'something rude');
  assert.equal(state.status, 'failed');
  assert.equal(state.error, "That isn't something we can draw.");
  assert.deepEqual(state.options, [], 'the ones offered before are discarded');
  state = await drawn(sam, 'broken');
  assert.equal(state.error, "Couldn't draw your characters right now. Please try again.");
  // Drawing resumes after a restart.
  db.prepare("UPDATE users SET avatar_status = 'pending', avatar_prompt = 'a teapot' WHERE id = ?").run(sam.user.id);
  const restarted = createApp({ db, moderator: await createModerator({ mode: 'heuristic' }), mediaDir, avatars: fakeAvatars });
  await restarted.idle();
  assert.equal(made.at(-1).prompt, 'a teapot');
  assert.equal((await sam.call('GET', '/api/me/avatar')).avatar.options.length, 3);
});

test("an asker's character says their typed question in the published answers, as it was when they were published", async () => {
  const expert = await register('chef');
  const priya = await register('priya');
  const jo = await register('joan');
  const plain = await register('plain'); // has no character
  const ohId = (await expert.call('POST', '/api/office-hours', { title: 'Ask me about cooking', questionsDeadline: new Date(Date.now() + 86400_000).toISOString(), answersExpectedAt: new Date(Date.now() + 2 * 86400_000).toISOString(), allowAnonymous: true })).officeHour.id;
  const pick = async (person, prompt) => {
    const state = await drawn(person, prompt);
    return (await person.call('PUT', '/api/me/avatar', { id: state.options[0].id })).avatar.current;
  };
  const priyas = await pick(priya, 'a heron');
  await pick(jo, 'a mole');
  const ask = async (person, body, extra = {}) => (await person.call('POST', `/api/office-hours/${ohId}/questions`, { body, ...extra })).question.id;
  const named = await ask(priya, 'How do I keep basil fresh?');
  const anonymous = await ask(priya, 'Is it fine to reuse frying oil?', { anonymous: true });
  const onCamera = await ask(jo, 'How hot should a wok get?');
  db.prepare("UPDATE questions SET asker_video = 'f00dcafe.webm' WHERE id = ?").run(onCamera); // as if asked on camera
  const noCharacter = await ask(plain, 'Why does my rice stick?');
  const ids = [named, anonymous, onCamera, noCharacter];
  await expert.call('PUT', `/api/office-hours/${ohId}/plan`, { items: ids.map((questionId) => ({ questionId })) });
  for (const id of ids) assert.equal((await expert.call('PUT', `/api/questions/${id}/video`, Buffer.from(`answer ${id}`))).status, 200);
  // Not before publishing.
  assert.ok(!('avatar' in (await priya.call('GET', `/api/office-hours/${ohId}`)).groups[0].questions[0]));
  assert.equal((await expert.call('POST', `/api/office-hours/${ohId}/publish`)).status, 200);

  const page = await plain.call('GET', `/api/office-hours/${ohId}`);
  const avatarOf = (id) => page.answers.find((a) => a.id === id).avatar;
  assert.deepEqual(avatarOf(named), priyas.rig);
  assert.equal(avatarOf(anonymous), null, "an anonymous question doesn't give its asker away");
  assert.equal(avatarOf(onCamera), null, 'one asked on camera shows the asker');
  assert.equal(avatarOf(noCharacter), null);
  assert.deepEqual((await plain.call('GET', `/api/questions/${named}`)).question.avatar, priyas.rig);
  assert.ok(page.groups.flatMap((g) => g.questions).every((q) => !('publishedAvatar' in q)));

  // A new character doesn't change the published answers, which keep the old one and its pictures.
  const newer = await pick(priya, 'a lynx');
  assert.equal((await priya.call('GET', '/api/me')).user.avatar, newer.picture);
  assert.deepEqual((await plain.call('GET', `/api/office-hours/${ohId}`)).answers.find((a) => a.id === named).avatar, priyas.rig);
  assert.ok(existsSync(fileOf(priyas.rig.src)));
  assert.equal((await plain.call.media(priyas.rig.src)).status, 200);
  await priya.call('DELETE', '/api/me/avatar');
  assert.ok(existsSync(fileOf(priyas.rig.src)) && !existsSync(fileOf(newer.rig.src)));
});
