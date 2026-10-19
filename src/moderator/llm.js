// LLM-backed moderator: what the model is asked, and the JSON it answers with. muse.js and claude.js
// send the prompts, each to its own API; every method throws on failure so the caller can fall back
// to the heuristics.

export const SYSTEM = `You are the moderator of "off hours", an app where experts host office hours and other people ask them questions.
Your job is to help the conversation be useful: suggest thoughtful seed questions, and organize submitted questions.
Write questions the way a curious, respectful audience member would: specific, open-ended, one question each, no preamble.`;

const SUGGEST_SCHEMA = {
  type: 'object',
  properties: { questions: { type: 'array', items: { type: 'string' } } },
  required: ['questions'],
  additionalProperties: false,
};

const GROUP_SCHEMA = {
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          question_ids: { type: 'array', items: { type: 'integer' } },
        },
        required: ['label', 'question_ids'],
        additionalProperties: false,
      },
    },
  },
  required: ['groups'],
  additionalProperties: false,
};

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    question: { type: 'string' },
    points: { type: 'array', items: { type: 'string' } },
  },
  required: ['question', 'points'],
  additionalProperties: false,
};

const BROLL_SCHEMA = {
  type: 'object',
  properties: { start: { type: 'number' } },
  required: ['start'],
  additionalProperties: false,
};

const secs = (t) => `${t.toFixed(1)}s`;

/**
 * @param {string} name  what the app calls it ("muse", "claude")
 * @param {(prompt: string, schema: object) => Promise<any>} ask  sends `prompt`, after SYSTEM, and
 *   returns the model's answer, parsed: JSON matching `schema`
 */
export function createLlmModerator(name, ask) {
  return {
    name,

    async suggestQuestions(expert, officeHour, { existing = [], count = 6 } = {}) {
      const prompt = [
        `Suggest ${count} seed questions for this office hour.`,
        '',
        `<expert>\nName: ${expert.displayName}\nExpertise: ${expert.expertise.join(', ') || '(none listed)'}\nBio: ${expert.bio || '(none)'}\n</expert>`,
        `<office_hour>\nTitle: ${officeHour.title}\nTopic: ${officeHour.topic || '(open topic)'}\nDescription: ${officeHour.description || '(none)'}\n</office_hour>`,
        existing.length
          ? `<already_asked>\n${existing.map((q) => `- ${q}`).join('\n')}\n</already_asked>\nDo not repeat or closely paraphrase anything already asked.`
          : '',
        'Draw on the expert\'s specific background so the questions could not be asked of just anyone. Mix practical, reflective, and forward-looking questions.',
      ].join('\n');
      const { questions } = await ask(prompt, SUGGEST_SCHEMA);
      return questions.map((q) => q.trim()).filter(Boolean).slice(0, count);
    },

    async followUpQuestions(officeHour, discussion, { count = 8 } = {}) {
      const prompt = [
        `Suggest up to ${count} questions for a follow-up to this office hour, drawn from the discussion people had under its answers.`,
        '',
        `<office_hour>\nTitle: ${officeHour.title}\nTopic: ${officeHour.topic || '(open topic)'}\nDescription: ${officeHour.description || '(none)'}\n</office_hour>`,
        '<discussion>',
        ...discussion.map(({ question, replies }) =>
          [
            `<answered_question>${question}</answered_question>`,
            ...replies.map((r) => `- ${r.byExpert ? '[expert] ' : ''}${r.body} (${r.likes} like${r.likes === 1 ? '' : 's'}${r.responded ? ', the expert responded' : ''})`),
          ].join('\n'),
        ),
        '</discussion>',
        '',
        'Each question should pick up something the discussion left open: a point people pushed back on, asked more about, or that the expert did not get to. Prefer what more people liked. Do not invent subjects the discussion never raised, and do not re-ask the answered questions. If the discussion raises nothing worth following up, return no questions.',
      ].join('\n');
      const { questions } = await ask(prompt, SUGGEST_SCHEMA);
      return questions.map((q) => q.trim()).filter(Boolean).slice(0, count);
    },

    async groupQuestions(questions) {
      const prompt = [
        'Group these office-hour questions so that questions about the same underlying subject are together.',
        'Every question id must appear in exactly one group. A question that fits nowhere gets its own group.',
        'Labels should be 1-4 words, Title Case, naming the shared subject.',
        '',
        '<questions>',
        ...questions.map((q) => `[${q.id}] ${q.body}`),
        '</questions>',
      ].join('\n');
      const { groups } = await ask(prompt, GROUP_SCHEMA);
      return groups.map((g) => ({ label: g.label, questionIds: g.question_ids }));
    },

    async summarizeAnswer({ question, answer }) {
      const prompt = [
        "Summarize one answer from an office hour. It's shown as a short transcript under the video of the answers.",
        '',
        `<question>\n${question}\n</question>`,
        `<answer_transcript>\n${answer}\n</answer_transcript>`,
        '',
        'question: the question restated in at most 12 words.',
        'points: the 1-3 main points of the answer, in the order they were made. Each is one plain sentence of at most 20 words that states the point itself (not "The expert says..."). Skip small talk.',
      ].join('\n');
      return ask(prompt, SUMMARY_SCHEMA);
    },

    async placeBroll({ description, question, cues, length, from, to, full = false }) {
      const looks = full
        ? "it fills the screen, the expert's picture moves to a small window in the corner (on a phone it isn't seen at all), and the expert keeps talking."
        : 'the screen splits, the expert on one side and the b-roll on the other, and the expert keeps talking.';
      const prompt = [
        `Pick where to cut away to b-roll in one answer from an office hour's video. While the b-roll plays, ${looks}`,
        '',
        `<question>\n${question}\n</question>`,
        `<b_roll seconds="${length.toFixed(1)}">\n${description}\n</b_roll>`,
        '<answer_transcript>',
        ...cues.map(([start, end, text]) => `[${secs(start)}-${secs(end)}] ${text}`),
        '</answer_transcript>',
        '',
        `start: when the b-roll starts, in seconds, between ${secs(from)} and ${secs(to)}. Cut away as the expert starts talking about what the b-roll shows, at the start of a sentence or phrase, so it illustrates what they're saying while they say it. If nothing in the answer matches it, pick a moment where it still fits, such as an example or a description, rather than an emotional or personal moment where the viewer wants to see the expert's face.`,
      ].join('\n');
      return ask(prompt, BROLL_SCHEMA);
    },
  };
}
