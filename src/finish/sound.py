"""Dialogue that sounds like it was recorded on a studio microphone.

Two treatments of the voice:
- "studio" (the default) restores it with Sidon, a speech-restoration model that resynthesises
  the voice as clean, full-band studio speech from what it hears: the room and the noise go, the
  chest of the voice and the top end a headset never picked up come back. The words and the
  speaker stay, though the voice's colour changes a little, as between two microphones.
- "natural" only takes the room out, with DeepFilterNet3, and keeps the recorded voice itself.

Either way the voice is then matched to the spectrum of natural speech (headset and laptop
microphones sound boxy and dull, and Sidon comes out warm), with a broadcast microphone's proximity
warmth and presence on top. An expander keeps the pauses quiet, and two compressors follow, a slow
leveller and a fast peak catcher, as on broadcast dialogue.

The asker's question (played into the take) and the expert's answer come from different sources,
so each is measured, matched and levelled separately, to -16 LUFS; peaks stay under -1.5 dBTP.
"""

from __future__ import annotations

import os
import re
import subprocess
import warnings

import numpy as np

SR = 48000
TARGET_LUFS = -16.0  # the stereo programme
DUAL_MONO_LU = 3.01  # the same signal on both channels measures 3 dB louder than one channel alone
PRE_LUFS = -24.0  # level going into the expander and compressors, so they work the same on every take
TRUE_PEAK_DB = -1.5
CROSSFADE = 0.06  # seconds, between the question's treatment and the answer's

# ANSI S3.5 standard speech spectrum level (normal effort, dB per Hz) at third-octave centres, with
# its slope carried on above 8 kHz, plus the flavour of a broadcast microphone up close: proximity
# warmth, presence and a little air.
BANDS = np.array([160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000], np.float64)
SPEECH = np.array([32.41, 34.48, 34.75, 33.98, 34.59, 34.27, 32.06, 28.30, 25.01, 23.00, 20.15, 17.32, 13.18, 11.55, 9.33, 5.31, 2.59, 1.13, -0.5, -2.5, -5.0])
FLAVOUR = np.array([3, 3, 2, 1, 0, 0, 0, 0, 0, 0, 0.5, 1.5, 2, 2, 2, 1.5, 1, 0, 1, 1, 0])
REFERENCE = (BANDS >= 400) & (BANDS <= 1000)  # levels are compared relative to this range
# Mostly a voice is brought up where its microphone lost it; one that's brighter or fuller than
# the target is left nearly as it is, as the speaker's own character.
MAX_CUT, MAX_LOW_BOOST, MAX_BOOST = 3.0, 8.0, 12.0
MAX_AIR_BOOST = 3.0  # above 8 kHz the top end is the restoration's own: only a touch more air
MISSING_DB = 25.0  # a band this far under the target is past the microphone's range: left alone
MAX_SIBILANCE_DB = 8.0  # loudest /s/ sounds over the vowels, at most

# Sidon (MIT): a w2v-BERT 2.0 feature cleaner and a 48 kHz vocoder, as TorchScript for the CPU.
SIDON = ("sarulab-speech/sidon-v0.1", "b3b02d8bbd55fdbc410e6e46e76ef95ace4fbf52")
W2V_BERT = ("facebook/w2v-bert-2.0", "da985ba0987f70aaeb84a80f2851cfac8c697a7b")
SIDON_DELAY = 0.005  # its output trails the input by this much, in seconds


def _ffmpeg(x: np.ndarray, filters: str) -> np.ndarray:
    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", "-", "-af", filters, "-f", "f32le", "-ar", str(SR), "-ac", "1", "-"],
        input=np.ascontiguousarray(x, np.float32).tobytes(),
        capture_output=True,
        check=True,
    )
    y = np.frombuffer(proc.stdout, np.float32)
    return np.pad(y, (0, max(0, len(x) - len(y))))[: len(x)].copy()


def loudness(x: np.ndarray) -> float | None:
    """Integrated loudness (BS.1770, gated) of one channel, in LUFS; None for (near) silence."""
    if len(x) < SR // 2:
        return None
    proc = subprocess.run(
        ["ffmpeg", "-nostats", "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", "-", "-af", "ebur128=framelog=quiet", "-f", "null", "-"],
        input=np.ascontiguousarray(x, np.float32).tobytes(),
        capture_output=True,
        check=True,
    )
    found = re.findall(r"I:\s+(-?[\d.]+) LUFS", proc.stderr.decode(errors="replace"))
    value = float(found[-1]) if found else None
    return value if value is not None and value > -70 else None


def true_peak(x: np.ndarray) -> float:
    """dBTP, from the signal oversampled four times."""
    up = _ffmpeg_rate(x, SR * 4)
    return float(20 * np.log10(np.abs(up).max() + 1e-12))


def _ffmpeg_rate(x: np.ndarray, rate: int) -> np.ndarray:
    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", "-", "-af", f"aresample={rate}", "-f", "f32le", "-"],
        input=np.ascontiguousarray(x, np.float32).tobytes(),
        capture_output=True,
        check=True,
    )
    return np.frombuffer(proc.stdout, np.float32)


def _spectrum(x: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray] | None:
    """Per-Hz power at each third-octave band over the speech (the louder 60% of frames), and the
    per-frame high/low energy ratio for sibilance."""
    n, hop = 4096, 2048
    if len(x) < n * 4:
        return None
    frames = np.lib.stride_tricks.sliding_window_view(x, n)[::hop] * np.hanning(n).astype(np.float32)
    power = np.abs(np.fft.rfft(frames, axis=1)) ** 2
    energy = power.sum(axis=1)
    speech = energy > np.percentile(energy, 40)
    f = np.fft.rfftfreq(n, 1 / SR)
    mean = power[speech].mean(axis=0)
    levels = np.array([10 * np.log10(mean[(f >= c * 2 ** (-1 / 6)) & (f < c * 2 ** (1 / 6))].mean() + 1e-20) for c in BANDS])
    high = power[speech][:, (f >= 4500) & (f < 8000)].sum(axis=1)
    low = power[speech][:, (f >= 300) & (f < 3000)].sum(axis=1)
    return levels, 10 * np.log10(high / np.maximum(low, 1e-20) + 1e-12), f


def match_eq(x: np.ndarray) -> np.ndarray | None:
    """Gains (dB) per band that bring this voice to the target spectrum, within limits."""
    measured = _spectrum(x)
    if measured is None:
        return None
    levels, sibilance, _ = measured
    target = SPEECH + FLAVOUR
    rel = levels - levels[REFERENCE].mean()
    want = target - target[REFERENCE].mean()
    gain = want - rel
    missing = rel < want - MISSING_DB  # nothing there to bring up
    gain[missing] = 0.0
    gain = np.clip(gain, -MAX_CUT, np.where(BANDS >= 8000, MAX_AIR_BOOST, MAX_BOOST))
    mid = BANDS > 250
    gain[mid] = np.convolve(np.pad(gain[mid], 1, mode="edge"), np.ones(3) / 3, mode="valid")  # no narrow peaks
    gain[missing] = 0.0
    gain[BANDS >= 8000] = np.minimum(gain[BANDS >= 8000], MAX_AIR_BOOST)
    # Below 250 Hz single bands follow the speaker's pitch more than the microphone, so the warmth
    # is set from the octave as a whole.
    low = ~mid
    octave = 10 * np.log10(np.mean(10 ** (rel[low] / 10))) - 10 * np.log10(np.mean(10 ** (want[low] / 10)))
    gain[low] = float(np.clip(-octave, -MAX_CUT, MAX_LOW_BOOST))
    # Bringing up the top mustn't make the /s/ sounds harsh.
    lift = gain[(BANDS >= 4500) & (BANDS <= 8000)].mean() - gain[(BANDS >= 315) & (BANDS <= 3000)].mean()
    excess = float(np.percentile(sibilance, 95)) + lift - MAX_SIBILANCE_DB
    if excess > 0:
        gain[BANDS >= 3150] -= excess
    return gain


EQ_DELAY = 0.03  # the FIR equaliser's latency, in seconds: its output is shifted back by this much


def chain(gains: np.ndarray | None) -> str:
    entries = ";".join(f"entry({f:.0f},{g:.2f})" for f, g in zip(BANDS, gains)) if gains is not None else "entry(1000,0)"
    return ",".join(
        [
            "highpass=f=70:poles=2",
            f"firequalizer=gain_entry='{entries}':delay={EQ_DELAY}:zero_phase=on",
            # Pauses down by up to 12 dB, so the compressors don't bring up what's left of the room.
            "agate=mode=downward:range=0.25:threshold=0.012:ratio=2:attack=5:release=180:knee=4:detection=rms",
            "acompressor=threshold=-30dB:ratio=2.5:attack=25:release=300:knee=8:detection=rms",  # leveller
            "acompressor=threshold=-18dB:ratio=4:attack=3:release=80:knee=4",  # peaks
        ]
    )


_models: dict = {}


def _threads() -> int:
    return max(1, min(16, (os.cpu_count() or 2) // 2))


def denoise(x: np.ndarray) -> np.ndarray:
    """DeepFilterNet3 at full strength. The model loads on first use and stays loaded."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        import df.logger
        import torch
        from df.enhance import enhance, init_df

        if "dfn" not in _models:
            df.logger.get_commit_hash = lambda: None  # it asks git for its own version, which only prints errors here
            torch.set_num_threads(_threads())
            model, state, _ = init_df(log_level="ERROR")  # downloads the model the first time
            _models["dfn"] = (model, state)
        model, state = _models["dfn"]
        y = enhance(model, state, torch.from_numpy(np.ascontiguousarray(x, np.float32))[None])
    return np.asarray(y[0], np.float32)[: len(x)]


def restore(x: np.ndarray) -> np.ndarray:
    """Sidon, the way its authors run it: 16 kHz features in chunks of 96 s, 48 kHz speech out."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        import torch
        import torchaudio
        import transformers
        from huggingface_hub import hf_hub_download

        if "sidon" not in _models:
            torch.set_num_threads(_threads())

            def load(name):  # downloaded the first time (about 1 GB), then cached
                return torch.jit.load(hf_hub_download(SIDON[0], name, revision=SIDON[1]), map_location="cpu").eval()

            features = transformers.SeamlessM4TFeatureExtractor.from_pretrained(W2V_BERT[0], revision=W2V_BERT[1])
            _models["sidon"] = (load("feature_extractor_cpu.pt"), load("decoder_cpu.pt"), features)
        encoder, decoder, features = _models["sidon"]
        peak = float(np.abs(x).max()) or 1.0
        with torch.inference_mode():
            wav = torchaudio.functional.highpass_biquad(torch.from_numpy(0.9 * x / peak)[None], SR, 50)
            wav16 = torch.nn.functional.pad(torchaudio.functional.resample(wav, SR, 16000), (0, 24000)).view(-1)
            out, last = [], None
            for chunk in wav16.split(16000 * 96):
                inputs = features(torch.nn.functional.pad(chunk, (160, 160)), sampling_rate=16000, return_tensors="pt")
                hidden = encoder(inputs["input_features"])["last_hidden_state"]
                if last is not None:  # one frame of context carried over the chunk boundary
                    hidden = torch.cat([last, hidden], dim=1)
                out.append(decoder(hidden.transpose(1, 2)).view(-1)[:-960])
                last = hidden[:, -1:]
            y = torch.cat(out).numpy() * (peak / 0.9)
    lag = int(SIDON_DELAY * SR)
    y = np.asarray(y[lag:], np.float32)
    return np.pad(y, (0, max(0, len(x) - len(y))))[: len(x)]


def _regions(n: int, answer_start: float | None) -> list[tuple[str, int, int]]:
    cut = round((answer_start or 0) * SR)
    if cut < SR // 2 or cut > n - SR // 2:  # no question part worth treating on its own
        return [("answer", 0, n)]
    return [("question", 0, cut), ("answer", cut, n)]


def _join(parts: list[np.ndarray], regions, n: int) -> np.ndarray:
    """Each region's own treatment, crossfaded at the boundary (the end of the question)."""
    if len(parts) == 1:
        return parts[0]
    cut = regions[1][1]
    fade = int(CROSSFADE * SR)
    ramp = np.zeros(n, np.float32)
    ramp[cut:] = 1
    ramp[cut - fade : cut] = np.linspace(0, 1, fade, dtype=np.float32)
    return parts[0] * (1 - ramp) + parts[1] * ramp


def finish(x: np.ndarray, answer_start: float | None, voice: str = "studio") -> tuple[np.ndarray, np.ndarray, dict]:
    """Returns the finished dialogue as stereo, the cleaned-up mono before any dynamics (for
    measuring how loud words were said), and what was done."""
    n = len(x)
    report = {"voice": voice, "regions": []}
    clean = None
    if voice == "studio":
        try:
            clean, report["restoration"] = restore(x), "Sidon"
        except Exception as err:  # noqa: BLE001 - a voice that's only cleaned up beats no finished video
            report["warning"] = f"studio voice unavailable, so it was only cleaned up: {err!r}"
    if clean is None:
        clean, report["restoration"] = denoise(x), "DeepFilterNet3"
    regions = _regions(n, answer_start)
    treated = []
    for name, a, b in regions:
        level = loudness(clean[a:b])
        pre = float(np.clip(PRE_LUFS - level, -24, 24)) if level is not None else 0.0
        gains = match_eq(clean[a:b])
        shift = int(EQ_DELAY * SR)
        out = _ffmpeg(np.pad(clean * np.float32(10 ** (pre / 20)), (0, shift)), chain(gains))
        treated.append(out[shift : shift + n])
        eq = None if gains is None else {f"{f:.0f}": round(float(g), 1) for f, g in zip(BANDS, gains)}
        report["regions"].append({"speaker": name, "start": round(a / SR, 3), "end": round(b / SR, 3), "input_lufs": level, "eq_db": eq})
    y = _join(treated, regions, n)
    # Level each region to the target, then hold the peaks.
    gains = []
    for (name, a, b), info in zip(regions, report["regions"]):
        level = loudness(y[a:b])
        gain = float(np.clip(TARGET_LUFS - DUAL_MONO_LU - level, -20, 20)) if level is not None else 0.0
        gains.append(np.full(n, 10 ** (gain / 20), np.float32))
        info["gain_db"] = round(gain, 2)
    y = y * _join(gains, regions, n)
    limit = 10 ** ((TRUE_PEAK_DB - 0.3) / 20)
    y = _ffmpeg(y, f"aresample={SR * 4},alimiter=limit={limit:.4f}:attack=5:release=60:level=false:latency=true,aresample={SR}")
    for (name, a, b), info in zip(regions, report["regions"]):
        level = loudness(y[a:b])
        info["output_lufs"] = None if level is None else round(level + DUAL_MONO_LU, 1)
    report["true_peak_db"] = round(true_peak(y), 2)
    return np.stack([y, y], axis=1), clean, report
