"""The `cleanup` job: delete R2 objects left behind by a removed clip.

Enqueued in the same transaction as the clip delete (web app,
/api/clips/delete), so the DB rows and the cleanup can't get out of sync —
if the delete commits, the cleanup runs; jobs retry if the worker is busy.
Payload: {"r2_prefixes": ["exports/<variant_id>/", ...]}.

Deleting a prefix that doesn't exist is a no-op, so a re-run is safe.
"""

import logging
from typing import Any

import psycopg

from . import r2
from .config import Config

log = logging.getLogger("worker.cleanup")


def handle(conn: psycopg.Connection, cfg: Config, s3, job: dict[str, Any]) -> None:
    prefixes = job["payload"].get("r2_prefixes") or []
    total = 0
    for prefix in prefixes:
        # Guard against a malformed payload wiping wide swathes of the
        # bucket: only the object families a clip can own are deletable.
        if not str(prefix).startswith(("exports/",)):
            log.warning("cleanup job %s: refusing prefix %r", job["id"], prefix)
            continue
        n = r2.delete_prefix(s3, cfg.r2_bucket, str(prefix))
        total += n
    log.info("cleanup job %s: deleted %d objects across %d prefixes",
             job["id"], total, len(prefixes))
