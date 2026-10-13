import { test } from 'node:test';
import assert from 'node:assert/strict';
import { followUpQuestions, groupQuestions, suggestOrder, suggestQuestions, summarizeAnswer } from '../src/moderator/heuristic.js';
import { createModerator } from '../src/moderator/index.js';

const Q = (id, body, votes = 0, source = 'asker') => ({ id, body, votes, source, createdAt: `2026-01-01T00:00:0${id % 10}Z` });

const questions = [
  Q(1, 'How did you get promoted to staff engineer?', 5),
  Q(2, 'What does the promotion process to staff look like at your company?', 3),
  Q(3, 'How do you design a distributed database for high availability?', 1),
  Q(4, 'What consistency tradeoffs do you make in a distributed database?', 0),
  Q(5, 'Any tips on hiring and interviewing engineers?', 2),
  Q(6, 'How do you approach interviewing senior engineers?', 1),
];

function groupOf(groups, id) {
  return groups.findIndex((g) => g.questionIds.includes(id));
}

test('groups similar questions together and keeps unrelated ones apart', () => {
  const groups = groupQuestions(questions);
  assert.equal(groupOf(groups, 1), groupOf(groups, 2));
  assert.equal(groupOf(groups, 3), groupOf(groups, 4));
  assert.equal(groupOf(groups, 5), groupOf(groups, 6));
  assert.notEqual(groupOf(groups, 1), groupOf(groups, 3));
  assert.notEqual(groupOf(groups, 3), groupOf(groups, 5));
  // Every question lands in exactly one group.
  assert.deepEqual(groups.flatMap((g) => g.questionIds).sort(), [1, 2, 3, 4, 5, 6]);
  assert.ok(groups.every((g) => g.label.length > 0));
});

test('labels groups from their shared terms', () => {
  const groups = groupQuestions(questions);
  const dbGroup = groups[groupOf(groups, 3)];
  assert.match(dbGroup.label, /Distributed|Database/);
});

test('handles empty and single inputs', () => {
  assert.deepEqual(groupQuestions([]), []);
  assert.equal(groupQuestions([Q(1, 'Hello there?')]).length, 1);
  assert.deepEqual(suggestOrder([], []), { groups: [], questionIds: [] });
});

test('suggested order starts with the most popular group and sorts by votes within groups', () => {
  const groups = groupQuestions(questions);
  const order = suggestOrder(groups, questions);
  assert.deepEqual(order.questionIds.slice(0, 2), [1, 2]); // promotion group: 5+3 votes
  assert.equal(order.questionIds.length, questions.length);
  for (const g of order.groups) {
    const votes = g.questionIds.map((id) => questions.find((q) => q.id === id).votes);
    assert.deepEqual(votes, [...votes].sort((a, b) => b - a));
  }
});

test('suggested order prefers a related next group over a slightly more popular unrelated one', () => {
  const qs = [
    Q(1, 'How should I prepare for system design interviews?', 6),
    Q(2, 'What do you look for in a system design interview answer?', 0),
    Q(3, 'Which coding interview prep resources do you like?', 2),
    Q(4, 'What is your favorite hiking trail near Seattle?', 3),
  ];
  const groups = [
    { label: 'System design', questionIds: [1, 2] },
    { label: 'Coding interviews', questionIds: [3] },
    { label: 'Hiking', questionIds: [4] },
  ];
  const { groups: ordered } = suggestOrder(groups, qs);
  assert.deepEqual(
    ordered.map((g) => g.label),
    ['System design', 'Coding interviews', 'Hiking'],
  );
});

test('moderator seed questions only count their votes toward popularity', () => {
  const qs = [Q(1, 'Seeded question about rust', 0, 'moderator'), Q(2, 'Asker question about golang', 0, 'asker')];
  const order = suggestOrder([{ label: 'a', questionIds: [1] }, { label: 'b', questionIds: [2] }], qs);
  assert.deepEqual(order.questionIds, [2, 1]);
});

test('suggests seed questions from topic and expertise, avoiding existing ones', () => {
  const expert = { bio: 'Staff engineer, 15 years in infra.', expertise: ['distributed systems', 'career growth'] };
  const oh = { title: 'AMA', topic: 'Kubernetes' };
  const out = suggestQuestions(expert, oh, { count: 6 });
  assert.equal(out.length, 6);
  assert.equal(new Set(out).size, 6);
  assert.ok(out.some((q) => q.includes('Kubernetes')));
  assert.ok(out.some((q) => q.includes('distributed systems')));

  const again = suggestQuestions(expert, oh, { count: 6, existing: out, round: 1 });
  assert.ok(again.length > 0);
  assert.ok(again.every((q) => !out.includes(q)));
});

test('suggests something even with an empty profile and no topic', () => {
  const out = suggestQuestions({ bio: '', expertise: [] }, { title: 'Ask me anything about photography' });
  assert.ok(out.length > 0);
  assert.ok(out.some((q) => /photography/i.test(q)));
});

test('createModerator falls back to heuristics when Claude is not configured', async () => {
  const moderator = await createModerator({ mode: 'heuristic' });
  assert.equal(moderator.name, 'heuristic');
  const groups = moderator.groupQuestions(questions);
  assert.ok(groups.length >= 3);
  const seeds = await moderator.suggestQuestions({ displayName: 'A', bio: '', expertise: ['ml'] }, { title: 'x', topic: null });
  assert.ok(seeds.length > 0);
});

// ---------- summaries ----------

const answer = [
  'Great question.',
  'So the first thing I look at is what your team already knows how to operate,',
  'because running a database at three in the morning is the real cost.',
  'Postgres gives you richer types, better JSON support and extensions like PostGIS.',
  'MySQL is simpler to replicate and has a huge pool of people who know it.',
  'If you have no strong reason either way, pick Postgres. It is the safer default.',
  'Hope that helps!',
].join(' ');
const longQuestion = 'Hi! We are three friends starting a side project. How do I choose between Postgres and MySQL for a new project database, when none of us has run either?';

test('summarizes an answer as a short question and a few points spread through it', () => {
  const summary = summarizeAnswer({ question: longQuestion, answer });
  // The question itself, not the preamble, cut at a word.
  assert.match(summary.question, /^How do I choose between Postgres and MySQL .*…$/);
  assert.ok(summary.question.length <= 91);
  assert.equal(summary.points.length, 3);
  // In the order they were said, and none of the small talk.
  assert.match(summary.points[0], /^So the first thing I look at/);
  assert.ok(summary.points.every((p) => !/Great question|Hope that helps/.test(p)));
  assert.deepEqual(summary.points, [...summary.points].sort((a, b) => answer.indexOf(a.replace(/…$/, '')) - answer.indexOf(b.replace(/…$/, ''))));
  assert.ok(summary.points.every((p) => p.length <= 111));
});

test('summaries of short and empty answers', () => {
  assert.deepEqual(summarizeAnswer({ question: 'Short?', answer: '' }), { question: 'Short?', points: [] });
  // Only short sentences: they're all there is, so they're used.
  assert.deepEqual(summarizeAnswer({ question: 'Count?', answer: 'One, two, three.' }).points, ['One, two, three.']);
});

test('Claude summaries are served once ready, with heuristic ones (marked pending) until then', async () => {
  const calls = [];
  let reply;
  const llm = {
    summarizeAnswer: async (input) => (calls.push(input), reply(input)),
  };
  const moderator = await createModerator({ llm, log: () => {} });
  const input = { question: longQuestion, answer };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  // Empty points are dropped.
  reply = () => ({ question: 'Postgres or MySQL for a new project?', points: ['Choose what your team can operate.', ' ', 'Pick Postgres by default.'] });
  const first = moderator.summarizeAnswer(input);
  assert.equal(first.pending, true);
  assert.deepEqual(first.points, summarizeAnswer(input).points);
  moderator.summarizeAnswer(input); // already being written: not asked twice
  await settle();
  assert.equal(calls.length, 1);
  assert.deepEqual(moderator.summarizeAnswer(input), {
    question: 'Postgres or MySQL for a new project?',
    points: ['Choose what your team can operate.', 'Pick Postgres by default.'],
    pending: false,
  });

  // A failure falls back to the heuristic summary for good, so pages stop waiting.
  reply = () => Promise.reject(new Error('overloaded'));
  const other = { question: 'Another?', answer: answer.slice(16) };
  assert.equal(moderator.summarizeAnswer(other).pending, true);
  await settle();
  assert.deepEqual(moderator.summarizeAnswer(other), { ...summarizeAnswer(other), pending: false });

  // Nothing to summarize: no need to ask.
  assert.deepEqual(moderator.summarizeAnswer({ question: 'Silent?', answer: '' }), { question: 'Silent?', points: [], pending: false });
  assert.equal(calls.length, 2);
});

test('follow-up questions come from people\'s replies: unanswered first, then most liked, no repeats', async () => {
  const discussion = [
    {
      question: 'How do I get promoted?',
      replies: [
        { body: 'Thanks! How long did your promotion take?', likes: 0, byExpert: false, responded: true },
        { body: 'Loved this.', likes: 9, byExpert: false, responded: false },
        { body: 'Do promotion committees read peer feedback?', likes: 1, byExpert: false, responded: false },
        { body: 'Want me to cover packets next?', likes: 3, byExpert: true, responded: false },
      ],
    },
    {
      question: 'Do you still code?',
      replies: [
        { body: 'How much time do you spend coding each week? Is it enough?', likes: 4, byExpert: false, responded: false },
        { body: 'Do promotion committees read the peer feedback?', likes: 0, byExpert: false, responded: false },
      ],
    },
  ];
  assert.deepEqual(followUpQuestions(discussion), [
    'How much time do you spend coding each week?',
    'Is it enough?',
    'Do promotion committees read peer feedback?',
    'How long did your promotion take?',
  ]);
  assert.deepEqual(followUpQuestions(discussion, { count: 1 }), ['How much time do you spend coding each week?']);
  assert.deepEqual(followUpQuestions([]), []);
  // The facade falls back to the heuristic without Claude.
  const moderator = await createModerator({ mode: 'heuristic' });
  assert.deepEqual(await moderator.followUpQuestions({ title: 't' }, discussion, { count: 1 }), ['How much time do you spend coding each week?']);
});
