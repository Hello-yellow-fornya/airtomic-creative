"""Parse the structured metadata out of Klira's ad and video names.

Ad names follow (roughly) {UF|LF|Retargeting}_{theme or talent}_{hook}_
{Video|Static}_{date}: free labels carrying funnel stage, talent, hook
variant and launch date — structure we'd otherwise burn a vision call
inferring. Older eras use other conventions, so the parser is
conservative: it only emits a field when the token actually matches, and
callers always keep the raw name alongside.

Video asset names carry the rendition: "ANDY_AD2_1-1_H1.mp4" and
"ANDY_AD2_9-16_H1.mp4" are the SAME creative cut for different placements.
parse_video_name() splits the ratio token out and returns the concept stem
so renditions can be grouped at the rollup layer.
"""

import re

FUNNEL_STAGES = {
    "uf": "UF", "lf": "LF", "mof": "MOF", "bof": "BOF",
    "retargeting": "Retargeting", "prospecting": "Prospecting",
}

# \b won't do here: the convention's separator is "_", which regex counts
# as a word character, so \b never fires at "_H1" or "_19/08/2026".
_B = r"(?<![A-Za-z0-9])"
_E = r"(?![A-Za-z0-9])"
_DATE = re.compile(rf"{_B}(\d{{1,2}})/(\d{{1,2}})/(\d{{4}}){_E}")
_HOOK = re.compile(rf"{_B}H(\d+){_E}", re.IGNORECASE)
_FORMAT = re.compile(r"^(video|static)$", re.IGNORECASE)

# rendition tokens as they appear in video filenames: 1-1, 9-16, 4-5,
# 16-9, 1x1, 9x16 …
_RATIO = re.compile(rf"{_B}(\d{{1,2}})\s*[-x:]\s*(\d{{1,2}}){_E}")


def _iso_date(m: re.Match) -> str | None:
    d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if not (1 <= d <= 31 and 1 <= mo <= 12):
        return None
    return f"{y:04d}-{mo:02d}-{d:02d}"


def parse_ad_name(name: str | None) -> dict:
    """Extract {funnel_stage, theme, hook, format, date_start, date_end}
    from an ad name. Missing/unmatched fields are simply absent — never
    guessed. The raw name is not included; callers store it separately."""
    out: dict = {}
    if not name:
        return out
    parts = [p.strip() for p in name.split("_") if p.strip()]
    if not parts:
        return out

    if parts[0].lower() in FUNNEL_STAGES:
        out["funnel_stage"] = FUNNEL_STAGES[parts[0].lower()]
        if len(parts) > 1:
            out["theme"] = parts[1]

    for p in parts:
        if _FORMAT.match(p):
            out["format"] = p.capitalize()
            break

    hook = _HOOK.search(name)
    if hook:
        out["hook"] = f"H{hook.group(1)}"
        # the hook token often carries its text: "H1: Why use…"
        m = re.search(rf"{_B}H{hook.group(1)}\s*:\s*([^_]+)", name)
        if m:
            out["hook_text"] = m.group(1).strip()

    dates = [d for d in (_iso_date(m) for m in _DATE.finditer(name)) if d]
    if dates:
        out["date_start"] = dates[0]
        if len(dates) > 1:
            out["date_end"] = dates[-1]
    return out


def parse_video_name(video_name: str | None) -> dict:
    """Split the rendition ratio out of an asset filename and return the
    concept stem: renditions of one creative share a stem, so the rollup
    can group them without a second Meta call."""
    out: dict = {}
    if not video_name:
        return out
    base = re.sub(r"\.[A-Za-z0-9]{2,4}$", "", video_name).strip()
    m = _RATIO.search(base)
    if m:
        out["rendition"] = f"{int(m.group(1))}x{int(m.group(2))}"
        stem = (base[:m.start()] + base[m.end():])
    else:
        stem = base
    stem = re.sub(r"[\s_\-]+", " ", stem).strip().lower()
    if stem:
        out["concept_stem"] = stem
    return out
