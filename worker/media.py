"""ffprobe/ffmpeg wrappers."""

import json
import subprocess
from fractions import Fraction
from typing import Any


class MediaError(Exception):
    pass


def probe(path: str) -> dict[str, Any]:
    """Returns duration_s, width, height, fps, has_audio for the videos row."""
    proc = subprocess.run(
        [
            "ffprobe", "-v", "error", "-print_format", "json",
            "-show_format", "-show_streams", path,
        ],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise MediaError(f"ffprobe failed: {proc.stderr.strip()[:500]}")
    data = json.loads(proc.stdout)

    video = next((s for s in data["streams"] if s["codec_type"] == "video"), None)
    audio = next((s for s in data["streams"] if s["codec_type"] == "audio"), None)

    fps = None
    if video and video.get("avg_frame_rate") not in (None, "0/0"):
        try:
            fps = round(float(Fraction(video["avg_frame_rate"])), 3)
        except (ValueError, ZeroDivisionError):
            pass

    duration = data.get("format", {}).get("duration")
    return {
        "duration_s": round(float(duration), 3) if duration else None,
        "width": video.get("width") if video else None,
        "height": video.get("height") if video else None,
        "fps": fps,
        "has_audio": audio is not None,
    }


def extract_wav(src_path: str, dest_path: str) -> None:
    """16kHz mono WAV — what WhisperX wants (see CLAUDE.md known traps)."""
    proc = subprocess.run(
        [
            "ffmpeg", "-y", "-v", "error", "-i", src_path,
            "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
            dest_path,
        ],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise MediaError(f"ffmpeg audio extraction failed: {proc.stderr.strip()[:500]}")
