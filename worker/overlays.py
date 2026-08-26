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

# Curated OFL set vendored into the image (worker/fonts). Only these
# family names may reach an ASS Fontname — anything else falls back.
FONTS = [
    "Plus Jakarta Sans", "Inter", "Montserrat", "Poppins",
    "Bebas Neue", "Playfair Display", "Space Grotesk",
]


def safe_font(name: object, default: str = "Plus Jakarta Sans") -> str:
    return name if isinstance(name, str) and name in FONTS else default

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
            "font": safe_font(sv.get("font")),
            "fs": float(sv.get("fs", 40)),
            "ol": float(sv.get("ol") or 0),
            "vp": float(sv["vp"]) if sv.get("vp") is not None else None,
            "xp": float(sv.get("xp", 50)),
            "w": float(sv.get("w", 80)),
            "pr": sv.get("pr") or {},
            "wpl": int(sv["wpl"]) if sv.get("wpl") else None,
            "color": str(sv.get("color", "#FFFFFF")),
            "ol_color": str(sv.get("ol_color", "#000000")),
            "bg": str(sv.get("bg", "none")),
            "bg_color": str(sv.get("bg_color", "#0A0B0D")),
            "bg_alpha": float(sv.get("bg_alpha", 0.75)),
            "caps": bool(sv.get("caps")),
            "weight": int(sv.get("weight", 800)),
            "radius": max(0.0, min(40.0, float(sv.get("radius", 8)))),
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
        "ol_color": "#000000",
        "bg": "pill" if cfg.get("box") else "none",
        "bg_color": str(cfg.get("box_color", "#0A0B0D")),
        "bg_alpha": float(cfg.get("box_alpha", 0.75)),
        "caps": bool(cfg.get("uppercase")),
        "weight": int(cfg.get("weight", 700)),
        "radius": max(0.0, min(40.0, float(cfg.get("radius", 8)))),
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
    """Vertical band [top, bottom] an overlay occupies."""
    return (y - rel_height / 2, y + rel_height / 2)


def drawn_box_height_frac(ov: dict[str, Any],
                          styles: dict[str, dict[str, Any]] | None,
                          ratio: str) -> float:
    """Height of the DRAWN background box as a fraction of frame height —
    the collision rule measures the real box, not a fixed band."""
    from .reframe import RATIO_SIZES
    play_w, play_h = RATIO_SIZES.get(ratio, (1080, 1920))
    cfg = resolve_cfg(ov, styles)
    fontsize = max(1, round(cfg["fs"] * play_w / 1080))
    pad = round(float(cfg["pad"]) * play_w / 1080)
    _, _, wfrac = placement(ov, styles, ratio)
    raw = str(ov["text"]).upper() if cfg["caps"] else str(ov["text"])
    try:
        lines, _, line_h = _layout_lines(
            raw, cfg["font"], cfg["weight"], fontsize,
            max(40.0, wfrac * play_w - 2 * pad), cfg["wpl"])
        return (len(lines) * line_h + 2 * pad) / play_h
    except Exception:
        return 0.10


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


# Static instances per family per weight tier — every offered weight is
# a real fc-visible face, so the burn is deterministic (variable-font
# named-instance matching is not reliable through fontconfig).
_FONT_FILES: dict[str, dict[int, str]] = {
    "Plus Jakarta Sans": {300: "PlusJakartaSans-Light.ttf", 400: "PlusJakartaSans-Regular.ttf",
                          500: "PlusJakartaSans-Medium.ttf", 700: "PlusJakartaSans-Bold.ttf",
                          800: "PlusJakartaSans-ExtraBold.ttf"},
    "Inter": {300: "Inter-Light.ttf", 400: "Inter-Regular.ttf", 500: "Inter-Medium.ttf",
              700: "Inter-Bold.ttf", 800: "Inter-ExtraBold.ttf"},
    "Montserrat": {300: "Montserrat-Light.ttf", 400: "Montserrat-Regular.ttf",
                   500: "Montserrat-Medium.ttf", 700: "Montserrat-Bold.ttf",
                   800: "Montserrat-ExtraBold.ttf"},
    "Poppins": {300: "Poppins-Light.ttf", 400: "Poppins-Regular.ttf", 500: "Poppins-Medium.ttf",
                700: "Poppins-Bold.ttf", 800: "Poppins-ExtraBold.ttf"},
    "Bebas Neue": {400: "BebasNeue-Regular.ttf"},
    "Playfair Display": {400: "PlayfairDisplay-Regular.ttf", 500: "PlayfairDisplay-Medium.ttf",
                         700: "PlayfairDisplay-Bold.ttf", 800: "PlayfairDisplay-ExtraBold.ttf"},
    "Space Grotesk": {300: "SpaceGrotesk-Light.ttf", 400: "SpaceGrotesk-Regular.ttf",
                      500: "SpaceGrotesk-Medium.ttf", 700: "SpaceGrotesk-Bold.ttf"},
}

WEIGHT_TIERS = (300, 400, 500, 700, 800)


def weight_tier(weight: int) -> int:
    """Snap an arbitrary weight to the nearest offered tier."""
    return min(WEIGHT_TIERS, key=lambda t: abs(t - int(weight)))


def _weight_file(family: str, weight: int) -> str:
    files = _FONT_FILES.get(family) or _FONT_FILES["Plus Jakarta Sans"]
    tier = weight_tier(weight)
    if tier in files:
        return files[tier]
    return files[min(files, key=lambda t: abs(t - tier))]


def ass_family(family: str, weight: int) -> tuple[str, int]:
    """(Fontname, Bold flag) for one family+weight: Light/Medium select
    their static face by family suffix; >=600 sets the Bold flag (700
    picks Bold, 800 the family's boldest via fontconfig)."""
    tier = weight_tier(weight)
    files = _FONT_FILES.get(family) or {}
    suffix = {300: " Light", 500: " Medium"}.get(tier, "")
    if suffix and tier not in files:
        suffix = ""  # family has no such face (e.g. Playfair Light)
    return family + suffix, (-1 if tier >= 600 else 0)


def _pil_font(family: str, weight: int, fs_px: int):
    """PIL font for measuring the text block the drawing wraps — the
    same static face libass resolves, so measurement matches the burn."""
    from pathlib import Path
    from PIL import ImageFont
    return ImageFont.truetype(
        str(Path(__file__).parent / "fonts" / _weight_file(family, weight)), fs_px)


def _layout_lines(text: str, family: str, weight: int, fs_px: int,
                  max_w_px: float, wpl: int | None) -> tuple[list[str], float, float]:
    r"""Deterministic wrap: within max_w_px, never more than wpl words per
    line, honouring the author's manual breaks. Returns (lines,
    max_line_width_px, line_height_px). The text event uses \q2 with
    explicit \N so libass renders EXACTLY these lines — the drawn box
    cannot drift from the text."""
    font = _pil_font(family, weight, fs_px)
    ascent, descent = font.getmetrics()
    line_h = ascent + descent
    width = lambda s: font.getbbox(s)[2] - font.getbbox(s)[0] if s else 0.0  # noqa: E731
    lines: list[str] = []
    for para in text.replace("\r\n", "\n").split("\n"):
        words = para.split()
        if not words:
            lines.append("")
            continue
        cur: list[str] = []
        for w in words:
            cand = " ".join(cur + [w])
            if cur and (width(cand) > max_w_px or (wpl and len(cur) >= wpl)):
                lines.append(" ".join(cur))
                cur = [w]
            else:
                cur.append(w)
        if cur:
            lines.append(" ".join(cur))
    maxw = max((width(ln) for ln in lines), default=0.0)
    return lines, maxw, float(line_h)


def _rounded_rect_path(w: float, h: float, r: float) -> str:
    r"""ASS \p1 drawing: rounded rectangle from (0,0) to (w,h), corner
    radius r, cubic corners at kappa. Coordinates are integers — script
    pixels are plenty at 1080+."""
    r = max(0.0, min(r, w / 2, h / 2))
    k = r * 0.5523
    i = lambda v: str(int(round(v)))  # noqa: E731
    if r <= 0:
        return f"m 0 0 l {i(w)} 0 {i(w)} {i(h)} 0 {i(h)}"
    return (
        f"m {i(r)} 0 "
        f"l {i(w - r)} 0 "
        f"b {i(w - r + k)} 0 {i(w)} {i(r - k)} {i(w)} {i(r)} "
        f"l {i(w)} {i(h - r)} "
        f"b {i(w)} {i(h - r + k)} {i(w - r + k)} {i(h)} {i(w - r)} {i(h)} "
        f"l {i(r)} {i(h)} "
        f"b {i(r - k)} {i(h)} 0 {i(h - r + k)} 0 {i(h - r)} "
        f"l 0 {i(r)} "
        f"b 0 {i(r - k)} {i(r - k)} 0 {i(r)} 0"
    )


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
    """Per overlay: a background-less text event, and — when the target
    has a background — a rounded-rect \\p1 drawing event beneath it
    (BorderStyle 3 has no corner radius and seams between lines). The
    drawing is sized from the SAME deterministic line layout the text
    event renders (\\q2 + explicit \\N), so box and text cannot drift."""
    style_lines = []
    events = []
    for i, ov in enumerate(overlays):
        cfg = resolve_cfg(ov, styles)
        name = f"Ov{i}"
        fontsize = max(1, round(cfg["fs"] * play_w / 1080))
        pad = round(float(cfg["pad"]) * play_w / 1080)
        primary = _ass_colour(cfg["color"])
        has_bg = cfg["bg"] in ("pill", "box")
        if has_bg:
            outline_col = _ass_colour(cfg["ol_color"])
            outline_val = 0
        else:
            outline_col = _ass_colour(cfg["ol_color"])
            outline_val = max(0, round(cfg["ol"] * play_w / 1080)) or 2
        fam, bold = ass_family(cfg["font"], cfg["weight"])
        style_lines.append(
            f"Style: {name},{fam},{fontsize},{primary},{primary},"
            f"{outline_col},&H9E000000&,{bold},0,0,0,100,100,0,0,"
            f"1,{outline_val},0,5,0,0,0,1"
        )
        start = max(0.0, float(ov["start_s"]))
        end = min(float(ov["end_s"]), clip_dur) if clip_dur else float(ov["end_s"])
        if end <= start:
            continue
        xp, vp, wfrac = placement(ov, styles, ratio)
        x = round(xp * play_w)
        y = round(vp * play_h)
        raw = str(ov["text"]).upper() if cfg["caps"] else str(ov["text"])
        max_w = max(40.0, wfrac * play_w - 2 * pad)
        lines, block_w, line_h = _layout_lines(
            raw, cfg["font"], cfg["weight"], fontsize, max_w, cfg["wpl"])
        text = _escape("\n".join(lines)).replace("\n", "\\N")
        if has_bg:
            box_w = block_w + 2 * pad
            box_h = len(lines) * line_h + 2 * pad
            r = cfg["radius"] * play_w / 1080
            back = _ass_colour(cfg["bg_color"], cfg["bg_alpha"])
            a = round((1 - max(0.0, min(1.0, cfg["bg_alpha"]))) * 255)
            events.append(
                f"Dialogue: 1,{_ts(start)},{_ts(end)},{name},,0,0,0,,"
                f"{{\\an5\\pos({x},{y})\\bord0\\shad0"
                f"\\1c{back[2:-1] and back or back}\\1a&H{a:02X}&\\p1}}"
                f"{_rounded_rect_path(box_w, box_h, r)}{{\\p0}}"
            )
        events.append(
            f"Dialogue: 2,{_ts(start)},{_ts(end)},{name},,0,0,0,,"
            f"{{\\an5\\q2\\pos({x},{y})}}{text}"
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
        ov_cfg = resolve_cfg(ov, styles)
        # 0% opacity keeps the box geometry but is visually background-less
        # — it must not push subtitles; any opacity above 0 does.
        if ov_cfg["bg"] == "none" or ov_cfg["bg_alpha"] <= 0:
            continue
        xp, vp, w = placement(ov, styles, ratio)
        band = overlay_band(vp, drawn_box_height_frac(ov, styles, ratio))
        xspan = (xp - w / 2, xp + w / 2)
        if (band[0] < sub_band[1] and band[1] > sub_band[0]
                and xspan[0] < sub_x[1] and xspan[1] > sub_x[0]):
            if lowest_bottom is None or band[1] > lowest_bottom:
                lowest_bottom = band[1]
    if lowest_bottom is None:
        return sub_vp
    return min(lowest_bottom + 0.07, cap)
