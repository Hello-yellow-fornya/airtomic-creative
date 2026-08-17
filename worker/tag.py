"""The `tag` job: one Claude vision call per video, never per frame.

Scene keyframes are composited into a single labelled grid image and sent
together with the transcript in one request — this is the single largest cost
lever in the build; sending frames individually costs ~100x for no quality
gain (see CLAUDE.md). Output is constrained by a JSON schema via structured
outputs, so the response is guaranteed-valid JSON with no parse retries.

Tags land in creative_tags as two JSONB layers: universal (format mechanics)
and brand (Klira-specific), with schema_version recorded so a future schema
change re-tags as a new row rather than a destructive update.

cuts_per_10s is computed from the scenes table, not asked of the model —
never ask a model for a number the database already knows.
"""

import base64
import io
import json
import math
from typing import Any

import psycopg

from . import db, pipeline, r2
from .config import Config

TAG_SCHEMA_VERSION = "v1"

GRID_COLS = 6
MAX_GRID_CELLS = 36        # >36 scenes: sample evenly, keeping first and last
CELL_W, CELL_H = 256, 144  # 6 cols x 256 = 1536px wide — under the API's
LABEL_H = 14               # 1568px resize threshold, so no server downscale
TRANSCRIPT_CHAR_CAP = 150_000


class TagError(Exception):
    pass


SYSTEM_PROMPT = """\
You are the creative tagger for Klira (klira.skin), a UK prescription skincare
brand. You describe one video per request so its creative attributes can be
compared against historical ad performance.

You receive:
- A single grid image compositing one keyframe per scene, reading
  left-to-right then top-to-bottom. Each cell is labelled "s<idx> <mm:ss>"
  with the scene index and its start timestamp in the video. For long videos
  the grid is an even sample of scenes; the text notes how many it covers.
- The transcript with [mm:ss] timestamps (may be truncated for very long
  videos).
Some sources are audio-only podcasts: then there is no grid, and visual
fields should be null or their unknown value.

Tag only what you can actually observe in the keyframes and transcript. Use
the cell timestamps to estimate timing fields. When something is not
determinable from the evidence, use null/unknown rather than guessing.

Compliance context: Klira sells prescription-only (POM) skincare. UK rules
prohibit advertising prescription-only medicines to the public and restrict
treatment claims. Set compliance_flag to true whenever the video makes
treatment or medical claims (e.g. "clears acne", "fades melasma", claims
about prescription ingredients treating a condition) and explain briefly in
compliance_notes."""


TAG_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["universal", "klira"],
    "properties": {
        "universal": {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "hook_type", "first_frame_subject", "on_screen_text_0_3s",
                "talent_format", "seconds_to_product_visible", "cta_type",
            ],
            "properties": {
                "hook_type": {
                    "type": "string",
                    "enum": ["question", "bold_claim", "story", "demonstration",
                             "statistic", "problem_callout", "other"],
                    "description": "How the first ~3 seconds try to stop the scroll",
                },
                "first_frame_subject": {
                    "type": ["string", "null"],
                    "description": "What is visually on screen in the first frame (null if audio-only)",
                },
                "on_screen_text_0_3s": {
                    "type": ["string", "null"],
                    "description": "Any overlay text visible in the first 3 seconds, verbatim; null if none or not determinable",
                },
                "talent_format": {
                    "type": "string",
                    "enum": ["ugc", "studio", "talent", "mixed", "unknown"],
                    "description": "ugc = selfie/phone-shot creator style; studio = produced brand shoot; talent = named expert/clinician on camera",
                },
                "seconds_to_product_visible": {
                    "type": ["number", "null"],
                    "description": "Seconds until the product/packaging first appears, estimated from cell timestamps; null if never visible",
                },
                "cta_type": {
                    "type": ["string", "null"],
                    "description": "The call to action if one exists, e.g. 'start consultation', 'shop now', 'learn more'; null if none",
                },
            },
        },
        "klira": {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "skin_concern_named", "ingredient_callout", "before_after_present",
                "texture_shot_present", "claim_category", "compliance_flag",
                "compliance_notes",
            ],
            "properties": {
                "skin_concern_named": {
                    "type": "array", "items": {"type": "string"},
                    "description": "Skin concerns explicitly named (acne, melasma, rosacea, ageing...); empty if none",
                },
                "ingredient_callout": {
                    "type": "array", "items": {"type": "string"},
                    "description": "Ingredients explicitly named (tretinoin, niacinamide...); empty if none",
                },
                "before_after_present": {
                    "type": "boolean",
                    "description": "True if before/after skin comparison imagery appears",
                },
                "texture_shot_present": {
                    "type": "boolean",
                    "description": "True if product texture/swatch/application close-up appears",
                },
                "claim_category": {
                    "type": "string",
                    "enum": ["cosmetic", "treatment", "prevention", "none"],
                    "description": "Strongest category of claim made about the product",
                },
                "compliance_flag": {
                    "type": "boolean",
                    "description": "True if the video makes treatment/medical claims (UK POM advertising risk)",
                },
                "compliance_notes": {
                    "type": ["string", "null"],
                    "description": "Why the compliance flag was raised, quoting the claim; null if not flagged",
                },
            },
        },
    },
}


def handle(conn: psycopg.Connection, cfg: Config, s3, job: dict[str, Any]) -> None:
    video_id = job["payload"].get("video_id")
    if not video_id:
        raise TagError(f"job {job['id']} has no video_id in payload")
    if not cfg.anthropic_api_key:
        raise TagError("ANTHROPIC_API_KEY is not set — cannot run creative tagging")

    video = conn.execute("SELECT * FROM videos WHERE id = %s", (video_id,)).fetchone()
    if video is None:
        raise TagError(f"video {video_id} not found")

    scenes = conn.execute(
        "SELECT idx, start_s, end_s, keyframe_uri FROM scenes "
        "WHERE video_id = %s ORDER BY idx",
        (video_id,),
    ).fetchall()
    if not scenes:
        raise TagError("no scenes for video — scene_detect must run first")

    db.set_video_status(conn, video_id, "tagging", "compositing keyframe grid")

    with_frames = [s for s in scenes if s["keyframe_uri"]]
    sampled = _sample(with_frames, MAX_GRID_CELLS)
    frames = []
    for s in sampled:
        bucket, key = r2.parse_uri(s["keyframe_uri"])
        frames.append((s["idx"], float(s["start_s"]), r2.get_bytes(s3, bucket, key)))
    grid_jpeg = _build_grid(frames) if frames else None

    transcript_text = _transcript_text(conn, video_id)
    duration = float(video["duration_s"] or 0)
    cuts_per_10s = round(len(scenes) / duration * 10, 2) if duration else None

    db.set_video_status(conn, video_id, "tagging", "describing video with claude")
    result = _call_claude(
        cfg, grid_jpeg, transcript_text,
        title=video["title"], source=str(video["source"]), duration_s=duration,
        n_scenes=len(scenes), n_grid=len(frames),
    )

    universal = {**result["universal"], "cuts_per_10s": cuts_per_10s}
    with conn.transaction():
        # Idempotent within a schema version; other versions' rows are kept.
        conn.execute(
            "DELETE FROM creative_tags WHERE video_id = %s AND schema_version = %s",
            (video_id, TAG_SCHEMA_VERSION),
        )
        conn.execute(
            "INSERT INTO creative_tags (video_id, schema_version, universal, brand, model) "
            "VALUES (%s, %s, %s, %s, %s)",
            (video_id, TAG_SCHEMA_VERSION, json.dumps(universal),
             json.dumps(result["klira"]), cfg.anthropic_model),
        )

    pipeline.advance(conn, video_id, "tag")


def _sample(scenes: list, cap: int) -> list:
    if len(scenes) <= cap:
        return scenes
    picked = {round(i * (len(scenes) - 1) / (cap - 1)) for i in range(cap)}
    return [scenes[i] for i in sorted(picked)]


def _build_grid(frames: list[tuple[int, float, bytes]]) -> bytes:
    """Composite keyframes into one labelled grid JPEG (PIL only)."""
    from PIL import Image, ImageDraw

    rows = math.ceil(len(frames) / GRID_COLS)
    grid = Image.new("RGB", (GRID_COLS * CELL_W, rows * (CELL_H + LABEL_H)), "black")
    draw = ImageDraw.Draw(grid)

    for i, (scene_idx, start_s, data) in enumerate(frames):
        img = Image.open(io.BytesIO(data)).convert("RGB")
        img.thumbnail((CELL_W, CELL_H))
        x = (i % GRID_COLS) * CELL_W
        y = (i // GRID_COLS) * (CELL_H + LABEL_H)
        grid.paste(img, (x + (CELL_W - img.width) // 2, y + (CELL_H - img.height) // 2))
        mm, ss = divmod(int(start_s), 60)
        draw.text((x + 3, y + CELL_H + 1), f"s{scene_idx} {mm:02d}:{ss:02d}", fill="white")

    buf = io.BytesIO()
    grid.save(buf, "JPEG", quality=80)
    return buf.getvalue()


def _transcript_text(conn: psycopg.Connection, video_id: str) -> str:
    rows = conn.execute(
        """
        SELECT s.start_s, s.text FROM transcript_segments s
        JOIN transcripts t ON t.id = s.transcript_id
        WHERE t.video_id = %s ORDER BY s.idx
        """,
        (video_id,),
    ).fetchall()
    lines = []
    total = 0
    for row in rows:
        mm, ss = divmod(int(row["start_s"]), 60)
        line = f"[{mm:02d}:{ss:02d}] {row['text']}"
        total += len(line) + 1
        if total > TRANSCRIPT_CHAR_CAP:
            lines.append("[... transcript truncated ...]")
            break
        lines.append(line)
    return "\n".join(lines) or "(no transcript)"


def _call_claude(
    cfg: Config,
    grid_jpeg: bytes | None,
    transcript_text: str,
    *,
    title: str | None,
    source: str,
    duration_s: float,
    n_scenes: int,
    n_grid: int,
) -> dict[str, Any]:
    import anthropic

    client = anthropic.Anthropic(api_key=cfg.anthropic_api_key)

    header = (
        f"Video: {title or 'untitled'} (source type: {source}, "
        f"duration {duration_s:.0f}s, {n_scenes} detected scenes"
        + (f", grid shows {n_grid} of them)" if grid_jpeg else ", audio-only — no grid)")
    )
    content: list[dict[str, Any]] = []
    if grid_jpeg is not None:
        content.append({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/jpeg",
                "data": base64.standard_b64encode(grid_jpeg).decode(),
            },
        })
    content.append({
        "type": "text",
        "text": f"{header}\n\nTranscript:\n{transcript_text}\n\nTag this video.",
    })

    # Opus-5-class models run safety classifiers that can decline a request;
    # the server-side fallback re-runs a declined request on the recommended
    # substitute model instead of failing the job.
    extra: dict[str, Any] = {}
    if cfg.anthropic_model.startswith(("claude-opus-5", "claude-fable-5", "claude-mythos")):
        extra = {"betas": ["server-side-fallback-2026-07-01"], "fallbacks": "default"}

    try:
        response = client.beta.messages.create(
            model=cfg.anthropic_model,
            max_tokens=16000,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": content}],
            output_config={"format": {"type": "json_schema", "schema": TAG_SCHEMA}},
            **extra,
        )
    except anthropic.APIStatusError as exc:
        raise TagError(f"claude api error {exc.status_code}: {exc.message}") from exc

    if response.stop_reason == "refusal":
        raise TagError("claude declined the tagging request (stop_reason=refusal)")
    if response.stop_reason == "max_tokens":
        raise TagError("claude response truncated at max_tokens")

    text = next((b.text for b in response.content if b.type == "text"), None)
    if not text:
        raise TagError("no text block in claude response")
    return json.loads(text)
