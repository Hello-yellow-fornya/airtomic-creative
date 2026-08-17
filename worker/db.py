"""Postgres access and the jobs queue.

Claiming uses FOR UPDATE SKIP LOCKED inside a single UPDATE, so any number of
workers can poll the same table without coordination (see CLAUDE.md — this is
the queue; don't reintroduce pg-boss).
"""

import json
from typing import Any

import psycopg
from psycopg.rows import dict_row

# A worker that dies mid-job leaves the row 'running' forever; after this long
# it is assumed dead and requeued. Ingest is idempotent (transcripts are
# replaced, not appended), so a rare double-run is safe. Must comfortably
# exceed the longest legitimate job — Modal polling caps at 2h.
STUCK_JOB_THRESHOLD = "3 hours"


def connect(database_url: str) -> psycopg.Connection:
    return psycopg.connect(database_url, row_factory=dict_row, autocommit=True)


def claim_job(conn: psycopg.Connection, worker_id: str) -> dict[str, Any] | None:
    row = conn.execute(
        """
        UPDATE jobs
        SET status = 'running', locked_by = %s, locked_at = now(),
            attempts = attempts + 1, updated_at = now()
        WHERE id = (
            SELECT id FROM jobs
            WHERE status = 'queued' AND run_at <= now()
            ORDER BY run_at, id
            LIMIT 1
            FOR UPDATE SKIP LOCKED
        )
        RETURNING *
        """,
        (worker_id,),
    ).fetchone()
    return row


def complete_job(conn: psycopg.Connection, job_id: int) -> None:
    conn.execute(
        "UPDATE jobs SET status = 'done', error = NULL, updated_at = now() WHERE id = %s",
        (job_id,),
    )


def retry_or_fail_job(conn: psycopg.Connection, job: dict[str, Any], error: str) -> bool:
    """Requeue with exponential backoff, or mark failed once attempts run out.
    Returns True if the failure is permanent."""
    if job["attempts"] >= job["max_attempts"]:
        conn.execute(
            "UPDATE jobs SET status = 'failed', error = %s, updated_at = now() WHERE id = %s",
            (error, job["id"]),
        )
        return True
    backoff_s = min(30 * 2 ** (job["attempts"] - 1), 3600)
    conn.execute(
        """
        UPDATE jobs
        SET status = 'queued', error = %s, run_at = now() + %s * interval '1 second',
            updated_at = now()
        WHERE id = %s
        """,
        (error, backoff_s, job["id"]),
    )
    return False


def set_video_status(
    conn: psycopg.Connection, video_id: str, status: str, detail: str
) -> None:
    conn.execute(
        "UPDATE videos SET status = %s, status_detail = %s WHERE id = %s",
        (status, detail, video_id),
    )


def create_video_and_ingest_job(
    conn: psycopg.Connection,
    *,
    storage_uri: str,
    title: str | None,
    source: str,
    uploaded_by: str | None,
    video_id: str | None = None,
) -> tuple[str, int]:
    """storage_uri may be r2:// (already uploaded) or http(s):// — the ingest
    handler fetches URL sources into R2 itself."""
    with conn.transaction():
        row = conn.execute(
            """
            INSERT INTO videos (id, source, title, storage_uri, status, uploaded_by)
            VALUES (coalesce(%s, uuid_generate_v4()), %s, %s, %s, 'queued', %s)
            RETURNING id
            """,
            (video_id, source, title, storage_uri, uploaded_by),
        ).fetchone()
        job_id = enqueue_job(conn, "ingest", {"video_id": str(row["id"])})
    return str(row["id"]), job_id


def enqueue_job(
    conn: psycopg.Connection, job_type: str, payload: dict[str, Any]
) -> int:
    row = conn.execute(
        "INSERT INTO jobs (type, payload) VALUES (%s, %s) RETURNING id",
        (job_type, json.dumps(payload)),
    ).fetchone()
    return row["id"]


def requeue_stuck_jobs(conn: psycopg.Connection) -> int:
    rows = conn.execute(
        f"""
        UPDATE jobs
        SET status = 'queued', error = coalesce(error || '; ', '') || 'requeued: worker presumed dead',
            updated_at = now()
        WHERE status = 'running' AND locked_at < now() - interval '{STUCK_JOB_THRESHOLD}'
        RETURNING id
        """
    ).fetchall()
    return len(rows)


def create_asset(
    conn: psycopg.Connection,
    *,
    asset_id: str,
    kind: str,
    name: str,
    storage_uri: str,
    width: int | None,
    height: int | None,
    duration_s: float | None,
    uploaded_by: str | None,
) -> str:
    row = conn.execute(
        """
        INSERT INTO assets (id, kind, name, storage_uri, width, height,
                            duration_s, uploaded_by)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        RETURNING id
        """,
        (asset_id, kind, name, storage_uri, width, height, duration_s, uploaded_by),
    ).fetchone()
    return str(row["id"])
