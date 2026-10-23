import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brollRange, brollWindows, followUpQuestions, groupQuestions, placeBroll, suggestOrder, suggestQuestions, summarizeAnswer } from '../src/moderator/heuristic.js';
import { createModerator } from '../src/moderator/index.js';
import { createMuseModerator } from '../src/moderator/muse.js';

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

test('createModerator falls back to heuristics when no LLM is configured', async () => {
  const moderator = await createModerator({ mode: 'heuristic' });
  assert.equal(moderator.name, 'heuristic');
  const groups = moderator.groupQuestions(questions);
  assert.ok(groups.length >= 3);
  const seeds = await moderator.suggestQuestions({ displayName: 'A', bio: '', expertise: ['ml'] }, { title: 'x', topic: null });
  assert.ok(seeds.length > 0);
});

test('createModerator uses Muse when there is a Meta API key, ahead of Claude', async (t) => {
  const saved = { META_API_KEY: process.env.META_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.META_API_KEY = 'mk-test';
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  assert.equal((await createModerator({ mode: 'auto' })).name, 'muse');
  // Forced without a key, it says why and uses the heuristics.
  delete process.env.META_API_KEY;
  const logs = [];
  assert.equal((await createModerator({ mode: 'muse', log: (msg) => logs.push(msg) })).name, 'heuristic');
  assert.match(logs.join('\n'), /Muse unavailable, using heuristics: META_API_KEY is not set/);
});

// Meta's Model API, stood in for by a fake fetch: records each request, and answers from `reply(body)`.
function withFakeMuse(t, reply) {
  const realFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url: String(url), body, auth: init.headers.Authorization });
    const [status, data] = await reply(body);
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => (globalThis.fetch = realFetch));
  return { muse: createMuseModerator({ apiKey: 'mk-test', model: 'muse-test' }), requests };
}
const completion = (answer, finishReason = 'stop') => [200, { choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(answer), refusal: null }, finish_reason: finishReason }] }];

test('Muse is asked through the Model API, and answers to a schema', async (t) => {
  const groups = [
    { label: 'Staff Promotion', question_ids: [1, 2] },
    { label: 'Distributed Databases', question_ids: [3, 4] },
    { label: 'Hiring', question_ids: [5, 6] },
  ];
  const { muse, requests } = withFakeMuse(t, () => completion({ groups }));
  assert.equal(muse.name, 'muse');
  assert.deepEqual(await muse.groupQuestions(questions), groups.map((g) => ({ label: g.label, questionIds: g.question_ids })));
  const [{ url, auth, body }] = requests;
  assert.equal(url, 'https://api.meta.ai/v1/chat/completions');
  assert.equal(auth, 'Bearer mk-test');
  assert.equal(body.model, 'muse-test');
  assert.deepEqual(body.messages.map((m) => m.role), ['developer', 'user']);
  assert.match(body.messages[0].content, /moderator of "off hours"/);
  assert.match(body.messages[1].content, /^Group these office-hour questions/);
  assert.match(body.messages[1].content, /\[5\] Any tips on hiring and interviewing engineers\?/);
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual(body.response_format.json_schema.schema.required, ['groups']);
});

test("Muse's errors and cut-off answers are reported, and there's no Muse moderator without a key", async (t) => {
  assert.throws(() => createMuseModerator({ apiKey: '' }), /META_API_KEY is not set/);
  let next = [429, { error: { message: 'Rate limit exceeded', type: 'rate_limit_error' } }];
  const { muse } = withFakeMuse(t, () => next);
  await assert.rejects(muse.groupQuestions(questions), /Muse moderator failed \(429\): Rate limit exceeded/);
  next = completion({ question: 'Why?', points: [] }, 'length');
  await assert.rejects(muse.summarizeAnswer({ question: 'Why?', answer: 'Because.' }), /Muse moderator stopped with length/);
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

test('LLM summaries are served once ready, with heuristic ones (marked pending) until then', async () => {
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
  // The facade falls back to the heuristic without an LLM.
  const moderator = await createModerator({ mode: 'heuristic' });
  assert.deepEqual(await moderator.followUpQuestions({ title: 't' }, discussion, { count: 1 }), ['How much time do you spend coding each week?']);
});

// ---------- b-roll ----------

// Words as speech-to-text times them, from `at` seconds: a third of a second each, with a longer
// pause after a sentence.
function spoken(text, at) {
  const words = [];
  for (const w of text.split(' ')) {
    words.push([Math.round(at * 100) / 100, Math.round((at + 0.3) * 100) / 100, ` ${w}`]);
    at += /[.?!]$/.test(w) ? 0.9 : 0.35;
  }
  return words;
}
const kitchen = spoken('So the first thing is to plan your week. Then, when you cook, start with fresh vegetables and chop them all before you turn on the stove. That saves a lot of time. Finally, clean up as you go.', 3);

test('all of the b-roll plays, if the answer is as long, starting after it does and ending before it does where there is room', () => {
  assert.deepEqual(brollRange({ clip: 5, answerStart: 3, end: 23 }), { length: 5, from: 5.5, to: 16.5 });
  // Less room either side as the answer gets shorter, and none once it's as short as the clip.
  assert.deepEqual(brollRange({ clip: 5, answerStart: 3, end: 10 }), { length: 5, from: 4, to: 4 });
  assert.deepEqual(brollRange({ clip: 5, answerStart: 3, end: 8 }), { length: 5, from: 3, to: 3 });
  // Shorter than the clip, the answer is all b-roll.
  assert.deepEqual(brollRange({ clip: 5, answerStart: null, end: 4 }), { length: 4, from: 0, to: 0 });
  // Too short to cut away at all.
  assert.equal(brollRange({ clip: 5, answerStart: 3, end: 4.4 }), null);
  assert.equal(placeBroll({ description: 'anything', clip: 5, answerStart: 3, end: 4.4, words: null }), null);
  // Let run past the end of the answer, all of the clip plays: one longer than the answer from as early as it can.
  assert.deepEqual(brollRange({ clip: 8, answerStart: 2, end: 20, pastEnd: true }), { length: 8, from: 4.5, to: 10.5 });
  assert.deepEqual(brollRange({ clip: 30, answerStart: 2, end: 20, pastEnd: true }), { length: 30, from: 2, to: 2 });
});

test('b-roll goes where the expert chose, shortened to end before the answer does unless it may run past the end', () => {
  const at = (start, more = {}) => placeBroll({ description: 'anything', clip: 6, answerStart: 2, end: 20, words: kitchen, start, ...more });
  assert.deepEqual(at(10), { start: 10, length: 6 });
  assert.deepEqual(at(1), { start: 2, length: 6 }); // not in the question
  assert.deepEqual(at(16), { start: 16, length: 2.5 }); // stopping a moment before the answer ends
  assert.equal(at(17.5), null); // too little left
  assert.deepEqual(at(18, { clip: 8, pastEnd: true }), { start: 18, length: 8 });
  assert.equal(at(19, { clip: 8, pastEnd: true }), null); // it still cuts in while the expert talks
});

test('b-roll goes where the expert talks about what it shows, on a phrase starting', () => {
  const placed = placeBroll({ description: 'Close-up of hands chopping fresh vegetables on a board', clip: 4, answerStart: 3, end: 20, words: kitchen });
  assert.deepEqual(placed, { start: 8.1, length: 4 }); // "start with fresh vegetables and chop them…", after "cook,"
  assert.equal(kitchen.find(([start]) => start === placed.start)[2], ' start');
  // Words said just before the cut count nearly as much: the stove comes up at the end of a
  // sentence, with no phrase starting in it to cut on, so it's cut to as the next one starts.
  const stove = placeBroll({ description: 'A gas stove being turned on', clip: 4, answerStart: 3, end: 20, words: kitchen });
  assert.equal(kitchen.find(([start]) => start === stove.start)[2], ' That');
});

test("b-roll that matches nothing said goes about a third of the way in, at a sentence if there's one", () => {
  const placed = placeBroll({ description: 'A sunset over the ocean', clip: 4, answerStart: 3, end: 20, words: kitchen });
  assert.equal(kitchen.find(([start]) => start === placed.start)[2], ' Then,');
  // Without a transcript, a third of the way into the answer.
  assert.deepEqual(placeBroll({ description: 'A sunset', clip: 4, answerStart: 2, end: 20, words: null }), { start: 8, length: 4 });
  // The question at the start of the take isn't the answer: nothing said in it counts.
  const words = [...spoken('Can you show a sunset?', 0), ...spoken('Sure. It depends on where you live and the season.', 2)];
  assert.ok(placeBroll({ description: 'A sunset', clip: 2, answerStart: 2, end: 12, words }).start >= 2);
});

test('more b-roll goes in the gaps around what is already in the answer, at least a second from it, preferring one all of it fits in', () => {
  const others = [{ start: 8, length: 5 }]; // 8s to 13s
  // Before it, from where the answer starts, to a second before it; after it, a second after, to the end.
  assert.deepEqual(brollWindows({ clip: 4, answerStart: 2, end: 20, others }), [{ length: 4, from: 2.5, to: 3 }, { length: 4, from: 14, to: 15 }]);
  assert.deepEqual(brollRange({ clip: 4, answerStart: 2, end: 20, others }), { length: 4, from: 2.5, to: 3 });
  // A clip too long for either gap plays for as long as the longer one has room for.
  assert.deepEqual(brollRange({ clip: 10, answerStart: 2, end: 20, others }), { length: 6, from: 14, to: 14 });
  // No gap long enough to cut away in: no room.
  assert.equal(brollRange({ clip: 4, answerStart: 2, end: 12, others: [{ start: 3, length: 7.5 }] }), null);
  // Let run past the end, it can only do that after the last of them.
  assert.deepEqual(brollWindows({ clip: 8, answerStart: 2, end: 20, pastEnd: true, others }), [{ length: 5, from: 2, to: 2 }, { length: 8, from: 14, to: 14 }]);

  // Placed where the words match, unless that's taken; then in the gap nearest that matches.
  const description = 'Close-up of hands chopping fresh vegetables on a board';
  const alone = placeBroll({ description, clip: 4, answerStart: 3, end: 20, words: kitchen });
  const around = placeBroll({ description, clip: 4, answerStart: 3, end: 20, words: kitchen, others: [{ start: alone.start - 1, length: 4 }] });
  assert.ok(around.start >= alone.start + 4 || around.start + around.length <= alone.start - 2, `${JSON.stringify(around)} clear of it`);
  // Without a transcript, as near a third of the way in as there's room for all of it.
  assert.deepEqual(placeBroll({ description: 'A sunset', clip: 4, answerStart: 2, end: 20, words: null, others: [{ start: 6, length: 6 }] }), { start: 13, length: 4 });
  // Full of b-roll, there's nowhere for more.
  assert.equal(placeBroll({ description: 'A sunset', clip: 4, answerStart: 2, end: 20, words: kitchen, others: [{ start: 2, length: 7 }, { start: 10, length: 9 }] }), null);
});

test('b-roll the expert cuts in among other b-roll they placed stops where the next starts, and cannot start during one', () => {
  const at = (start, others) => placeBroll({ description: 'anything', clip: 6, answerStart: 2, end: 20, words: kitchen, start, others });
  const others = [{ start: 10, length: 3 }];
  assert.deepEqual(at(5, others), { start: 5, length: 5 }); // up to where the next starts
  assert.deepEqual(at(13, others), { start: 13, length: 5.5 }); // right after it, to a moment before the answer ends
  assert.equal(at(11, others), null); // during it
  assert.equal(at(9, others), null); // too little time before it
});

test('The LLM picks where b-roll goes when configured, kept where it can go, with the heuristic as fallback', async () => {
  const calls = [];
  let reply;
  const llm = { placeBroll: async (input) => (calls.push(input), reply(input)) };
  const moderator = await createModerator({ llm, log: () => {} });
  const cues = [[0, 2.5, 'How do you cook a weeknight dinner?'], [3, 6.5, 'So the first thing is to plan your week.'], [7, 14, 'Then, when you cook, start with fresh vegetables.']];
  const input = { description: 'Hands chopping vegetables', question: 'How do you cook a weeknight dinner?', clip: 4, answerStart: 3, end: 20, words: kitchen, cues };

  reply = () => ({ start: 7.2 });
  assert.deepEqual(await moderator.placeBroll(input), { start: 7.2, length: 4 });
  // It sees the answer, not the question at the start of the take, and where the b-roll can go.
  assert.deepEqual(calls[0], { description: 'Hands chopping vegetables', question: 'How do you cook a weeknight dinner?', cues: cues.slice(1), windows: [{ length: 4, from: 5.5, to: 14.5 }], others: [] });
  reply = () => ({ start: 19 });
  assert.deepEqual(await moderator.placeBroll(input), { start: 14.5, length: 4 }); // can't end after the answer does
  reply = () => Promise.reject(new Error('overloaded'));
  assert.deepEqual(await moderator.placeBroll(input), placeBroll(input));
  // Without a transcript there's nothing to ask about.
  assert.deepEqual(await moderator.placeBroll({ ...input, words: null, cues: null }), placeBroll({ ...input, words: null }));
  assert.equal(calls.length, 3);
  // It's told when the b-roll is full screen rather than split screen, which hides the expert more.
  reply = () => ({ start: 7.2 });
  await moderator.placeBroll({ ...input, full: true });
  assert.equal(calls.at(-1).full, true);
  // Where the expert chose isn't the LLM's to change.
  assert.deepEqual(await moderator.placeBroll({ ...input, start: 12 }), { start: 12, length: 4 });
  assert.equal(calls.length, 4);
  // Around other b-roll, it's told what that shows and where, and where this can go, and kept in the
  // gap nearest where it says.
  const others = [{ start: 8, length: 5, description: 'A pot of water boiling' }];
  reply = () => ({ start: 10 });
  assert.deepEqual(await moderator.placeBroll({ ...input, others }), { start: 14, length: 4 });
  assert.deepEqual([calls.at(-1).others, calls.at(-1).windows], [others, [{ length: 4, from: 3, to: 3 }, { length: 4, from: 14, to: 15 }]]);
});
