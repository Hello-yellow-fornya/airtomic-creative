"""Worker entrypoint: poll the jobs table, dispatch by job type.

    python -m worker.main

Concurrency is WORKER_CONCURRENCY threads, each with its own connection and
claim loop — jobs here are I/O-bound (R2, ffmpeg subprocess, waiting on
Modal), so threads are enough.
"""

import logging
import signal
import socket
import threading
import time
import traceback

from . import config, db, ingest, r2, webapp

log = logging.getLogger("worker")

HANDLERS = {
    "ingest": ingest.handle,
}
FAILURE_HOOKS = {
    "ingest": ingest.on_permanent_failure,
}

STUCK_SWEEP_INTERVAL_S = 300

_stop = threading.Event()


def _run_one(conn, cfg, s3, worker_id: str) -> bool:
    """Claim and run a single job. Returns False when the queue was empty."""
    job = db.claim_job(conn, worker_id)
    if job is None:
        return False

    handler = HANDLERS.get(job["type"])
    if handler is None:
        db.retry_or_fail_job(conn, job, f"no handler for job type '{job['type']}'")
        log.error("job %s: unknown type '%s'", job["id"], job["type"])
        return True

    log.info("job %s (%s): starting, attempt %s/%s",
             job["id"], job["type"], job["attempts"], job["max_attempts"])
    try:
        handler(conn, cfg, s3, job)
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"
        log.error("job %s failed: %s\n%s", job["id"], error, traceback.format_exc())
        permanent = db.retry_or_fail_job(conn, job, error)
        if permanent:
            hook = FAILURE_HOOKS.get(job["type"])
            if hook:
                hook(conn, job, error)
            log.error("job %s: permanently failed", job["id"])
    else:
        db.complete_job(conn, job["id"])
        log.info("job %s: done", job["id"])
    return True


def _loop(slot: int, cfg) -> None:
    worker_id = f"{socket.gethostname()}:{slot}"
    conn = db.connect(cfg.database_url)
    s3 = r2.client(cfg.r2_account_id, cfg.r2_access_key_id, cfg.r2_secret_access_key)
    last_sweep = 0.0

    while not _stop.is_set():
        try:
            if slot == 0 and time.monotonic() - last_sweep > STUCK_SWEEP_INTERVAL_S:
                requeued = db.requeue_stuck_jobs(conn)
                if requeued:
                    log.warning("requeued %s stuck job(s)", requeued)
                last_sweep = time.monotonic()

            if not _run_one(conn, cfg, s3, worker_id):
                _stop.wait(cfg.poll_interval_s)
        except Exception:
            # Connection-level failures land here; back off and reconnect.
            log.error("worker loop error:\n%s", traceback.format_exc())
            try:
                conn.close()
            except Exception:
                pass
            _stop.wait(5)
            conn = db.connect(cfg.database_url)


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    cfg = config.load()

    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: _stop.set())

    threads = [
        threading.Thread(target=_loop, args=(slot, cfg), daemon=True)
        for slot in range(cfg.concurrency)
    ]
    for t in threads:
        t.start()
    log.info("worker up: %s thread(s), polling every %ss",
             cfg.concurrency, cfg.poll_interval_s)

    server = None
    if cfg.ingest_token:
        server = webapp.make_server(cfg)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        log.info("web trigger listening on :%s", cfg.port)
    else:
        log.info("INGEST_TOKEN not set — web trigger disabled")

    while not _stop.is_set():
        _stop.wait(1)
    log.info("shutting down")
    if server is not None:
        server.shutdown()
    for t in threads:
        t.join(timeout=30)


if __name__ == "__main__":
    main()
