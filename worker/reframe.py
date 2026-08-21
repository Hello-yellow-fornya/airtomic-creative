"""Reframe: one transform per (variant, ratio) — {x, y, scale} — places the
source as a movable, scalable layer inside the output frame.

Semantics (shared verbatim with web/lib/reframe.ts — change BOTH or neither;
tests/fixtures/reframe.json pins the two ports to identical output):

- scale is relative to FILL: 1.0 means the source is scaled so the frame is
  fully covered ("cover"); the displayed source is scale * fill_scale.
- x, y are the source CENTRE's offset from the frame centre, as fractions of
  the frame's width/height. (0, 0) is centred.
- mode "fit" letterboxes instead (contain), padded with fit_color.

transform_to_window resolves a transform to the normalised source window
(the sub-rectangle of the source that the frame shows) — the single value
both the CSS preview and the ffmpeg filter derive from, so they cannot
drift.
"""

from typing import Any

RATIO_SIZES = {
    "9x16": (1080, 1920),
    "4x5": (1080, 1350),
    "1x1": (1080, 1080),
    "1.91x1": (1200, 628),
}

DEFAULT_TRANSFORM = {"x": 0.0, "y": 0.0, "scale": 1.0,
                     "mode": "cover", "fit_color": "#0A0B0D"}


def transform_to_window(
    t: dict[str, Any], src_w: float, src_h: float,
    frame_w: float, frame_h: float,
) -> dict[str, float]:
    """Normalised source window {x, y, w, h} (fractions of the source) that
    the frame displays. In fit mode the window is the whole source (the
    letterboxing happens at composition, not by cropping)."""
    if t.get("mode") == "fit":
        return {"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0}
    scale = max(0.05, float(t.get("scale", 1.0)))
    fill = max(frame_w / src_w, frame_h / src_h)
    s = scale * fill
    win_w = frame_w / s / src_w
    win_h = frame_h / s / src_h
    cx = 0.5 - float(t.get("x", 0.0)) * frame_w / s / src_w
    cy = 0.5 - float(t.get("y", 0.0)) * frame_h / s / src_h
    return {"x": cx - win_w / 2, "y": cy - win_h / 2, "w": win_w, "h": win_h}


def window_to_transform(
    win: dict[str, float], src_w: float, src_h: float,
    frame_w: float, frame_h: float,
) -> dict[str, float]:
    """Inverse: the transform whose window is `win` (used by migration 0020
    to convert legacy scene_crops). Assumes the window's pixel aspect
    matches the frame (true for every crop the old UI wrote)."""
    fill = max(frame_w / src_w, frame_h / src_h)
    s = frame_w / (win["w"] * src_w)
    cx = win["x"] + win["w"] / 2
    cy = win["y"] + win["h"] / 2
    return {
        "x": (0.5 - cx) * src_w * s / frame_w,
        "y": (0.5 - cy) * src_h * s / frame_h,
        "scale": s / fill,
    }


def clamp_transform(
    t: dict[str, Any], src_w: float, src_h: float,
    frame_w: float, frame_h: float,
) -> dict[str, Any]:
    """Cover mode: the frame must never be uncovered — scale >= 1 and the
    centre offset bounded by the overhang. Fit mode passes through."""
    if t.get("mode") == "fit":
        return t
    scale = max(1.0, float(t.get("scale", 1.0)))
    fill = max(frame_w / src_w, frame_h / src_h)
    s = scale * fill
    over_x = max(0.0, (s * src_w / frame_w - 1) / 2)
    over_y = max(0.0, (s * src_h / frame_h - 1) / 2)
    return {
        **t,
        "scale": scale,
        "x": max(-over_x, min(over_x, float(t.get("x", 0.0)))),
        "y": max(-over_y, min(over_y, float(t.get("y", 0.0)))),
    }


def framed_high(src_w: float, src_h: float,
                frame_w: float, frame_h: float) -> dict[str, Any]:
    """The old default: for ratios that crop HEIGHT (1.91:1 from 16:9) the
    window sits at the top of the source; ratios that crop width stay
    centred. Resolved, not symbolic — same rule as text style."""
    win = transform_to_window(dict(DEFAULT_TRANSFORM), src_w, src_h, frame_w, frame_h)
    if win["h"] >= 0.999:  # full height — nothing to frame high
        return {**DEFAULT_TRANSFORM}
    t = window_to_transform(
        {"x": win["x"], "y": 0.0, "w": win["w"], "h": win["h"]},
        src_w, src_h, frame_w, frame_h)
    return {**DEFAULT_TRANSFORM, **t}
