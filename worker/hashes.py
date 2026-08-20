"""The `hash_backfill` job: sha256 for videos ingested before content
hashes existed. Streams each source from R2 (zero egress) — one method for
every row, so identical content always groups. Partial progress commits
per video; a re-run picks up where it stopped."""

import hashlib
import logging
from typing import Any

import psycopg

from . import r2
from .config import Config

log = logging.getLogger("worker.hashes")


def handle(conn: psycopg.Connection, cfg: Config, s3, job: dict[str, Any]) -> None:
    rows = conn.execute(
        """
        SELECT id, storage_uri FROM videos
        WHERE content_hash IS NULL AND storage_uri LIKE 'r2://%'
        ORDER BY ingested_at
        """
    ).fetchall()
    log.info("hash backfill: %s videos without a content hash", len(rows))
    done = failed = 0
    for row in rows:
        try:
            bucket, key = r2.parse_uri(row["storage_uri"])
            h = hashlib.sha256()
            body = s3.get_object(Bucket=bucket, Key=key)["Body"]
            for chunk in iter(lambda: body.read(1 << 20), b""):
                h.update(chunk)
            conn.execute(
                "UPDATE videos SET content_hash = %s WHERE id = %s",
                (h.hexdigest(), row["id"]),
            )
            done += 1
        except Exception as exc:
            failed += 1
            log.warning("hash backfill: video %s failed: %s", row["id"], exc)
    log.info("hash backfill: %s hashed, %s failed", done, failed)
    if failed:
        raise RuntimeError(f"hash backfill: {failed} of {len(rows)} failed — "
                           "successes are kept; re-run to retry")
