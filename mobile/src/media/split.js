// Split screen, the phone's picture in picture. Where the page shows one picture over another (the
// asker over the joined video while their question plays, the expert over their b-roll, the asker
// over the camera while recording), a phone splits the player in two instead: the picture that would
// be in the corner goes in the top half and the main one in the bottom half, each at full width.
// This is the arithmetic for that, kept apart from React so it can be tested (test/split.test.js).

// Where a layer sits on the stage, a player two 16:9 pictures tall. `center` is a lone picture
// between them, before or after a split; `full` fills the stage (a camera preview, cropped). A stage
// wider than tall (fullscreen on a phone turned sideways) splits side by side instead, the top half's
// picture on the left.
export function slot(name, wide = false) {
  if (wide) {
    if (name === 'top') return { top: '0%', left: '0%', width: '50%', height: '100%' };
    if (name === 'bottom') return { top: '0%', left: '50%', width: '50%', height: '100%' };
    return { top: '0%', left: '0%', width: '100%', height: '100%' };
  }
  if (name === 'top') return { top: '0%', left: '0%', width: '100%', height: '50%' };
  if (name === 'bottom') return { top: '50%', left: '0%', width: '100%', height: '50%' };
  if (name === 'center') return { top: '25%', left: '0%', width: '100%', height: '50%' };
  return { top: '0%', left: '0%', width: '100%', height: '100%' };
}

// The cut to b-roll and back, and a split opening or closing, take this long (as in src/video.js).
export const CUT_FADE = 0.3;

// The parts of the joined video, one per answer, in order: where each starts and ends in it, its
// question, and whether its captions are burned into the picture.
export function joinedParts(answers, chapters) {
  const byId = new Map(answers.map((q) => [q.id, q]));
  return chapters.filter((c) => byId.has(c.questionId)).map((c) => ({ ...c, q: byId.get(c.questionId) }));
}

export const partAt = (parts, t) => parts.find((p) => t < p.end) ?? parts.at(-1);

// What's on screen `t` seconds into the joined video (once it's `started`): `asking`, the question
// being played at the start of its take, up to where the answer starts, with `at`, how far into the
// question's sound (which starts a little after the take does); or `cut`, the answer's b-roll, with
// `clipAt`, how far into the clip. `split` is which of them takes the top half, if either.
export function moment(parts, t, started = true) {
  const part = partAt(parts, t);
  if (!part || !started) return { part, split: null, asking: null, cut: null, at: 0, clipAt: 0 };
  const { q } = part;
  const into = t - part.start;
  const asking = q.answerStart != null && into >= 0 && into < q.answerStart ? q : null;
  const at = asking ? into - (part.questionStart ?? 0) : 0;
  const b = q.broll;
  const cut = !asking && b?.video && b.start != null && into >= b.start && into < b.start + b.length ? b : null;
  return { part, split: asking ? 'question' : cut ? 'broll' : null, asking, cut, at, clipAt: cut ? into - b.start : 0 };
}

// The same for one answer's own video with its b-roll (the planner, and published answers when they
// weren't joined): the expert in the top half while the b-roll plays in the bottom half.
export const brollAt = (broll, t) => Boolean(broll?.video && broll.start != null && t >= broll.start && t < broll.start + broll.length);

// The captions over the joined video, [start, end, text] over all of it: each answer's question and
// transcript, shifted by where its answer starts, except where they're burned into the picture.
export function joinedCues(parts) {
  return parts.flatMap(({ start, end, q, captions }) =>
    captions ? [] : [...(q.questionCues ?? []), ...(q.transcript?.status === 'ready' ? q.transcript.cues : [])].map(([s, e, text]) => [start + s, Math.min(start + e, end), text]),
  );
}

export const cueAt = (cues, t) => cues.find(([start, end]) => t >= start && t < end) ?? null;

// The answer's own captions at `t`, for while its b-roll fills the bottom half: captions burned into
// the joined video are under the clip then, so the player draws them over it.
export function cutCue(part, t) {
  const cues = part.q.transcript?.status === 'ready' ? part.q.transcript.cues : [];
  const cue = cueAt(cues, t - part.start);
  return cue && [part.start + cue[0], part.start + cue[1], cue[2]];
}

// Where the expert's picture is in a frame of the joined video while b-roll plays, as the server
// draws it there (cutawayFilter in src/video.js, which this mirrors): a 4:3 crop of their take at
// the top left, in a thin white frame with rounded corners. The rectangle, [x, y, width, height] in
// pixels of a frame `width` wide, is that picture inside its frame, brought in past the rounded
// corners, so the top half shows just the expert, cropped from the video already playing.
export const PIP = { width: 0.176, inset: 0.03, radius: 0.0096, ring: 0.0022 };

export function pipRect(width) {
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const pw = even(PIP.width * width);
  const ph = even((pw * 3) / 4);
  const ring = Math.max(1, Math.round(PIP.ring * width));
  const corner = Math.ceil(0.3 * Math.round(PIP.radius * width)); // where a rounded corner meets the diagonal
  const x = Math.round(PIP.inset * width) + ring;
  return [x + corner, x + corner, pw - 2 * corner, ph - 2 * corner];
}

// A `w`x`h` picture fitted inside a box, centred: [x, y, width, height].
export function contain(w, h, boxW, boxH) {
  const scale = Math.min(boxW / w, boxH / h);
  return [(boxW - w * scale) / 2, (boxH - h * scale) / 2, w * scale, h * scale];
}
