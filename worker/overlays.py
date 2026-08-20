"""Text overlays: a layer above subtitles, burned as a second ASS track.

ASS over drawtext deliberately — the pipeline already burns subtitles via
libass, ASS handles positioning/outline/box natively, and drawtext's
font-escaping is a known trap. The overlay track is applied AFTER the
subtitle track in the filter chain, so overlays composite on top.

Times are seconds on the clip's OUTPUT timeline — no remap needed (unlike
subtitles, whose words live on the source timeline).

Since 0017 every overlay stores RESOLVED style values (sv jsonb: fs, ol,
vp, wpl, colour, background, caps, weight) — the preset tables only seed
those values, so retuning a preset never restyles burned work. Rows that
predate the migration fall back to their preset reference.

Collision rule: an overlay pushes an overlapping subtitle event down ONLY
when it has a background (pill/box) — background-less text over text is a
design choice, not a collision. Computed here so preview and burn agree.
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

_DEFAULT_STYLE = {
    "font": "Plus Jakarta Sans", "weight": 700, "fs": 40,
    "color": "#FFFFFF", "box": True, "box_color": "#0A0B0D",
    "box_alpha": 0.7, "pad": 14, "uppercase": False,
}


# Legacy position preset -> centre-line y as a fraction of frame height,
# after the ratio's safe-zone offset is applied. Only used for rows that
# predate sv (0017).
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


def resolve_cfg(ov: dict[str, Any],
                styles: dict[str, dict[str, Any]] | None) -> dict[str, Any]:
    """Effective style for one overlay: its stored resolved values (sv),
    or the legacy preset mapped into the same shape."""
    sv = ov.get("sv")
    if sv:
        return {
            "font": "Plus Jakarta Sans",
            "fs": float(sv.get("fs", 40)),
            "ol": float(sv.get("ol") or 0),
            "vp": float(sv["vp"]) if sv.get("vp") is not None else None,
            "xp": float(sv.get("xp", 50)),
            "w": float(sv.get("w", 80)),
            "pr": sv.get("pr") or {},
            "wpl": int(sv["wpl"]) if sv.get("wpl") else None,
            "color": str(sv.get("color", "#FFFFFF")),
            "bg": str(sv.get("bg", "none")),
            "bg_color": str(sv.get("bg_color", "#0A0B0D")),
            "bg_alpha": float(sv.get("bg_alpha", 0.75)),
            "caps": bool(sv.get("caps")),
            "weight": int(sv.get("weight", 800)),
            "pad": 14,
        }
    cfg = {**_DEFAULT_STYLE, **((styles or {}).get(str(ov.get("style") or "hook")) or {})}
    return {
        "font": cfg.get("font", "Plus Jakarta Sans"),
        "fs": float(cfg["fs"]),
        "ol": 0.0,
        "vp": None,  # legacy rows position via the position enum + ratio
        "wpl": None,
        "xp": 50.0,
        "w": 80.0,
        "pr": {},
        "color": str(cfg["color"]),
        "bg": "pill" if cfg.get("box") else "none",
        "bg_color": str(cfg.get("box_color", "#0A0B0D")),
        "bg_alpha": float(cfg.get("box_alpha", 0.75)),
        "caps": bool(cfg.get("uppercase")),
        "weight": int(cfg.get("weight", 700)),
        "pad": float(cfg.get("pad", 14)),
    }


def placement(ov: dict[str, Any],
              styles: dict[str, dict[str, Any]] | None,
              ratio: str) -> tuple[float, float, float]:
    """(x, y, width) as fractions of the frame for one ratio. Stored
    per ratio like crops — an overlay placed top-left in 9:16 shouldn't
    land on a face in 1:1. Ratios without their own placement default
    from the 9:16 base values."""
    cfg = resolve_cfg(ov, styles)
    over = (cfg.get("pr") or {}).get(ratio) or {}
    if cfg["vp"] is not None:
        xp = float(over.get("xp", cfg["xp"])) / 100
        vp = float(over.get("vp", cfg["vp"])) / 100
        w = float(over.get("w", cfg["w"])) / 100
    else:
        xp, w = 0.5, 0.8
        vp = position_y(str(ov.get("position") or "top"), ratio)
    return (
        max(0.0, min(1.0, xp)),
        max(0.0, min(1.0, vp)),
        max(0.05, min(1.0, w)),
    )


def overlay_vp(ov: dict[str, Any],
               styles: dict[str, dict[str, Any]] | None,
               ratio: str) -> float:
    """Centre-line y as a fraction of frame height."""
    return placement(ov, styles, ratio)[1]


def overlay_band(y: float, rel_height: float = 0.10) -> tuple[float, float]:
    """Approximate vertical band [top, bottom] an overlay occupies."""
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


def _wrap(text: str, wpl: int | None) -> str:
    """words-per-line rewrap; None keeps the author's manual line breaks."""
    if not wpl:
        return text.replace("\r\n", "\n")
    words = text.replace("\r\n", "\n").replace("\n", " ").split()
    return "\n".join(
        " ".join(words[i:i + wpl]) for i in range(0, len(words), wpl))


def build_overlay_ass(
    overlays: list[dict[str, Any]],
    styles: dict[str, dict[str, Any]],
    ratio: str,
    play_w: int,
    play_h: int,
    clip_dur: float,
) -> str:
    """One ASS style + one Dialogue event per overlay, from each overlay's
    resolved values. Multi-line text uses \\N. Pill and box both burn as
    BorderStyle 3 (libass has no rounded corners); pill differs only in
    the preview chrome."""
    style_lines = []
    events = []
    for i, ov in enumerate(overlays):
        cfg = resolve_cfg(ov, styles)
        name = f"Ov{i}"
        fontsize = max(1, round(cfg["fs"] * play_w / 1080))
        pad = round(float(cfg["pad"]) * play_w / 1080)
        primary = _ass_colour(cfg["color"])
        if cfg["bg"] in ("pill", "box"):
            border_style = 3
            back = _ass_colour(cfg["bg_color"], cfg["bg_alpha"])
            outline_val = pad  # BorderStyle 3: Outline is the box padding
        else:
            border_style = 1
            back = "&H9E000000&"
            outline_val = max(0, round(cfg["ol"] * play_w / 1080)) or 2
        style_lines.append(
            f"Style: {name},{cfg['font']},{fontsize},{primary},{primary},"
            f"{back},{back},{-1 if cfg['weight'] >= 600 else 0},0,0,0,100,100,0,0,"
            f"{border_style},{outline_val},0,5,0,0,0,1"
        )
        start = max(0.0, float(ov["start_s"]))
        end = min(float(ov["end_s"]), clip_dur) if clip_dur else float(ov["end_s"])
        if end <= start:
            continue
        xp, vp, wfrac = placement(ov, styles, ratio)
        x = round(xp * play_w)
        y = round(vp * play_h)
        # Wrap width: libass wraps inside PlayResX minus the margins, so
        # the box width becomes symmetric margins; \q0 turns smart
        # wrapping on for the event (the script default stays manual).
        margin = max(0, round((1 - wfrac) * play_w / 2))
        text = _escape(_wrap(str(ov["text"]), cfg["wpl"]))
        if cfg["caps"]:
            text = text.upper()
        text = text.replace("\n", "\\N")
        events.append(
            f"Dialogue: 1,{_ts(start)},{_ts(end)},{name},,{margin},{margin},0,,"
            f"{{\\an5\\q0\\pos({x},{y})}}{text}"
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


def subtitle_shift_for(
    t_start: float, t_end: float,
    overlays: list[dict[str, Any]],
    ratio: str,
    sub_vp: float,
    styles: dict[str, dict[str, Any]] | None = None,
) -> float:
    """The vertical position (fraction of height) a subtitle event should
    use, given overlays active during [t_start, t_end). Only overlays WITH
    a background collide: if such an overlay's band intersects the subtitle
    line, the subtitle is pushed DOWN below the lowest such band — capped
    inside the bottom safe zone. Background-less overlays never push
    (text over text is a design choice). Returns sub_vp unchanged when
    nothing collides."""
    safe = SAFE.get(ratio, {"t": 8, "b": 8})
    cap = 1 - safe["b"] / 100 + 0.04     # a little into the zone beats overlap
    sub_band = (sub_vp - 0.05, sub_vp + 0.05)
    sub_x = (0.08, 0.92)                 # subtitles wrap near full width
    lowest_bottom = None
    for ov in overlays:
        if float(ov["end_s"]) <= t_start or float(ov["start_s"]) >= t_end:
            continue
        if resolve_cfg(ov, styles)["bg"] == "none":
            continue
        xp, vp, w = placement(ov, styles, ratio)
        band = overlay_band(vp)
        xspan = (xp - w / 2, xp + w / 2)
        if (band[0] < sub_band[1] and band[1] > sub_band[0]
                and xspan[0] < sub_x[1] and xspan[1] > sub_x[0]):
            if lowest_bottom is None or band[1] > lowest_bottom:
                lowest_bottom = band[1]
    if lowest_bottom is None:
        return sub_vp
    return min(lowest_bottom + 0.07, cap)
