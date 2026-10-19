// Split screen, the phone's picture in picture. Where the page shows one picture over another (the
// asker over the joined video while their question plays, the asker over the camera while
// recording) or beside it (the expert beside split-screen b-roll), a phone splits the player in two:
// the expert in the top half, and the asker or the b-roll in the bottom half, each at full width.
// This is the arithmetic for that, kept apart from React so it can be tested (test/split.test.js).

// Where a layer sits on the stage, an upright player (9:16): `top` and `bottom` are its halves, and
// `full` is all of it, for a lone picture before or after a split. A stage wider than tall
// (fullscreen on a phone turned sideways) splits side by side instead, the top half's picture on the
// left.
export function slot(name, wide = false) {
  if (wide) {
    if (name === 'top') return { top: '0%', left: '0%', width: '50%', height: '100%' };
    if (name === 'bottom') return { top: '0%', left: '50%', width: '50%', height: '100%' };
    return { top: '0%', left: '0%', width: '100%', height: '100%' };
  }
  if (name === 'top') return { top: '0%', left: '0%', width: '100%', height: '50%' };
  if (name === 'bottom') return { top: '50%', left: '0%', width: '100%', height: '50%' };
  return { top: '0%', left: '0%', width: '100%', height: '100%' };
}

// The cut to b-roll and back, and a split opening or closing, take this long (as in src/video.js).
export const CUT_FADE = 0.3;

// How far down a picture a half crops it, as CSS's object-position (0 at the top, 1 at the bottom).
// For a published video the server frames the expert's and the asker's faces (half_focus in
// src/finish/captions.py, given in the chapters). Otherwise it's FOCUS, a little lower than the
// middle, as faces are: as much as can go, it's the top that's cropped off.
export const FOCUS = 0.6;
export const focusPosition = (focus) => `50% ${Math.round(1000 * (focus ?? FOCUS)) / 10}%`;

// The parts of the joined video, one per answer, in order: where each starts and ends in it, its
// question, whether its captions are burned into the picture, and how its halves crop the expert
// and the asker.
export function joinedParts(answers, chapters) {
  const byId = new Map(answers.map((q) => [q.id, q]));
  return chapters.filter((c) => byId.has(c.questionId)).map((c) => ({ ...c, q: byId.get(c.questionId) }));
}

export const partAt = (parts, t) => parts.find((p) => t < p.end) ?? parts.at(-1);

// What's on screen `t` seconds into the joined video (once it's `started`): `asking`, the question
// being played at the start of its take, up to where the answer starts, with `at`, how far into the
// question's sound (which starts a little after the take does); or `cut`, the answer's split-screen
// b-roll, with `clipAt`, how far into the clip. `split` is which of them takes the bottom half, under
// the expert, if either. Full-screen b-roll is cut into the joined video itself, so it needs no split.
export function moment(parts, t, started = true) {
  const part = partAt(parts, t);
  if (!part || !started) return { part, split: null, asking: null, cut: null, at: 0, clipAt: 0 };
  const { q } = part;
  const into = t - part.start;
  const asking = q.answerStart != null && into >= 0 && into < q.answerStart ? q : null;
  const at = asking ? into - (part.questionStart ?? 0) : 0;
  const b = q.broll;
  const cut = !asking && b?.video && !b.full && b.start != null && into >= b.start && into < b.start + b.length ? b : null;
  return { part, split: asking ? 'question' : cut ? 'broll' : null, asking, cut, at, clipAt: cut ? into - b.start : 0 };
}

// Whether one answer's own video is in its b-roll at `t` (the planner, and published answers when
// they weren't joined): split screen, the expert in the top half while the b-roll plays in the
// bottom half, or full screen, the b-roll over all of it.
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

// Where the expert's picture is in a frame of the page's joined video while b-roll plays in its
// corner, as the server draws it there (cutawayFilter in src/video.js, which this mirrors): a 4:3
// crop of their take at the top left, in a thin white frame with rounded corners. The rectangle,
// [x, y, width, height] in pixels of a frame `width` wide, is that picture inside its frame, brought
// in past the rounded corners, so the top half shows just the expert, cropped from the video already
// playing. The phone's own copy of the joined video has no split-screen b-roll cut in, so this is for
// a video joined before there was one, when all b-roll was cut in that way.
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

// The middle of a `w`x`h` picture that fills a box of another shape, as CSS's object-fit: cover
// crops it: [x, y, width, height] in the picture's pixels.
export function cover(w, h, boxW, boxH) {
  const scale = Math.max(boxW / w, boxH / h);
  const [cw, ch] = [boxW / scale, boxH / scale];
  return [(w - cw) / 2, (h - ch) / 2, cw, ch];
}
