import { test } from 'node:test';
import assert from 'node:assert/strict';
import { match, matcher, snippet, terms, words } from '../src/search.js';

test('words are lowercased, without accents or punctuation', () => {
  assert.deepEqual(words('Café-au-lait, PLEASE!'), ['cafe', 'au', 'lait', 'please']);
  assert.deepEqual(words(null), []);
  assert.deepEqual(terms('react React hooks'), ['react', 'hooks']);
});

test('every word of the search has to match a word of the text', () => {
  const m = matcher('react hooks');
  assert.ok(m('React', 'All about hooks'));
  assert.ok(!m('React', 'All about classes'));
  assert.equal(matcher('  ,, '), null);
});

test('a word matches the start of a word, or a typo or two off it', () => {
  assert.ok(matcher('kube')('Kubernetes in production')); // still being typed
  assert.ok(!matcher('netes')('Kubernetes')); // not the middle of a word
  assert.ok(!matcher('cat')('Education'));
  assert.ok(matcher('kubrenetes')('Kubernetes')); // swapped letters
  assert.ok(matcher('kuberntes')('Kubernetes')); // a letter missed
  assert.ok(matcher('kubernetis')('Kubernetes')); // a wrong letter
  assert.ok(matcher('kubrnetis')('Kubernetes')); // two typos, in a long word
  assert.ok(matcher('kubrn')('Kubernetes')); // a typo while still typing
  assert.ok(matcher('desing')('Design systems'));
  // Short words have to be spelled right.
  assert.ok(!matcher('cst')('cat'));
  assert.ok(!matcher('dseign')('Database'));
  assert.ok(!matcher('python')('typhoon'));
  assert.ok(matcher('mayo')('Maya'));
  assert.ok(!matcher('maya')('Moving into management'));
});

test('matches score the word itself over its start over a typo, times the weight of where it is', () => {
  const score = (q, text, weight = 1) => match(terms(q), [{ key: 'f', text, weight }])?.score;
  assert.ok(score('data', 'Data') > score('data', 'Databases'));
  assert.ok(score('databases', 'Databases') > score('databses', 'Databases'));
  assert.ok(score('data', 'Databases', 3) > score('data', 'Data', 1));
  // Each word scores its best match.
  const both = match(terms('data growth'), [
    { key: 'title', text: 'Growth', weight: 3 },
    { key: 'description', text: 'Data and more data', weight: 1 },
  ]);
  assert.equal(both.score, 4 * 3 + 4 * 1);
});

test('matches say which parts of each field matched', () => {
  const m = match(terms('data growh'), [
    { key: 'title', text: 'Data, databases and growth', weight: 1 },
    { key: 'topic', text: 'Career', weight: 1 },
  ]);
  // Whole words, the start of one, and a word with a typo in it whole.
  assert.deepEqual(m.ranges, { title: [[0, 4], [6, 10], [20, 26]] });
  assert.deepEqual(match(terms('cafe'), [{ key: 'title', text: 'Le Café Noir', weight: 1 }]).ranges.title, [[3, 7]]);
});

test('a snippet is cut around the first match, on word boundaries', () => {
  const text = `${'lorem ipsum '.repeat(20)}the needle is here ${'dolor sit '.repeat(20)}`;
  const at = text.indexOf('needle');
  const s = snippet(text, [[at, at + 6]], 80);
  assert.ok(s.text.startsWith('…') && s.text.endsWith('…'));
  assert.ok(s.text.length <= 82);
  const [[start, end]] = s.ranges;
  assert.equal(s.text.slice(start, end), 'needle');
  assert.ok(!s.text.slice(1).startsWith(' '));
  assert.deepEqual(snippet('Short\ntext', [[0, 5]]), { text: 'Short text', ranges: [[0, 5]] });
  assert.equal(snippet('No match here', []), null);
});
