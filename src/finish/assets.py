"""Models and fonts the finisher downloads on first use, checked and cached.

The cache is ~/.cache/forum-finish (FORUM_FINISH_CACHE overrides it). DeepFilterNet3 downloads
its own model into ~/.cache/DeepFilterNet the first time it runs.
"""

from __future__ import annotations

import hashlib
import os
import sys
import urllib.request
from pathlib import Path

CACHE = Path(os.environ.get("FORUM_FINISH_CACHE") or Path.home() / ".cache" / "forum-finish")

MODELS = {
    # Robust Video Matting, MobileNetV3: cuts the person out of each frame (Apache-2.0).
    "rvm_mobilenetv3_fp32.onnx": (
        "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx",
        "88d4531297118f595bf2fd60f6f566aec2e559393802d1f436c380f0cbbd2828",
    ),
    # YuNet face detector, from the OpenCV model zoo (MIT).
    "face_detection_yunet_2023mar.onnx": (
        "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
        "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
    ),
}

# Montserrat (SIL Open Font License) for the captions. libass picks weights by family name, not
# by number, so each weight is its own file.
_FONT_URL = "https://github.com/JulietaUla/Montserrat/raw/v7.222/fonts/ttf/{}"
FONTS = {
    "Montserrat-SemiBoldItalic.ttf": "01a3765eb4a85edff7513b2b69199bcb68e9a5fba237f3b5531cdc3e1a0a7e73",
    "Montserrat-Bold.ttf": "4e6d93bc38122c371acb8dc0dbefbf2649c235191e1be136bb5720546d719808",
    "Montserrat-BoldItalic.ttf": "9a2f1e3179e3a9254cb09c0cb2f7fccab0ad00863ddcb5cb5abf89c036125dda",
    "Montserrat-Black.ttf": "b404ed39088fcb3f8d2ced8164f7a625dfae2ad43bf4a055b55a84d95038d50d",
    "Montserrat-BlackItalic.ttf": "f8d7786409215d1bc854622cd5484210a2d8ea9bbbecb4c6770707dff10bc42a",
}


def _fetch(url: str, sha256: str, dest: Path) -> Path:
    if dest.exists() and _digest(dest) == sha256:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"[finish] downloading {dest.name}", file=sys.stderr)
    part = dest.with_name(dest.name + ".part")
    with urllib.request.urlopen(url, timeout=120) as res, open(part, "wb") as out:
        while chunk := res.read(1 << 20):
            out.write(chunk)
    if _digest(part) != sha256:
        part.unlink()
        raise RuntimeError(f"{dest.name} downloaded from {url} doesn't match its checksum")
    part.replace(dest)
    return dest


def _digest(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def model(name: str) -> Path:
    url, sha256 = MODELS[name]
    return _fetch(url, sha256, CACHE / "models" / name)


def fonts_dir() -> Path:
    """The caption fonts, all in one directory for libass."""
    for name, sha256 in FONTS.items():
        _fetch(_FONT_URL.format(name), sha256, CACHE / "fonts" / name)
    return CACHE / "fonts"
