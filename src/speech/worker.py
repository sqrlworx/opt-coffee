#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = [
#     "faster-whisper>=1.1",
#     "kokoro>=0.9.4",
#     "transformers>=4.40",  # without this floor uv backtracks to a release that needs Rust to build
#     "torch",
#     "numpy",
#     "en-core-web-sm",
# ]
#
# [tool.uv.sources]
# torch = { index = "pytorch-cpu" }
# en-core-web-sm = { url = "https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl" }
#
# [[tool.uv.index]]
# name = "pytorch-cpu"
# url = "https://download.pytorch.org/whl/cpu"
# explicit = true
# ///
"""Speech worker for the forum server: transcribes recordings and reads text aloud.

The server (src/speech/index.js) runs this as a long-lived process and talks to it over
stdin/stdout, one JSON object per line:

    {"id": 1, "op": "transcribe", "file": "media/a.weba"}
        -> {"id": 1, "ok": true, "text": "...", "words": [[start, end, " word"], ...]}
    {"id": 2, "op": "speak", "text": "...", "out": "media/b.m4a"}
        -> {"id": 2, "ok": true, "duration": 3.2, "mouth": {"fps": 30, "frames": [[open, width, energy], ...]}}
    {"id": 3, "op": "lipsync", "file": "media/a.weba", "words": [[start, end, " word"], ...] or null}
        -> {"id": 3, "ok": true, "mouth": {...}}
    {"id": 4, "op": "load", "models": ["whisper", "kokoro"]}
        -> {"id": 4, "ok": true}
    any failure -> {"id": n, "ok": false, "error": "..."}

Speech-to-text is faster-whisper; text-to-speech is Kokoro-82M. `mouth` is the speech's lip
sync (see lipsync.py). Models load on first use and stay loaded. Requests are handled one at a
time. Logs go to stderr.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import warnings

SAMPLE_RATE = 24000  # Kokoro's output rate
WHISPER_RATE = 16000


class Engines:
    def __init__(self, whisper_model: str, voice: str):
        self.whisper_model = whisper_model
        self.voice = voice
        self._whisper = None
        self._kokoro = None

    def whisper(self):
        if self._whisper is None:
            from faster_whisper import WhisperModel

            log(f"loading whisper {self.whisper_model}")
            self._whisper = WhisperModel(
                self.whisper_model, device="cpu", compute_type="int8"
            )
        return self._whisper

    def kokoro(self):
        if self._kokoro is None:
            os.environ.setdefault("HF_HUB_VERBOSITY", "error")
            from kokoro import KPipeline
            from loguru import logger

            logger.disable("kokoro")
            log(f"loading kokoro ({self.voice})")
            self._kokoro = KPipeline(
                lang_code=self.voice[0], repo_id="hexgrad/Kokoro-82M"
            )
        return self._kokoro

    def transcribe(self, file: str) -> dict:
        segments, _ = self.whisper().transcribe(
            decode(file), beam_size=5, word_timestamps=True, vad_filter=True
        )
        text, words = [], []
        for seg in segments:
            text.append(seg.text)
            words += [
                [round(w.start, 3), round(w.end, 3), w.word] for w in seg.words or []
            ]
        return {"text": "".join(text).strip(), "words": words}

    def lip_sync(self, file: str, words: list | None) -> dict:
        """A recording's lip sync, from its words as transcribed (transcribed again if not given)."""
        import lipsync

        if not words:
            words = self.transcribe(file)["words"]
        g2p = self.kokoro().g2p
        phones = lipsync.word_phones(
            [(start, end, g2p(w.strip())[0]) for start, end, w in words if w.strip()]
        )
        return {"mouth": lipsync.track(phones, decode(file), WHISPER_RATE)}

    def speak(self, text: str, out: str) -> dict:
        import lipsync
        import numpy as np

        pipeline = self.kokoro()
        chunks, phones, offset = [], [], 0.0
        for r in pipeline(text, voice=self.voice):
            if r.audio is None:
                continue
            phones += lipsync.kokoro_phones(
                r.phonemes, r.pred_dur.tolist(), pipeline.model.vocab, offset
            )
            chunks.append(r.audio.numpy())
            offset += len(chunks[-1]) / SAMPLE_RATE
        if not chunks:
            raise ValueError("the text produced no speech")
        audio = np.concatenate(chunks).astype(np.float32)
        # Write next to the target and rename, so a crash never leaves a truncated file at `out`.
        part = f"{out}.part"
        cmd = [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-f", "f32le", "-ar", str(SAMPLE_RATE), "-ac", "1", "-i", "-",
            "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", "-f", "mp4", part,
        ]  # fmt: skip
        result = subprocess.run(
            cmd, input=audio.tobytes(), capture_output=True, check=False
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"ffmpeg failed: {result.stderr.decode(errors='replace').strip()}"
            )
        os.replace(part, out)
        return {
            "duration": round(len(audio) / SAMPLE_RATE, 2),
            "mouth": lipsync.track(phones, audio, SAMPLE_RATE),
        }


def decode(file: str):
    """A recording as 16 kHz mono samples, as Whisper wants it.

    Decoded with ffmpeg rather than faster-whisper's PyAV path, which breaks across PyAV releases.
    """
    import numpy as np

    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", file,
        "-vn", "-f", "f32le", "-ac", "1", "-ar", str(WHISPER_RATE), "-",
    ]  # fmt: skip
    result = subprocess.run(cmd, capture_output=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(
            f"couldn't decode the recording: {result.stderr.decode(errors='replace').strip()}"
        )
    return np.frombuffer(result.stdout, np.float32)


def log(msg: str):
    print(f"[speech worker] {msg}", file=sys.stderr, flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--whisper-model", default="small.en")
    parser.add_argument("--voice", default="af_heart", help="Kokoro voice")
    args = parser.parse_args()
    warnings.filterwarnings("ignore")
    # Replies go to the real stdout. Anything a library prints, even from C, goes to stderr.
    replies = os.fdopen(os.dup(1), "w")
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    engines = Engines(args.whisper_model, args.voice)

    for line in sys.stdin:
        if not line.strip():
            continue
        req = {}
        try:
            req = json.loads(line)
            op = req.get("op")
            if op == "transcribe":
                reply = engines.transcribe(req["file"])
            elif op == "speak":
                reply = engines.speak(req["text"], req["out"])
            elif op == "lipsync":
                reply = engines.lip_sync(req["file"], req.get("words"))
            elif op == "load":
                for name in req.get("models", []):
                    getattr(engines, name)()
                reply = {}
            else:
                raise ValueError(f"unknown op {op!r}")
            reply = {"id": req.get("id"), "ok": True, **reply}
        except Exception as err:  # noqa: BLE001 -- report every failure to the server instead of dying
            log(f"{req.get('op')} failed: {err!r}")
            reply = {
                "id": req.get("id"),
                "ok": False,
                "error": str(err) or type(err).__name__,
            }
        print(json.dumps(reply), file=replies, flush=True)


if __name__ == "__main__":
    main()
