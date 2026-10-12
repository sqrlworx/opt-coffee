"""Lip sync: how the mouth moves while a question is said, frame by frame.

In the joined video, a question that wasn't asked on camera is said by a fox (public/app.js),
whose mouth follows the question's audio. When Kokoro reads a typed question aloud it predicts
how long it says every phoneme, so those questions get exact timings. A question asked out loud
has its words' timings from speech-to-text and their phonemes from Kokoro's G2P, spread over
each word. Either way each phoneme becomes a mouth shape (a viseme) that blends into its
neighbours, the audio's loudness closes the mouth in silence and opens it wider on loud
syllables, and every m, b and p visibly closes the lips.

Only needs numpy; worker.py brings the speech engines.
"""

from __future__ import annotations

import math

import numpy as np

FPS = 30
LEAD = 0.04  # mouth shapes lead the sound slightly, as in hand-animated lip sync
KOKORO_FRAME = (
    600 / 24000
)  # Kokoro counts phoneme durations in 600-sample frames at 24 kHz

# Mouth pose per viseme: (jaw open 0-1, mouth width scale).
POSES = {
    "rest": (0.0, 1.0),
    "PP": (0.0, 0.95),  # m b p: lips pressed together
    "FF": (0.12, 1.0),  # f v
    "TH": (0.2, 1.0),
    "DD": (0.22, 1.0),  # t d n l
    "kk": (0.3, 1.0),  # k g ng
    "CH": (0.2, 0.75),  # ch j sh zh
    "SS": (0.1, 1.08),
    "RR": (0.22, 0.75),
    "aa": (1.0, 1.0),  # father
    "ae": (0.85, 1.08),  # cat
    "uh": (0.7, 1.0),  # cut
    "E": (0.6, 1.1),  # bed
    "ih": (0.35, 1.12),  # bit, beet
    "oh": (0.7, 0.62),  # thought
    "ou": (0.36, 0.42),  # boot, book
    "er": (0.35, 0.8),
    "schwa": (0.4, 1.0),
    "h": (0.3, 1.0),
}
REST = np.array(POSES["rest"])
# How firmly a viseme holds its shape against its neighbours; vowels default to 1. Lip closures
# must win or "m", "b" and "p" get smeared away by the vowels around them.
DOMINANCE = {
    "rest": 1.5,
    "PP": 4.0,
    "FF": 2.0,
    "TH": 1.2,
    "DD": 0.6,
    "kk": 0.5,
    "CH": 1.2,
    "SS": 1.0,
    "schwa": 0.5,
    "h": 0.15,
}
COARTICULATION = 0.028  # seconds a viseme's influence spreads into its neighbours
# Kokoro's English phonemes (misaki), plus common IPA so other phonemizers degrade gracefully.
PHONE_VISEMES: dict[str, str | tuple[str, str]] = {
    **dict.fromkeys("pbm", "PP"),
    **dict.fromkeys("fv", "FF"),
    **dict.fromkeys("θð", "TH"),
    **dict.fromkeys("tdnlɾT", "DD"),
    **dict.fromkeys("kgɡŋx", "kk"),
    **dict.fromkeys("ʧʤʃʒ", "CH"),
    **dict.fromkeys("sz", "SS"),
    **dict.fromkeys("ɹr", "RR"),
    "j": "ih",
    "w": "ou",
    "h": "h",
    "ʔ": "rest",
    **dict.fromkeys("ɑaɐ", "aa"),
    "æ": "ae",
    "ʌ": "uh",
    **dict.fromkeys("ɛe", "E"),
    **dict.fromkeys("ɪiᵻy", "ih"),
    **dict.fromkeys("ɔɒo", "oh"),
    **dict.fromkeys("uʊ", "ou"),
    **dict.fromkeys("əᵊ", "schwa"),
    **dict.fromkeys("ɜɚɝ", "er"),
    # misaki writes diphthongs as single capitals; the mouth glides from the first shape to the second
    "A": ("E", "ih"),
    "I": ("aa", "ih"),
    "W": ("aa", "ou"),
    "Y": ("oh", "ih"),
    "O": ("oh", "ou"),
    "Q": ("schwa", "ou"),
}
PAUSES = set('.,!?;:—…"()“”«»')
VOWELS = set("ɑaɐæʌɛeɪiᵻyɔɒouʊəᵊɜɚɝAIWYOQ")

Phone = tuple[str, float, float]  # symbol, start, end in seconds


def smoothstep(edge0, edge1, x):
    t = np.clip((x - edge0) / (edge1 - edge0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def kokoro_phones(
    phonemes: str, durations: list[int], vocab, offset: float
) -> list[Phone]:
    """Phonemes and their times in one chunk of Kokoro's speech that starts `offset` seconds in."""
    # The model silently drops symbols outside its vocabulary, so do the same. durations[0]
    # belongs to the start token. Kokoro's own timestamp code starts speech 3 frames before it
    # ends, which matches the audio onset when checked against loudness.
    symbols = [p for p in phonemes if p in vocab]
    t = offset + max(0, durations[0] - 3) * KOKORO_FRAME
    phones = []
    for symbol, frames in zip(symbols, durations[1:-1]):
        phones.append((symbol, t, t + frames * KOKORO_FRAME))
        t += frames * KOKORO_FRAME
    return phones


def word_phones(words: list[tuple[float, float, str]]) -> list[Phone]:
    """Phonemes for words timed by speech-to-text, given as (start, end, phonemes).

    Each word's phonemes share out its time, vowels twice as long as consonants. A word with no
    phonemes (one the G2P doesn't know) still opens the mouth; one that's only punctuation doesn't.
    """
    phones = []
    for start, end, phonemes in words:
        symbols = [p for p in phonemes if p not in PAUSES and p not in " ˈˌ"]
        if not symbols:
            if not phonemes.strip():
                phones.append(("ə", start, end))
            continue
        weights = np.array([2.0 if p in VOWELS else 1.0 for p in symbols])
        edges = (
            start
            + (end - start)
            * np.concatenate([[0.0], np.cumsum(weights)])
            / weights.sum()
        )
        phones += [
            (p, float(a), float(b)) for p, a, b in zip(symbols, edges[:-1], edges[1:])
        ]
    return phones


def frame_loudness(audio: np.ndarray, sample_rate: int, n_frames: int) -> np.ndarray:
    """Loudness around each frame in dB, relative to the loud parts of the speech."""
    power = np.concatenate([[0.0], np.cumsum(audio.astype(np.float64) ** 2)])
    centers = (np.arange(n_frames) / FPS + LEAD) * sample_rate
    half = sample_rate / FPS / 2
    i0 = np.clip(centers - half, 0, len(audio)).astype(int)
    i1 = np.clip(centers + half, 0, len(audio)).astype(int)
    rms = np.sqrt((power[i1] - power[i0]) / np.maximum(i1 - i0, 1))
    db = 20 * np.log10(rms + 1e-5)
    return db - np.percentile(db, 95)


def viseme_segments(
    phones: list[Phone], duration: float
) -> list[tuple[str, float, float]]:
    segments: list[list] = []
    stress_start = None
    for symbol, start, end in phones:
        # stress marks get their own duration, which really belongs to the next vowel
        if symbol in "ˈˌ":
            stress_start = start if stress_start is None else stress_start
            continue
        start = start if stress_start is None else stress_start
        stress_start = None
        if symbol == " ":
            continue
        if symbol == "ː" and segments:
            segments[-1][2] = end
            continue
        viseme = "rest" if symbol in PAUSES else PHONE_VISEMES.get(symbol, "schwa")
        if isinstance(viseme, tuple):
            mid = start + 0.55 * (end - start)
            segments += [[viseme[0], start, mid], [viseme[1], mid, end]]
        else:
            segments.append([viseme, start, end])
    # silence before, after, and in any long gap (between Kokoro's text chunks, or words) is rest
    filled, cursor = [], 0.0
    for seg in segments:
        if seg[1] - cursor > 0.1:
            filled.append(("rest", cursor, seg[1]))
        filled.append(tuple(seg))
        cursor = max(cursor, seg[2])
    filled.append(("rest", cursor, duration))
    return filled


def mouth_track(
    phones: list[Phone], duration: float, loudness: np.ndarray
) -> np.ndarray:
    """Per-frame mouth pose (open, width)."""
    n_frames = len(loudness)
    segments = viseme_segments(phones, duration)
    dt = 1 / 240
    t = np.arange(0, duration + 1.0, dt)
    weight = np.full(len(t), 1e-6)
    pose = weight[:, None] * REST
    # Blend visemes with flat-topped windows whose shoulders reach into the neighbours, so each
    # shape is shaded by what comes before and after it (coarticulation).
    for viseme, start, end in segments:
        i0, i1 = np.searchsorted(
            t, [start - 4 * COARTICULATION, end + 4 * COARTICULATION]
        )
        tt = t[i0:i1]
        margin = min(0.25 * (end - start), 0.02)
        dist = np.maximum(0.0, np.maximum(start + margin - tt, tt - (end - margin)))
        w = DOMINANCE.get(viseme, 1.0) * np.exp(-0.5 * (dist / COARTICULATION) ** 2)
        weight[i0:i1] += w
        pose[i0:i1] += w[:, None] * POSES[viseme]
    pose /= weight[:, None]

    # Each frame shows the average pose over its own exposure, so short sounds aren't skipped.
    csum = np.vstack([np.zeros(2), np.cumsum(pose, axis=0)])
    centers = np.arange(n_frames) / FPS + LEAD
    i0 = np.clip(np.round((centers - 0.5 / FPS) / dt).astype(int), 0, len(t) - 1)
    i1 = np.maximum(
        np.clip(np.round((centers + 0.5 / FPS) / dt).astype(int), 0, len(t)), i0 + 1
    )
    track = (csum[i1] - csum[i0]) / (i1 - i0)[:, None]

    # Speech pads phrase ends with silence, so let loudness close the mouth, and open it a little
    # wider on louder syllables.
    voiced = smoothstep(-40.0, -26.0, loudness)
    track[:, 0] *= voiced * (0.8 + 0.2 * smoothstep(-24.0, -6.0, loudness))
    track[:, 1] = 1.0 + (track[:, 1] - 1.0) * voiced

    # Every m/b/p must visibly close the lips on at least one frame.
    for viseme, start, end in segments:
        if viseme == "PP":
            k = round((0.5 * (start + end) - LEAD) * FPS)
            if 0 <= k < n_frames:
                track[k, 0] = 0.0
    return track


def energy_track(loudness: np.ndarray) -> np.ndarray:
    """How much is being said around each frame, 0-1, smoothed over about half a second."""
    kernel = np.exp(-0.5 * (np.arange(-24, 25) / 8.0) ** 2)
    energy = smoothstep(-30.0, -8.0, loudness)
    return np.convolve(
        np.pad(energy, 24, mode="edge"), kernel / kernel.sum(), mode="valid"
    )


def track(phones: list[Phone], audio: np.ndarray, sample_rate: int) -> dict:
    """The lip sync for speech `audio` saying `phones`: {"fps", "frames": [[open, width, energy], ...]}."""
    duration = len(audio) / sample_rate
    n_frames = max(1, math.ceil(duration * FPS))
    loudness = frame_loudness(audio, sample_rate, n_frames)
    frames = np.column_stack(
        [mouth_track(phones, duration, loudness), energy_track(loudness)]
    )
    return {"fps": FPS, "frames": np.round(frames, 2).tolist()}
