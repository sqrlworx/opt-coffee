// Turns word timings from speech-to-text into subtitle cues, and cues into WebVTT.

const LINE = 42; // characters per subtitle line; a cue has at most two
const MAX_CUE_SECS = 6;
const PAUSE_SECS = 1.5; // a silence this long starts a new cue

/**
 * Groups words into readable cues: at most two lines and a few seconds each, ending early at a
 * sentence end or a long pause.
 * @param {[number, number, string][]} words  [start, end, word] in seconds
 * @returns {[number, number, string][]} cues  [start, end, text]
 */
export function cuesFromWords(words) {
  const cues = [];
  let cue = null;
  const flush = () => {
    if (cue) cues.push([cue.start, cue.end, cue.text]);
    cue = null;
  };
  for (const [start, end, raw] of words) {
    const word = String(raw).trim();
    if (!word) continue;
    // Whisper marks a new word with a leading space; without one, it continues the last word
    // ("well" + "-tuned"), so it stays in the same cue with no space.
    const joined = cue && !/^\s/.test(raw);
    if (cue && !joined && (cue.text.length + 1 + word.length > 2 * LINE || end - cue.start > MAX_CUE_SECS || start - cue.end > PAUSE_SECS)) flush();
    if (cue) {
      cue.text += joined ? word : ` ${word}`;
      cue.end = end;
    } else {
      cue = { start, end, text: word };
    }
    if (/[.?!]["')\]]?$/.test(word) && cue.text.length >= LINE / 2) flush();
  }
  flush();
  return cues;
}

/**
 * A take recorded in a session starts with the question being played, up to `answerStart`. Whether
 * a cue or word is the answer goes by its middle; without an `answerStart`, all of it is.
 */
export const saidInAnswer = (answerStart) => ([start, end]) => !answerStart || (start + end) / 2 >= answerStart;

const toMs = (secs) => Math.round(secs * 1000) / 1000;

/**
 * Captions for the question at the start of a take. The question is already known, so they come
 * from it, not from transcribing the take: a spoken question's own transcript, as the asker
 * corrected it (its recording plays from the take's start), or else the text, which is read aloud
 * at an even pace, spread over the time it takes.
 * @param {{body: string, cues?: [number, number, string][] | null, words?: [number, number, string][] | null}} question
 * @returns {{cues: [number, number, string][], words: [number, number, string][]}} timed from the take's start
 */
export function questionCaptions({ body, cues, words }, answerStart) {
  if (!answerStart) return { cues: [], words: [] };
  if (cues?.length) {
    const upTo = (items) => items.filter(([start]) => start < answerStart).map(([start, end, text]) => [start, Math.min(end, answerStart), text]);
    return { cues: upTo(cues), words: upTo(words ?? []) };
  }
  const tokens = body.split(/\s+/).filter(Boolean);
  const total = tokens.reduce((sum, token) => sum + token.length + 1, 0);
  let at = 0;
  const spread = tokens.map((token) => {
    const start = (at / total) * answerStart;
    at += token.length + 1;
    return [toMs(start), toMs((at / total) * answerStart), ` ${token}`];
  });
  return { cues: cuesFromWords(spread), words: spread };
}

/**
 * A take's captions: the question's (see questionCaptions), then the answer's from the take's
 * transcript `take` ({cues, words}).
 */
export function takeCaptions(question, take, answerStart) {
  const asked = questionCaptions(question, answerStart);
  const answer = saidInAnswer(answerStart);
  return { cues: [...asked.cues, ...take.cues.filter(answer)], words: [...asked.words, ...(take.words ?? []).filter(answer)] };
}

function timestamp(secs) {
  const ms = Math.max(0, Math.round(secs * 1000));
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
}

// Long cues are split into two lines at the space nearest the middle.
function wrap(text) {
  if (text.length <= LINE) return text;
  const mid = text.length / 2;
  let best = -1;
  for (let i = text.indexOf(' '); i !== -1; i = text.indexOf(' ', i + 1)) {
    if (best === -1 || Math.abs(i - mid) < Math.abs(best - mid)) best = i;
  }
  return best === -1 ? text : `${text.slice(0, best)}\n${text.slice(best + 1)}`;
}

const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** @param {[number, number, string][]} cues */
export function toVtt(cues) {
  const blocks = cues.map(([start, end, text], i) => `${i + 1}\n${timestamp(start)} --> ${timestamp(end)}\n${escape(wrap(text))}`);
  return `WEBVTT\n\n${blocks.join('\n\n')}\n`;
}
