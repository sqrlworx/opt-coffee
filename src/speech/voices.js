/**
 * The Kokoro voices an asker can pick to read their typed question aloud. The first letter of a
 * voice's id is its language (a: American English, b: British English), the second its gender.
 */
export const VOICES = [
  { id: 'af_heart', name: 'Heart', accent: 'American' },
  { id: 'af_bella', name: 'Bella', accent: 'American' },
  { id: 'am_michael', name: 'Michael', accent: 'American' },
  { id: 'bf_emma', name: 'Emma', accent: 'British' },
  { id: 'bm_george', name: 'George', accent: 'British' },
];

/** What a voice says when previewed. */
export const SAMPLE_TEXT = "Hi! This is how your question will sound when it's played to the expert.";

/** The voices to offer when `defaultVoice` reads questions by default: listed first if it isn't one of them. */
export function voicesFor(defaultVoice) {
  return VOICES.some((v) => v.id === defaultVoice) ? VOICES : [{ id: defaultVoice, name: defaultVoice, accent: '' }, ...VOICES];
}
