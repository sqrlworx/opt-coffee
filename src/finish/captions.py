"""Captions burned into the picture, in the style of podcast clips.

A few words at a time, low and centred, with no box behind them: white for the expert, yellow for
the asker's question. The phone's copy of the video places them for its split screen instead (see
write_mobile_ass). Louder words are set bigger. A key word in a phrase is set heavier
(Montserrat Black), and a stressed little word (not, never, really...) in italics.

The text is the transcript as the expert corrected it. Word timings come from speech-to-text;
where a line was corrected, its words are spread over the line's time instead.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

import numpy as np

MAX_WORDS = 4
MAX_CHARS = 22
PAUSE = 0.4  # a gap this long between words starts a new phrase
LEAD = 0.05  # a phrase appears just before it's said...
HOLD = 0.5  # ...and stays up this long after, unless the next one starts sooner
SIZE = 0.056  # base font size, as a fraction of the frame height
BOTTOM = 0.06  # captions sit this far above the bottom edge
# The phone's copy is upright. The phone fills its upright player with it, or either half of the
# player, cropping it to their shapes (width / height), so its captions go where all of those show.
STAGE, HALF = 9 / 16, 9 / 8
TALLEST = 9 / 20  # a tall phone's screen, in fullscreen
MOBILE_SIZE = 0.06  # as a share of as much of the copy's width as the whole player shows
MOBILE_MARGIN = 1 / 30  # how far above the bottom of the expert's half they sit, as a share of the copy's height
FOCUS = 0.6  # how far down a picture a half's crop sits without a face to go by (see half_focus)
EMPHASIS_SHARE = 0.4  # at most this share of phrases gets an emphasised word

EXPERT = "&H00FFFFFF"  # ASS colours are &HAABBGGRR
ASKER = "&H004DDFFF"  # warm yellow, #FFDF4D


def _words(text: str) -> set[str]:
    return set(text.split())


# Little words that only stand out when they're stressed; then they're set in italics.
STRESS = _words(
    "not never no nothing none nobody always every everything everyone all only really very so too just actually "
    "exactly completely totally absolutely definitely probably especially ultimately basically honestly literally "
    "much more most less least must can't cannot don't won't isn't aren't wasn't weren't shouldn't wouldn't couldn't "
    "doesn't didn't"
)
# Words that are never the key word of a phrase.
STOP = _words(
    "a an the and or but if then than that this these those there here of to in on at by for with from as into onto "
    "about over under up down out off is are was were be been being am do does did doing have has had having i you "
    "he she it we they me him her us them my your his its our their mine yours what which who whom whose when where "
    "why how i'm you're it's that's there's we're they're i've you've we've i'll you'll it'll i'd you'd can could "
    "will would shall should may might also like um uh oh well okay ok yeah yes right kind sort thing things lot get "
    "got go going one because both either neither example instance something anything someone anyone though although "
    "however whether while since until unless still even maybe perhaps first second finally"
)


@dataclass
class Word:
    start: float
    end: float
    text: str
    speaker: str = "expert"
    level: float = 0.0  # dB, how loud it was said
    size: float = 1.0
    style: str = ""  # "", "bold" or "italic"


@dataclass
class Phrase:
    start: float
    end: float
    speaker: str
    words: list[Word] = field(default_factory=list)


def _norm(text: str) -> str:
    return re.sub(r"[^\w']", "", text.lower())


def timed_words(cues: list, words: list | None) -> list[Word]:
    """The transcript's words, with times."""
    pool: list[list] = []
    for start, end, raw in words or []:
        text = str(raw).strip()
        if not text:
            continue
        # Whisper marks a new word with a leading space; without one it continues the last word.
        if pool and not str(raw)[:1].isspace():
            pool[-1][1], pool[-1][2] = end, pool[-1][2] + text
        else:
            pool.append([start, end, text])
    out = []
    for start, end, text in cues:
        tokens = text.split()
        inside = [w for w in pool if start - 0.01 <= (w[0] + w[1]) / 2 <= end + 0.01]
        if [_norm(t) for t in tokens] == [_norm(w[2]) for w in inside]:
            out += [Word(ws, we, token) for (ws, we, _), token in zip(inside, tokens)]
            continue
        # A corrected line (or no word timings): spread its words over the line by length.
        weights = np.array([len(t) + 1 for t in tokens], np.float64)
        edges = start + (end - start) * np.concatenate([[0], np.cumsum(weights) / weights.sum()])
        out += [Word(float(a), float(b), token) for a, b, token in zip(edges[:-1], edges[1:], tokens)]
    return out


def _levels(words: list[Word], audio: np.ndarray, sr: int) -> None:
    """How loud each word was said: the 90th percentile of a 20 ms level over the word."""
    hop, win = sr // 100, sr // 50
    if len(audio) < win:
        return
    frames = np.lib.stride_tricks.sliding_window_view(audio, win)[::hop]
    db = 10 * np.log10(np.mean(frames.astype(np.float64) ** 2, axis=1) + 1e-12)
    for w in words:
        a, b = int(w.start * 100), max(int(w.start * 100) + 1, int(w.end * 100))
        span = db[a:b]
        w.level = float(np.percentile(span, 90)) if len(span) else -120.0


def _ends_clause(text: str, count: int) -> bool:
    return bool(re.search(r"[.?!;:]['\")\]]?$", text)) or (count >= 2 and text.endswith(","))


def phrases(words: list[Word], answer_start: float | None) -> list[Phrase]:
    for w in words:
        w.speaker = "asker" if answer_start and (w.start + w.end) / 2 < answer_start else "expert"
    groups: list[list[Word]] = []
    for w in words:
        cur = groups[-1] if groups else None
        if (
            cur is None
            or w.speaker != cur[-1].speaker
            or len(cur) >= MAX_WORDS
            or sum(len(x.text) + 1 for x in cur) + len(w.text) > MAX_CHARS
            or w.start - cur[-1].end >= PAUSE
            or _ends_clause(cur[-1].text, len(cur))
        ):
            groups.append([w])
        else:
            cur.append(w)
    out = []
    for i, group in enumerate(groups):
        start = max(0.0, group[0].start - LEAD)
        end = group[-1].end + HOLD
        if i + 1 < len(groups):
            end = min(end, groups[i + 1][0].start - LEAD)
        out.append(Phrase(start, max(end, start + 0.2), group[0].speaker, group))
    return out


def _bare(text: str) -> str:
    return re.sub(r"^[^\w$£€]+|[^\w%']+$", "", text)


def emphasise(phrases_: list[Phrase]) -> None:
    """Sizes from loudness, and at most one emphasised word per phrase."""
    for speaker in ("asker", "expert"):
        levels = [w.level for p in phrases_ if p.speaker == speaker for w in p.words if w.level > -100]
        if not levels:
            continue
        median = float(np.median(levels))
        seen: set[str] = set()
        best = []
        for p in phrases_:
            if p.speaker != speaker:
                continue
            top, top_score = None, 0.0
            for w in p.words:
                rel = w.level - median
                # Louder is bigger, in steps, so a line doesn't look like a ransom note.
                w.size = 1.3 if rel >= 7 else 1.15 if rel >= 4 else 1.0
                bare = _bare(w.text)
                key = bare.lower()
                if not bare or rel < -2:
                    continue
                # Said louder or drawn out, and what kind of word it is.
                stretch = float(np.clip((w.end - w.start) / (0.06 * len(bare) + 0.08) - 1, -1, 1))
                score = rel / 3 + 0.5 * stretch
                if re.search(r"\d", bare):
                    score += 2
                    style = "bold"
                elif key in STRESS:
                    score += 0.6
                    style = "italic"
                elif key in STOP or len(bare) < 3:
                    continue
                else:
                    style = "bold"
                    score += 0.4 * (len(bare) >= 7) + 0.4 * (key not in seen) + 0.8 * (bare[0].isupper() and w is not p.words[0])
                seen.add(key)
                if top is None or score > top_score:
                    top, top_score = (w, style), score
            if top is not None and top_score > 0.5:
                best.append((top_score, top))
        best.sort(key=lambda item: -item[0])
        for _, (w, style) in best[: max(1, int(EMPHASIS_SHARE * sum(p.speaker == speaker for p in phrases_)))]:
            w.style = style
            w.size *= 1.12 if style == "bold" else 1.05


def _escape(text: str) -> str:
    return text.replace("\\", "").replace("{", "(").replace("}", ")")


def _time(t: float) -> str:
    cs = max(0, round(t * 100))
    return f"{cs // 360000}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}"


# (speaker, style) -> (font family, bold flag). libass picks the weight by family name; the asker
# is always in italics.
FONTS = {
    ("expert", ""): ("Montserrat", 1),
    ("expert", "bold"): ("Montserrat Black", 0),
    ("expert", "italic"): ("Montserrat", 1),
    ("asker", ""): ("Montserrat SemiBold", 0),
    ("asker", "bold"): ("Montserrat Black", 0),
    ("asker", "italic"): ("Montserrat", 1),
}


def _word_tags(w: Word, base: int) -> str:
    family, bold = FONTS[(w.speaker, w.style)]
    italic = int(w.speaker == "asker" or w.style == "italic")
    return f"{{\\fn{family}\\b{bold}\\i{italic}\\fs{round(base * w.size)}}}"


def caption_top(height: int) -> float:
    """How high a caption at the bottom of the frame reaches, its biggest words included."""
    return height * (1 - BOTTOM) - 1.3 * 1.12 * SIZE * height


def half_focus(face: tuple | None, aspect: float) -> float:
    """How far down a picture of shape `aspect` (width / height) the crop sits that fills a half of
    the phone's player with it, to frame `face` (YuNet's box, x, y, w, h, as fractions of the
    picture): as CSS's object-position, 0 at the top and 1 at the bottom. The chin always stays in;
    then the top of the head too, if there's room, with the eyes a third of the way down if there's
    room for that. Without a face it's FOCUS, a little lower than the middle, as faces are."""
    shown = aspect / HALF  # how much of the picture's height a half shows
    if shown >= 1:
        return 0.5
    if face is None:
        return FOCUS
    _, y, _, h = face
    # YuNet's box runs from the brows to the chin: the eyes are about a third of the way down it,
    # and the top of the head about a third of its height above it.
    lowest = y + 0.93 * h + 0.03 - shown  # the chin in, a little above the bottom
    highest = y - 0.3 * h  # the head in
    top = max(lowest, min(highest, y + 0.35 * h - shown / 3))
    return round(float(np.clip(top / (1 - shown), 0, 1)), 3)


def _mobile_layout(width: int, height: int, focus: float) -> tuple[int, int, float]:
    """Where captions go on the phone's copy, `width` x `height`, whose top half crops it `focus` of
    the way down (as CSS's object-position): their size; how far down their foot is, at the bottom of
    what the top half shows, just above the split, which is low on the whole player too; and how wide
    a line can be for the whole player to show it, even on a tall phone."""
    aspect = width / height
    shown = min(1.0, aspect / HALF)  # how much of its height a half shows
    bottom = focus * (1 - shown) + shown - MOBILE_MARGIN
    return round(MOBILE_SIZE * min(1.0, STAGE / aspect) * width), round(bottom * height), min(1.0, TALLEST / aspect) * width


def _script(width: int, height: int, base: int) -> list[str]:
    """The start of an ASS script for libass, with a style for each speaker at `base` size."""
    # No box: a soft dark edge and shadow keep the words readable on light and dark alike.
    edge = f"{_px(base / 30)},{_px(base / 24)}"  # outline and shadow, 2 and 2.5 at 1080p
    return [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {width}",
        f"PlayResY: {height}",
        "WrapStyle: 2",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: expert,Montserrat,{base},{EXPERT},{EXPERT},&H70000000,&H80000000,-1,0,0,0,100,100,0,0,1,{edge},2,40,40,0,1",
        f"Style: asker,Montserrat SemiBold,{base},{ASKER},{ASKER},&H70000000,&H80000000,0,-1,0,0,100,100,0,0,1,{edge},2,40,40,0,1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]


def _px(n: float) -> str:
    return f"{round(n, 2):g}"


def _pop(base: int) -> str:
    """Each phrase pops in."""
    return rf"\fad(60,0)\fscx90\fscy90\t(0,100,\fscx100\fscy100)\blur{_px(base / 30)}"


def write_ass(phrases_: list[Phrase], path, width: int, height: int, at_top: bool = False) -> int:
    """Writes the captions as an ASS script for libass, low in the frame, or at the top when the
    speaker's mouth would be behind them. Returns how many phrases were written."""
    base = round(SIZE * height)
    lines = _script(width, height, base)
    # One place for the whole take: captions that jump around are hard to follow.
    pos = rf"\an8\pos({width // 2},{int(height * BOTTOM)})" if at_top else rf"\an2\pos({width // 2},{int(height * (1 - BOTTOM))})"
    for p in phrases_:
        text = " ".join(_word_tags(w, base) + _escape(_display(w.text)) for w in p.words)
        lines.append(f"Dialogue: 0,{_time(p.start)},{_time(p.end)},{p.speaker},,0,0,0,,{{{pos}{_pop(base)}}}{text}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return len(phrases_)


def write_mobile_ass(phrases_: list[Phrase], path, width: int, height: int, focus: float) -> int:
    """Writes the captions for the phone's copy of the video (mobile/src/media/JointPlayer.jsx). The
    expert has the top half whenever the player splits, the question's asker or the b-roll below,
    and the top half crops the copy `focus` of the way down (as CSS's object-position). The question
    and the answer both go at the bottom of that, under the expert and just above the split, which is
    low on the whole player too, and within as much of the copy's width as it shows. Returns how many
    phrases were written."""
    base, low, line = _mobile_layout(width, height, focus)
    lines = _script(width, height, base)
    pos = rf"\an2\pos({width // 2},{low})"
    for p in phrases_:
        words = [_word_tags(w, base) + _escape(_display(w.text)) for w in p.words]
        lines.append(f"Dialogue: 0,{_time(p.start)},{_time(p.end)},{p.speaker},,0,0,0,,{{{pos}{_pop(base)}}}{_wrap(words, p.words, base, line)}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return len(phrases_)


def _wrap(tagged: list[str], words: list[Word], base: int, width: float) -> str:
    """A phrase on one line, or broken over two near the middle if it would be wider than `width`."""
    lengths = [(len(_display(w.text)) + 1) * 0.6 * base * w.size for w in words]  # Montserrat is wide
    if sum(lengths) <= width or len(words) < 2:
        return " ".join(tagged)
    split = min(range(1, len(words)), key=lambda i: abs(sum(lengths[:i]) - sum(lengths[i:])))
    return " ".join(tagged[:split]) + r"\N" + " ".join(tagged[split:])


def _display(text: str) -> str:
    """Spoken-style: no trailing commas or full stops; questions and exclamations keep their marks."""
    return re.sub(r"[,.;:]+$", "", text)


def build(cues: list, words: list | None, answer_start: float | None, audio: np.ndarray, sr: int) -> list[Phrase]:
    timed = timed_words(cues, words)
    _levels(timed, audio, sr)
    out = phrases(timed, answer_start)
    emphasise(out)
    return out
