// The split screen's arithmetic (src/media/split.js): which half shows what, when.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pipBox, PIP as SERVER_PIP } from '../../src/video.js';
import { brollAt, cover, cutCue, joinedCues, joinedParts, moment, PIP, pipRect, slot } from '../src/media/split.js';

const asked = { id: 1, answerStart: 3, questionCues: [[0, 2.5, 'How do I start?']], transcript: { status: 'ready', cues: [[3.2, 6, 'Start small.']] } };
const withBroll = { id: 2, answerStart: 4, broll: { video: '/media/b.mp4', start: 6, length: 3 }, transcript: { status: 'ready', cues: [[6.5, 8, 'Like this.']] } };
const chapters = [
  { questionId: 1, start: 0, end: 10, captions: false, questionStart: 0.05 },
  { questionId: 2, start: 10, end: 22, captions: true, questionStart: 0 },
  { questionId: 99, start: 22, end: 30, captions: false, questionStart: 0 }, // not published any more
];
const parts = joinedParts([asked, withBroll], chapters);

test('parts are the chapters of the answers there are', () => {
  assert.deepEqual(parts.map((p) => p.q.id), [1, 2]);
});

test('the asker takes the top half while their question plays', () => {
  const m = moment(parts, 1);
  assert.equal(m.split, 'question');
  assert.equal(m.asking, asked);
  assert.ok(Math.abs(m.at - 0.95) < 1e-9, 'timed from where the question’s sound starts');
  assert.equal(moment(parts, 3.5).split, null, 'the answer plays alone');
  assert.equal(moment(parts, 12).split, 'question', 'the next take starts with its question too');
});

test('nothing splits before it has been played', () => {
  assert.equal(moment(parts, 1, false).split, null);
});

test('b-roll takes the bottom half, timed from its start in the take', () => {
  const m = moment(parts, 17);
  assert.equal(m.split, 'broll');
  assert.equal(m.clipAt, 1);
  assert.equal(moment(parts, 15.9).split, null);
  assert.equal(moment(parts, 19).split, null, 'it ends after its length');
});

test('an answer’s own video splits for its b-roll the same way', () => {
  assert.equal(brollAt(withBroll.broll, 7), true);
  assert.equal(brollAt(withBroll.broll, 9), false);
  assert.equal(brollAt({ ...withBroll.broll, start: null }, 7), false, 'not placed (the take is too short for it)');
});

test('captions burned into the picture are drawn while b-roll covers them', () => {
  assert.deepEqual(joinedCues(parts).map((c) => c[2]), ['How do I start?', 'Start small.'], 'only the answers without burned-in captions');
  assert.deepEqual(cutCue(parts[1], 17), [16.5, 18, 'Like this.']);
});

test('the halves stack in a tall stage and sit side by side in a wide one', () => {
  assert.deepEqual(slot('top'), { top: '0%', left: '0%', width: '100%', height: '50%' });
  assert.deepEqual(slot('bottom'), { top: '50%', left: '0%', width: '100%', height: '50%' });
  assert.deepEqual(slot('full'), { top: '0%', left: '0%', width: '100%', height: '100%' }, 'a lone picture has the whole stage');
  assert.deepEqual(slot('top', true), { top: '0%', left: '0%', width: '50%', height: '100%' });
  assert.deepEqual(slot('bottom', true), { top: '0%', left: '50%', width: '50%', height: '100%' });
});

test('in a video joined before the phone had its own copy, the expert is cropped from where the server draws them', () => {
  for (const key of Object.keys(PIP)) assert.equal(PIP[key], SERVER_PIP[key], `PIP.${key} matches src/video.js`);
  // At 1280 wide: a 226x170 picture (even sizes) inside a 3px frame at 38,38, brought in 4px past
  // its rounded corners.
  assert.deepEqual(pipRect(1280), [45, 45, 218, 162]);
  const [x, y, w, h] = pipRect(1920);
  assert.ok(x > 0.03 * 1920 && w < 0.176 * 1920 && h / w > 0.73 && h / w < 0.76 && y === x);
  // The crop is the expert's picture where the server says it is, less its rounded corners, centred on it.
  const [bx, by, bw, bh] = pipBox(1920);
  assert.ok(x - bx < 10 && y - by < 10 && x + w <= bx + bw && y + h <= by + bh);
  assert.equal(x + w / 2, bx + bw / 2);
});

test('a picture fills its place, cropped to its middle', () => {
  assert.deepEqual(cover(4, 3, 16, 9), [0, 0.375, 4, 2.25]);
  // An answer, recorded 3:4, fills the whole upright stage with 75% of its width, and a half with
  // two-thirds of its height.
  assert.deepEqual(cover(810, 1080, 9, 16), [101.25, 0, 607.5, 1080]);
  assert.deepEqual(cover(810, 1080, 9, 8), [0, 180, 810, 720]);
});
