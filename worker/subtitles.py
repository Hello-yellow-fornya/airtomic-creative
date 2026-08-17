"""Subtitle generation: remap source-timeline words to the output timeline,
then emit an ASS file with karaoke-style active-word highlighting.

THE critical constraint (see CLAUDE.md #1): the ASS file is generated AFTER
the scene order resolves. Word timestamps live on the SOURCE timeline; once a
scene is reordered or lifted they no longer describe the output. output_words()
is a direct port of outputWords() in docs/prototype.html — the reference
implementation. Card scenes advance the output clock but carry no words.
"""

from typing import Any


def scene_duration(scene: dict[str, Any]) -> float:
    if scene["layout"] == "card":
        return float(scene["duration_s"])
    return float(scene["source_out_s"]) - float(scene["source_in_s"])


def output_words(
    scenes: list[dict[str, Any]], words: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """scenes: ordered variant scenes. words: source-timeline dicts with
    word/start/end in absolute source seconds. Returns words on the OUTPUT
    timeline, in output order."""
    out = []
    acc = 0.0
    for scene in scenes:
        d = scene_duration(scene)
        if scene["layout"] != "card":
            s_in = float(scene["source_in_s"])
            s_out = float(scene["source_out_s"])
            for w in words:
                if w["end"] > s_in and w["start"] < s_out:
                    out.append({
                        "word": w["word"],
                        "start": acc + max(0.0, w["start"] - s_in),
                        "end": acc + min(d, w["end"] - s_in),
                    })
        acc += d
    return out


DEFAULT_PRESET = {
    "font": "Inter", "fs": 30, "ol": 3, "vp": 72,
    "wpl": 4, "hl": "#FFC629", "caps": False, "box": False,
}


def build_ass(
    out_words: list[dict[str, Any]],
    preset: dict[str, Any],
    play_w: int,
    play_h: int,
) -> str:
    """One Dialogue event per word: the word's line is shown with the active
    word in the highlight colour. Event ends at the next word's start so the
    line holds through inter-word gaps instead of flickering."""
    cfg = {**DEFAULT_PRESET, **(preset or {})}
    wpl = max(1, int(cfg["wpl"]))
    # Prototype fs values are calibrated to a ~540px-wide preview at fs*0.5;
    # scale by output width so lines fill comparably at every ratio.
    fontsize = max(1, round(float(cfg["fs"]) * 2.2 * play_w / 1080))
    outline = round(float(cfg["ol"]) * play_w / 1080)
    hl = _ass_colour(cfg["hl"])
    x = play_w // 2
    y = round(play_h * float(cfg["vp"]) / 100)

    if cfg.get("box"):
        border_style, outline_val = 3, max(outline, 2)  # 3 = opaque box
    else:
        border_style, outline_val = 1, outline          # 1 = outline + shadow

    # output_words() appends per scene in word-list order, so a word that
    # spans a scene boundary can arrive out of sequence — sort by output
    # start before grouping into lines.
    out_words = sorted(out_words, key=lambda w: (w["start"], w["end"]))
    lines_of_words = [out_words[i:i + wpl] for i in range(0, len(out_words), wpl)]

    events = []
    for line in lines_of_words:
        for i, w in enumerate(line):
            start = w["start"]
            end = line[i + 1]["start"] if i + 1 < len(line) else w["end"]
            if end <= start:
                end = start + 0.05
            parts = []
            for j, other in enumerate(line):
                text = _ass_escape(other["word"])
                if cfg.get("caps"):
                    text = text.upper()
                if j == i:
                    parts.append(f"{{\\1c{hl}}}{text}{{\\1c&H00FFFFFF&}}")
                else:
                    parts.append(text)
            events.append(
                f"Dialogue: 0,{_ts(start)},{_ts(end)},Caption,,0,0,0,,"
                f"{{\\an5\\pos({x},{y})}}{' '.join(parts)}"
            )

    style = (
        f"Style: Caption,{cfg['font']},{fontsize},&H00FFFFFF,&H00FFFFFF,"
        f"&H00000000,&H9E000000,-1,0,0,0,100,100,0,0,"
        f"{border_style},{outline_val},0,5,0,0,0,1"
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
        style,
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
        *events,
        "",
    ])


def _ts(seconds: float) -> str:
    seconds = max(0.0, seconds)
    h = int(seconds // 3600)
    m = int(seconds % 3600 // 60)
    s = seconds % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def _ass_colour(hex_colour: str) -> str:
    """#RRGGBB -> ASS &HAABBGGRR& (alpha 00 = opaque)."""
    hex_colour = hex_colour.lstrip("#")
    r, g, b = hex_colour[0:2], hex_colour[2:4], hex_colour[4:6]
    return f"&H00{b}{g}{r}&".upper()


def _ass_escape(text: str) -> str:
    return text.replace("\\", "").replace("{", "(").replace("}", ")")
