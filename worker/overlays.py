"""Text overlays: a layer above subtitles, burned as a second ASS track.

ASS over drawtext deliberately — the pipeline already burns subtitles via
libass, ASS handles positioning/outline/box natively, and drawtext's
font-escaping is a known trap. The overlay track is applied AFTER the
subtitle track in the filter chain, so overlays composite on top.

Times are seconds on the clip's OUTPUT timeline — no remap needed (unlike
subtitles, whose words live on the source timeline).

Collision rule: when an overlay overlaps a subtitle event in time AND its
vertical band intersects the subtitle position, that subtitle event is
pushed DOWN below the overlay band (capped inside the bottom safe zone).
Deterministic, per-event, and computed here so preview and burn agree.

Style presets come from the overlay_style_presets table (data, not code).
fs values are design sizes at 1080px output width, scaled by play_w.
"""

from typing import Any

# Safe-zone percentages per ratio (mirrors the web SAFE map): UI chrome at
# the top, captions/CTA chrome at the bottom.
SAFE = {
    "9x16": {"t": 14, "b": 16},
    "4x5": {"t": 5, "b": 9},
    "1x1": {"t": 9, "b": 11},
    "1.91x1": {"t": 8, "b": 8},
}

# Position preset -> centre-line y as a fraction of frame height, after
# the ratio's safe-zone offset is applied.
def position_y(position: str, ratio: str) -> float:
    safe = SAFE.get(ratio, {"t": 8, "b": 8})
    top = safe["t"] / 100
    bottom = 1 - safe["b"] / 100
    if position == "top":
        return min(top + 0.06, 0.30)
    if position == "center":
        return 0.5
    # lower_third sits above the bottom safe zone
    return max(0.70, bottom - 0.08)


def overlay_band(position: str, ratio: str, rel_height: float = 0.10) -> tuple[float, float]:
    """Approximate vertical band [top, bottom] an overlay occupies."""
    y = position_y(position, ratio)
    return (y - rel_height / 2, y + rel_height / 2)


def _ass_colour(hex_colour: str, alpha: float = 1.0) -> str:
    h = hex_colour.lstrip("#")
    r, g, b = h[0:2], h[2:4], h[4:6]
    a = round((1 - max(0.0, min(1.0, alpha))) * 255)
    return f"&H{a:02X}{b}{g}{r}&".upper()


def _escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("{", "(").replace("}", ")")


def _ts(seconds: float) -> str:
    seconds = max(0.0, seconds)
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def build_overlay_ass(
    overlays: list[dict[str, Any]],
    styles: dict[str, dict[str, Any]],
    ratio: str,
    play_w: int,
    play_h: int,
    clip_dur: float,
) -> str:
    """One ASS style + one Dialogue event per overlay. Multi-line text uses
    \\N. Unknown style keys fall back to 'hook' semantics via defaults."""
    style_lines = []
    events = []
    for i, ov in enumerate(overlays):
        cfg = {**_DEFAULT_STYLE, **(styles.get(str(ov.get("style") or "hook")) or {})}
        name = f"Ov{i}"
        fontsize = max(1, round(float(cfg["fs"]) * play_w / 1080))
        pad = round(float(cfg.get("pad", 14)) * play_w / 1080)
        primary = _ass_colour(cfg["color"])
        if cfg.get("box"):
            border_style = 3
            back = _ass_colour(cfg.get("box_color", "#0A0B0D"),
                               float(cfg.get("box_alpha", 0.75)))
            outline_val = pad  # BorderStyle 3: Outline is the box padding
        else:
            border_style = 1
            back = "&H9E000000&"
            outline_val = 2
        weight = int(cfg.get("weight", 700))
        style_lines.append(
            f"Style: {name},{cfg['font']},{fontsize},{primary},{primary},"
            f"{back},{back},{-1 if weight >= 600 else 0},0,0,0,100,100,0,0,"
            f"{border_style},{outline_val},0,5,0,0,0,1"
        )
        start = max(0.0, float(ov["start_s"]))
        end = min(float(ov["end_s"]), clip_dur) if clip_dur else float(ov["end_s"])
        if end <= start:
            continue
        y = round(position_y(str(ov.get("position") or "top"), ratio) * play_h)
        text = _escape(str(ov["text"]))
        if cfg.get("uppercase"):
            text = text.upper()
        text = text.replace("\r\n", "\n").replace("\n", "\\N")
        events.append(
            f"Dialogue: 1,{_ts(start)},{_ts(end)},{name},,0,0,0,,"
            f"{{\\an5\\pos({play_w // 2},{y})}}{text}"
        )

    return "\n".join([
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {play_w}",
        f"PlayResY: {play_h}",
        "WrapStyle: 2",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
        "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding",
        *style_lines,
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
        *events,
        "",
    ])


_DEFAULT_STYLE = {
    "font": "Plus Jakarta Sans", "weight": 700, "fs": 40,
    "color": "#FFFFFF", "box": True, "box_color": "#0A0B0D",
    "box_alpha": 0.7, "pad": 14, "uppercase": False,
}


def subtitle_shift_for(
    t_start: float, t_end: float,
    overlays: list[dict[str, Any]],
    ratio: str,
    sub_vp: float,
) -> float:
    """The vertical position (fraction of height) a subtitle event should
    use, given overlays active during [t_start, t_end). If any active
    overlay's band intersects the subtitle line, the subtitle is pushed
    DOWN below the lowest such band — capped inside the bottom safe zone.
    Returns sub_vp unchanged when nothing collides."""
    safe = SAFE.get(ratio, {"t": 8, "b": 8})
    cap = 1 - safe["b"] / 100 + 0.04     # a little into the zone beats overlap
    sub_band = (sub_vp - 0.05, sub_vp + 0.05)
    lowest_bottom = None
    for ov in overlays:
        if float(ov["end_s"]) <= t_start or float(ov["start_s"]) >= t_end:
            continue
        band = overlay_band(str(ov.get("position") or "top"), ratio)
        if band[0] < sub_band[1] and band[1] > sub_band[0]:
            if lowest_bottom is None or band[1] > lowest_bottom:
                lowest_bottom = band[1]
    if lowest_bottom is None:
        return sub_vp
    return min(lowest_bottom + 0.07, cap)
