"""The pipeline stage chain, defined in one place.

Each stage handler does its work and calls advance(), which enqueues the next
stage's job — or marks the video 'ready' after the last stage. Adding a stage
is one entry in SEQUENCE plus a handler registration in main.py; no handler
knows or cares what runs after it, and the terminal status can't be set early
by accident.

Stage -> active video status (set by each handler when it starts work):
    ingest       -> transcribing
    scene_detect -> detecting
    tag          -> tagging
    recommend    -> tagging (detail: finding candidate cuts — no new enum
                   value, so the upload panel's stage list stays valid)
"""

from typing import Any

import psycopg

from . import db

SEQUENCE = ["ingest", "scene_detect", "tag", "recommend"]


def advance(conn: psycopg.Connection, video_id: str, completed_stage: str) -> None:
    idx = SEQUENCE.index(completed_stage)
    if idx + 1 < len(SEQUENCE):
        next_stage = SEQUENCE[idx + 1]
        db.enqueue_job(conn, next_stage, {"video_id": str(video_id)})
        conn.execute(
            "UPDATE videos SET status_detail = %s WHERE id = %s",
            (f"queued: {next_stage}", video_id),
        )
    else:
        conn.execute(
            "UPDATE videos SET status = 'ready', status_detail = 'pipeline complete' "
            "WHERE id = %s",
            (video_id,),
        )


def on_permanent_failure(conn: psycopg.Connection, job: dict[str, Any], error: str) -> None:
    """Shared failure hook for every pipeline stage: mark the video failed."""
    video_id = job["payload"].get("video_id")
    if video_id:
        db.set_video_status(conn, video_id, "failed", error[:500])
