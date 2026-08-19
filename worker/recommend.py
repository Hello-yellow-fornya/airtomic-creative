"""The `recommend` job: content-based candidate generation.

Proposes clip candidates from the video in front of it — transcript
structure plus the creative_tags row — with NO historical performance data.
One Claude call per video, text only (hooks are transcript-structural, so
no keyframe grid; same cost discipline as the tagger).

Honesty contract (CLAUDE.md §5): these are content-scored, not
performance-scored. There is no n=. Every candidate's matched_tags carries

    {"basis": "content",
     "evidence": "ranked on content features · no performance data yet",
     ...}

and the UI renders that line verbatim instead of a sample size. When the
Meta backfill lands, a performance term is ADDED to the score and the
evidence line switches to a real n= — the scorer is decomposed
(matched_tags.scores) so that's an extra term, not a rewrite.

Boundary handling: the model proposes times at sentence boundaries; we then
snap start/end to the nearest transcript word edge so candidates line up
with the Find screen's word-level selection.
"""

import json
import logging
from typing import Any

import psycopg

from . import db, pipeline
from .config import Config

log = logging.getLogger("worker.recommend")

SCORER_VERSION = "content-v1"
EVIDENCE_LINE = "ranked on content features · no performance data yet"

MIN_LEN_S = 12.0
MAX_LEN_S = 45.0
MAX_CANDIDATES = 6
SNAP_WINDOW_S = 3.0          # how far a proposed boundary may move to a word edge
TRANSCRIPT_CHAR_CAP = 150_000


class RecommendError(Exception):
    pass


SYSTEM_PROMPT = """\
You find ad-worthy segments in long-form content for Klira (klira.skin), a UK
prescription skincare brand. You receive a timestamped transcript with speaker
labels, plus the video's creative tags. Propose the segments most worth
cutting into a short vertical ad, judged on CONTENT STRUCTURE ONLY — you have
no performance data, so do not pretend to.

What makes a strong candidate:
- The opening line is a hook: a question, a contrarian statement, a direct
  address to the viewer, or a concrete specific claim. Not scene-setting,
  not mid-anecdote context.
- It lands on a complete thought. Boundaries sit at sentence ends — never
  mid-clause. The final sentence should resolve what the opening set up.
- 12-45 seconds long.
- The opening line has a single speaker where possible (crosstalk in the
  first seconds kills a hook).
- Segments can overlap slightly if two genuinely distinct hooks share
  material, but prefer distinct moments.

Compliance: Klira sells prescription-only (POM) skincare. UK rules prohibit
advertising prescription-only medicines to the public. Set treatment_claim
to true on any segment whose text makes treatment or medical claims
("clears acne", "fades melasma", prescription ingredients treating a
condition) and quote the claim in treatment_claim_note. Flagged segments are
still worth surfacing — the team edits them — but the flag must be set.

Timing: use the [mm:ss] segment timestamps to place start_s and end_s in
seconds. Quote the exact first and last few words so boundaries can be
verified against word-level timings.

Return at most {max_candidates} candidates, best first. If the transcript
genuinely offers fewer strong hooks, return fewer — an empty list is a valid
answer. Score each 0-1 on content strength only."""


RECOMMEND_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["candidates"],
    "properties": {
        # no maxItems — structured outputs reject it on arrays; the prompt
        # asks for at most MAX_CANDIDATES and _prepare_rows enforces the cap
        "candidates": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "start_s", "end_s", "opening_type", "score", "rationale",
                    "first_words", "last_words", "single_speaker_open",
                    "treatment_claim", "treatment_claim_note",
                ],
                "properties": {
                    "start_s": {"type": "number",
                                "description": "Segment start in seconds, at a sentence start"},
                    "end_s": {"type": "number",
                              "description": "Segment end in seconds, at a sentence end"},
                    "opening_type": {
                        "type": "string",
                        "enum": ["question", "contrarian", "direct_address",
                                 "concrete_claim", "other"],
                        "description": "What kind of hook the opening line is",
                    },
                    "score": {"type": "number",
                              "description": "Content strength 0-1; no performance component"},
                    "rationale": {"type": "string",
                                  "description": "Why this segment, in one or two sentences"},
                    "first_words": {"type": "string",
                                    "description": "The segment's first ~6 words, verbatim"},
                    "last_words": {"type": "string",
                                   "description": "The segment's last ~6 words, verbatim"},
                    "single_speaker_open": {"type": "boolean",
                                            "description": "True if the opening line has one speaker"},
                    "treatment_claim": {"type": "boolean",
                                        "description": "True if the segment makes treatment/medical claims"},
                    "treatment_claim_note": {
                        "type": ["string", "null"],
                        "description": "The claim, quoted; null if not flagged",
                    },
                },
            },
        },
    },
}


def handle(conn: psycopg.Connection, cfg: Config, s3, job: dict[str, Any]) -> None:
    video_id = job["payload"].get("video_id")
    if not video_id:
        raise RecommendError(f"job {job['id']} has no video_id in payload")
    if not cfg.anthropic_api_key:
        raise RecommendError("ANTHROPIC_API_KEY is not set — cannot score segments")

    video = conn.execute(
        "SELECT * FROM videos WHERE id = %s", (video_id,)
    ).fetchone()
    if video is None:
        raise RecommendError(f"video {video_id} not found")

    transcript_text, n_segments = _transcript_text(conn, video_id)
    if not n_segments:
        # Nothing to score is not a failure — the video is still usable.
        log.info("video %s has no transcript segments — skipping recommend", video_id)
        pipeline.advance(conn, video_id, "recommend")
        return

    words = conn.execute(
        """
        SELECT w.start_s, w.end_s FROM transcript_words w
        JOIN transcripts t ON t.id = w.transcript_id
        WHERE t.video_id = %s AND w.start_s IS NOT NULL AND w.end_s IS NOT NULL
        ORDER BY w.start_s
        """,
        (video_id,),
    ).fetchall()
    word_starts = [float(w["start_s"]) for w in words]
    word_ends = [float(w["end_s"]) for w in words]

    tags = conn.execute(
        """
        SELECT universal, brand FROM creative_tags
        WHERE video_id = %s ORDER BY created_at DESC LIMIT 1
        """,
        (video_id,),
    ).fetchone()

    db.set_video_status(conn, video_id, "tagging", "finding candidate cuts")
    duration = float(video["duration_s"] or 0)
    result = _call_claude(
        cfg, transcript_text,
        title=video["title"], duration_s=duration, tags=tags,
    )

    rows = _prepare_rows(
        result.get("candidates", []),
        duration=duration,
        word_starts=word_starts,
        word_ends=word_ends,
    )

    model_version = f"{SCORER_VERSION}/{cfg.anthropic_model}"
    with conn.transaction():
        # Idempotent for this scorer: replace its own un-triaged suggestions,
        # never rows the team has shortlisted/rejected/used, never another
        # scorer's rows.
        conn.execute(
            """
            DELETE FROM clip_candidates
            WHERE video_id = %s AND status = 'suggested'
              AND model_version LIKE %s
            """,
            (video_id, f"{SCORER_VERSION}/%"),
        )
        for r in rows:
            conn.execute(
                """
                INSERT INTO clip_candidates
                    (video_id, start_s, end_s, score, rationale,
                     matched_tags, model_version, status)
                VALUES (%s, %s, %s, %s, %s, %s, %s, 'suggested')
                """,
                (video_id, r["start_s"], r["end_s"], r["score"],
                 r["rationale"], json.dumps(r["matched_tags"]), model_version),
            )

    log.info("video %s: %s candidate(s) written (%s proposed)",
             video_id, len(rows), len(result.get("candidates", [])))
    pipeline.advance(conn, video_id, "recommend")


def on_permanent_failure(conn: psycopg.Connection, job: dict[str, Any], error: str) -> None:
    """A video without suggestions is degraded, not broken — everything the
    team needs to cut manually (transcript, scenes, tags) already exists.
    Mark it ready with an honest note instead of failed."""
    video_id = job["payload"].get("video_id")
    if video_id:
        db.set_video_status(
            conn, video_id, "ready",
            f"ready — candidate scoring failed: {error[:300]}",
        )


def _prepare_rows(
    candidates: list[dict],
    *,
    duration: float,
    word_starts: list[float],
    word_ends: list[float],
) -> list[dict]:
    """Validate, snap to word boundaries, enforce length limits, dedupe."""
    rows: list[dict] = []
    for c in candidates:
        try:
            start = float(c["start_s"])
            end = float(c["end_s"])
        except (KeyError, TypeError, ValueError):
            continue
        start = _snap(start, word_starts) if word_starts else start
        end = _snap(end, word_ends) if word_ends else end
        start = max(0.0, start)
        end = min(duration or end, end)
        if end - start < MIN_LEN_S or end - start > MAX_LEN_S:
            log.info("dropping candidate %.1f-%.1f: %.1fs outside %s-%ss",
                     start, end, end - start, MIN_LEN_S, MAX_LEN_S)
            continue
        if any(abs(r["start_s"] - start) < 2 and abs(r["end_s"] - end) < 2
               for r in rows):
            continue
        score = c.get("score")
        score = max(0.0, min(1.0, float(score))) if score is not None else None
        flagged = bool(c.get("treatment_claim"))
        rows.append({
            "start_s": round(start, 3),
            "end_s": round(end, 3),
            "score": score,
            "rationale": (c.get("rationale") or "")[:600] or None,
            "matched_tags": {
                "basis": "content",
                "evidence": EVIDENCE_LINE,
                "n": None,
                "flag": flagged,
                "flag_reason": (c.get("treatment_claim_note") or None) if flagged else None,
                "features": [f for f, on in (
                    (c.get("opening_type"), True),
                    ("single_speaker_open", c.get("single_speaker_open")),
                ) if on and f],
                # decomposed so the performance term is an addition later
                "scores": {"content": score},
                "first_words": (c.get("first_words") or "")[:120] or None,
                "last_words": (c.get("last_words") or "")[:120] or None,
            },
        })
    rows.sort(key=lambda r: (r["score"] is None, -(r["score"] or 0)))
    return rows[:MAX_CANDIDATES]


def _snap(t: float, edges: list[float]) -> float:
    """Nearest word edge within SNAP_WINDOW_S; otherwise the proposed time."""
    import bisect
    i = bisect.bisect_left(edges, t)
    best = t
    bd = SNAP_WINDOW_S
    for j in (i - 1, i, i + 1):
        if 0 <= j < len(edges) and abs(edges[j] - t) < bd:
            bd = abs(edges[j] - t)
            best = edges[j]
    return best


def _transcript_text(conn: psycopg.Connection, video_id: str) -> tuple[str, int]:
    rows = conn.execute(
        """
        SELECT s.start_s, s.speaker, s.text FROM transcript_segments s
        JOIN transcripts t ON t.id = s.transcript_id
        WHERE t.video_id = %s ORDER BY s.idx
        """,
        (video_id,),
    ).fetchall()
    lines = []
    total = 0
    for row in rows:
        mm, ss = divmod(int(row["start_s"]), 60)
        spk = f" {row['speaker']}" if row["speaker"] else ""
        line = f"[{mm:02d}:{ss:02d}]{spk}: {row['text']}"
        total += len(line) + 1
        if total > TRANSCRIPT_CHAR_CAP:
            lines.append("[... transcript truncated ...]")
            break
        lines.append(line)
    return "\n".join(lines), len(rows)


def _call_claude(
    cfg: Config,
    transcript_text: str,
    *,
    title: str | None,
    duration_s: float,
    tags: dict | None,
) -> dict[str, Any]:
    import anthropic

    client = anthropic.Anthropic(api_key=cfg.anthropic_api_key)

    tag_block = ""
    if tags:
        tag_block = (
            "\n\nCreative tags for this video:\n"
            f"universal: {json.dumps(tags['universal'])}\n"
            f"brand: {json.dumps(tags['brand'])}"
        )
    prompt = (
        f"Video: {title or 'untitled'} (duration {duration_s:.0f}s)"
        f"{tag_block}\n\nTranscript:\n{transcript_text}\n\n"
        "Propose the segments most worth cutting."
    )

    extra: dict[str, Any] = {}
    if cfg.anthropic_model.startswith(("claude-opus-5", "claude-fable-5", "claude-mythos")):
        extra = {"betas": ["server-side-fallback-2026-07-01"], "fallbacks": "default"}

    try:
        response = client.beta.messages.create(
            model=cfg.anthropic_model,
            max_tokens=8000,
            system=SYSTEM_PROMPT.format(max_candidates=MAX_CANDIDATES),
            messages=[{"role": "user", "content": prompt}],
            output_config={"format": {"type": "json_schema", "schema": RECOMMEND_SCHEMA}},
            **extra,
        )
    except anthropic.APIStatusError as exc:
        raise RecommendError(f"claude api error {exc.status_code}: {exc.message}") from exc

    if response.stop_reason == "refusal":
        raise RecommendError("claude declined the scoring request (stop_reason=refusal)")
    if response.stop_reason == "max_tokens":
        raise RecommendError("claude response truncated at max_tokens")

    text = next((b.text for b in response.content if b.type == "text"), None)
    if not text:
        raise RecommendError("no text block in claude response")
    return json.loads(text)
