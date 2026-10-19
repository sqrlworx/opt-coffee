import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFinisher } from '../src/finish/index.js';

// The finisher's caption and sound decisions (src/finish), run with uv in a small environment with
// just numpy. Rendering needs models and takes minutes, so it isn't run here.
const FINISH = fileURLToPath(new URL('../src/finish', import.meta.url));
const skip = spawnSync('uv', ['--version']).error && 'uv is not installed';
const py = (code) => {
  const out = execFileSync('uv', ['run', '--quiet', '--no-project', '--with', 'numpy', 'python', '-c', `import json\nfrom captions import Word as W\n${code}`], { cwd: FINISH, encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').at(-1));
};

test('finishing is off when asked, or when uv is missing', () => {
  assert.equal(createFinisher({ mode: 'off' }), null);
  const oldPath = process.env.PATH;
  process.env.PATH = '/nonexistent';
  try {
    const logs = [];
    assert.equal(createFinisher({ mode: 'auto', log: (msg) => logs.push(msg) }), null);
    assert.match(logs[0], /uv not found/);
  } finally {
    process.env.PATH = oldPath;
  }
});

test('captions take their text from the transcript and their timing from the words', { skip }, () => {
  const words = py(`
import captions
words = [[0.0, 0.4, ' Trade'], [0.4, 0.7, '-offs'], [0.7, 1.0, ' matter.'], [1.2, 1.5, ' Really'], [1.5, 2.0, ' much.']]
# The second line was corrected by the expert: its words are spread over the line by length.
cues = [[0.0, 1.0, 'Trade-offs matter.'], [1.2, 2.0, 'Really really much.']]
print(json.dumps([[round(w.start, 3), round(w.end, 3), w.text] for w in captions.timed_words(cues, words)]))
`);
  assert.deepEqual(words, [[0, 0.7, 'Trade-offs'], [0.7, 1, 'matter.'], [1.2, 1.48, 'Really'], [1.48, 1.76, 'really'], [1.76, 2, 'much.']]);
  // No word timings at all (a transcript from before they were kept): spread over each line.
  assert.deepEqual(py(`
import captions
print(json.dumps([[round(w.start, 2), round(w.end, 2), w.text] for w in captions.timed_words([[1.0, 2.0, 'Hi you']], None)]))
`), [[1, 1.43, 'Hi'], [1.43, 2, 'you']]);
});

test('captions come a few words at a time, split by speaker, clause and pause', { skip }, () => {
  const phrases = py(`
import captions
ws = [W(0.0, 0.3, 'How'), W(0.3, 0.5, 'do'), W(0.5, 0.7, 'I'), W(0.7, 1.0, 'choose?'), W(1.6, 1.9, 'Both'), W(1.9, 2.1, 'are'),
      W(2.1, 2.5, 'great,'), W(2.5, 2.8, 'and'), W(2.8, 3.0, 'for'), W(3.0, 3.2, 'most'), W(3.2, 3.5, 'apps'), W(3.5, 3.8, 'either'),
      W(4.6, 5.0, 'works.')]
print(json.dumps([[p.speaker, ' '.join(w.text for w in p.words), round(p.start, 2), round(p.end, 2)] for p in captions.phrases(ws, 1.2)]))
`);
  assert.deepEqual(phrases, [
    ['asker', 'How do I choose?', 0, 1.5], // the question is played before the answer starts
    ['expert', 'Both are great,', 1.55, 2.45],
    ['expert', 'and for most apps', 2.45, 3.45], // four words at most
    ['expert', 'either', 3.45, 4.3], // then a pause
    ['expert', 'works.', 4.55, 5.5],
  ]);
});

test('louder words are bigger, and a key word is set heavier', { skip }, () => {
  const styled = py(`
import captions
ws = [W(0, 0.3, 'We'), W(0.3, 0.6, 'saved'), W(0.6, 1.2, '$4.6M'), W(1.2, 1.5, 'profit'), W(2.0, 2.3, 'and'), W(2.3, 2.6, 'it'),
      W(2.6, 3.2, 'never'), W(3.2, 3.5, 'stops')]
for w, level in zip(ws, [-30, -30, -22, -30, -31, -31, -26, -30]):
    w.level = level
ps = captions.phrases(ws, None)
captions.emphasise(ps)
print(json.dumps({w.text: [w.style, round(w.size, 3)] for p in ps for w in p.words}))
`);
  assert.deepEqual(styled['$4.6M'], ['bold', 1.456]); // 8 dB over the median: biggest, and a number
  assert.deepEqual(styled.never[1], 1.15); // 4 dB over: a step bigger
  for (const word of ['We', 'and', 'it', 'profit']) assert.deepEqual(styled[word], ['', 1], word);
});

test('captions are written for libass, at the bottom or the top, with no box', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'forum_finish_ass_'));
  try {
    py(`
import captions
from pathlib import Path
ps = captions.phrases([W(0, 0.4, 'Hi'), W(0.4, 1.0, '{there}\\\\')], None)
captions.write_ass(ps, Path(${JSON.stringify(join(dir, 'low.ass'))}), 1920, 1080)
captions.write_ass(ps, Path(${JSON.stringify(join(dir, 'top.ass'))}), 1920, 1080, at_top=True)
print('{}')
`);
    const low = readFileSync(join(dir, 'low.ass'), 'utf8');
    assert.match(low, /^Style: expert,Montserrat,60,&H00FFFFFF,&H00FFFFFF,&H70000000,&H80000000,-1,0,0,0,100,100,0,0,1,/m); // border style 1: outline, no box
    assert.match(low, /^Style: asker,Montserrat SemiBold,60,&H004DDFFF,/m);
    assert.match(low, /\\an2\\pos\(960,1015\)/);
    assert.match(low, /\{\\fnMontserrat\\b1\\i0\\fs60\}Hi \{\\fnMontserrat\\b1\\i0\\fs60\}\(there\)$/m);
    assert.match(readFileSync(join(dir, 'top.ass'), 'utf8'), /\\an8\\pos\(960,64\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the phone's captions go under the expert, at the bottom of their half, as it's cropped", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'forum_finish_mobile_ass_'));
  try {
    py(`
import captions
from pathlib import Path
ws = [W(0, 0.4, 'Is'), W(0.4, 1.0, 'it?'), W(2, 2.4, 'Yes'), W(2.4, 3.0, 'indeed.'), W(4.6, 5.0, 'Look'), W(5.0, 5.4, 'here,'), W(6, 6.5, 'see'), W(6.5, 7, 'this.'),
      W(8, 8.6, 'Consistency'), W(8.6, 9.0, 'matters.')]
ps = captions.phrases(ws, 1.5)
ps[-1].words[1].size = 1.456  # said louder, and the key word: too wide for one line
captions.write_mobile_ass(ps, Path(${JSON.stringify(join(dir, 'mobile.ass'))}), 1080, 1440, 0.6)
captions.write_mobile_ass(ps, Path(${JSON.stringify(join(dir, 'mobile_tall.ass'))}), 1080, 1920, 0.74)
print('{}')
`);
    const read = (file) => readFileSync(join(dir, file), 'utf8').split('\n').filter((l) => l.startsWith('Dialogue:'));
    const events = read('mobile.ass');
    assert.match(readFileSync(join(dir, 'mobile.ass'), 'utf8'), /^Style: expert,Montserrat,49,/m); // sized by as much of the copy's width as the whole player shows
    const at = (e) => [e.split(',').slice(1, 4).join(','), /\\pos\((\d+),(\d+)\)/.exec(e).slice(1).map(Number), Number(/\\fs(\d+)/.exec(e)[1])];
    // The top half shows two-thirds of a 3:4 copy's height, here from a fifth of the way down (0.6
    // of the way): the question and the answer go at the bottom of that, under the expert.
    assert.deepEqual(events.map(at), [
      ['0:00:00.00,0:00:01.50,asker', [540, 1200], 49],
      ['0:00:01.95,0:00:03.50,expert', [540, 1200], 49],
      ['0:00:04.55,0:00:05.90,expert', [540, 1200], 49],
      ['0:00:05.95,0:00:07.50,expert', [540, 1200], 49],
      ['0:00:07.95,0:00:09.50,expert', [540, 1200], 49],
    ]);
    assert.ok(events.every((e) => e.includes('\\an2')));
    assert.ok(!events[3].includes('\\N'));
    assert.match(events[4], /Consistency\\N\{/); // two lines, so the whole player shows it
    // A 9:16 copy shows all of its width on the whole player, so the captions are bigger, and a half
    // shows half its height, here from 37% of the way down (0.74 of the way).
    assert.deepEqual(read('mobile_tall.ass').slice(0, 2).map(at), [
      ['0:00:00.00,0:00:01.50,asker', [540, 1606], 65],
      ['0:00:01.95,0:00:03.50,expert', [540, 1606], 65],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the phone's halves crop to frame the face: chin in, then the head, then the eyes a third of the way down", { skip }, () => {
  const focus = py(`
import captions
print(json.dumps({
    # A face filling a 9:16 picture: there's no room for the top of the head, so the chin decides.
    'close': captions.half_focus((0.245, 0.353, 0.612, 0.469), 9 / 16),
    # A 3:4 picture with the face low in it: all of the head fits, from its top.
    'low': captions.half_focus((0.305, 0.439, 0.433, 0.451), 3 / 4),
    # A small face high up: the eyes a third of the way down.
    'small': captions.half_focus((0.4, 0.2, 0.2, 0.15), 3 / 4),
    'none': captions.half_focus(None, 3 / 4),
    'wide': captions.half_focus((0.4, 0.2, 0.2, 0.15), 4 / 3),
}))
`);
  assert.deepEqual(focus, { close: 0.638, low: 0.911, small: 0.091, none: 0.6, wide: 0.5 }); // without a face, more off the top; wider than a half, no crop up or down
});

test("the page's split screen crops the take beside its b-roll to frame the face: centred across, framed down like the phone's halves", { skip }, () => {
  const focus = py(`
import captions
print(json.dumps({
    # A webcam's 16:9 take shows half its width in the left half (8:9): centred on the face, as far
    # as the take goes.
    'left': captions.side_focus((0.1, 0.3, 0.12, 0.2), 16 / 9),
    'off': captions.side_focus((0.55, 0.3, 0.12, 0.2), 16 / 9),
    # A phone's 3:4 take shows all of its width, and is framed down as the phone's halves are, for
    # this shape.
    'phone': captions.side_focus((0.35, 0.3, 0.3, 0.3), 3 / 4),
    'phone half': captions.half_focus((0.35, 0.3, 0.3, 0.3), 3 / 4),
    'none': captions.side_focus(None, 3 / 4),
}))
`);
  assert.deepEqual(focus, { left: [0, 0.5], off: [0.72, 0.5], phone: [0.5, 0.792], 'phone half': 0.548, none: [0.5, 0.6] });
});

test('the voice is matched towards natural speech: dull microphones brought up, missing bands left alone', { skip }, () => {
  const gains = py(`
import numpy as np, sound
rng = np.random.default_rng(0)
n = sound.SR * 12
spectrum = np.fft.rfft(rng.standard_normal(n))
f = np.fft.rfftfreq(n, 1 / sound.SR)
# A dull, band-limited "voice": falling fast above 600 Hz, nothing above 6 kHz; louder and quieter like speech.
spectrum *= 1 / (1 + (f / 600) ** 2) * (f < 6000)
x = np.fft.irfft(spectrum, n) * (0.6 + 0.4 * np.sin(np.arange(n) / sound.SR * 2 * np.pi * 3))
print(json.dumps(dict(zip([int(b) for b in sound.BANDS], [round(float(g), 2) for g in sound.match_eq(x.astype(np.float32))]))))
`);
  assert.ok(gains[2500] > 3 && gains[4000] > 3, `presence and brightness brought up: ${JSON.stringify(gains)}`);
  assert.ok(Object.values(gains).every((g) => g >= -3 && g <= 12), 'cuts and boosts are limited');
  assert.equal(gains[8000], 0); // the microphone never picked it up
  assert.ok(gains[160] === gains[200] && gains[200] === gains[250], 'warmth is set for the octave as a whole');
});
