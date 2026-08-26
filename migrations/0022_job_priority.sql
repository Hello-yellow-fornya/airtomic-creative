-- 0022: job priority — user-facing work must never queue behind bulk
-- backfill. Lower runs first; 0 = interactive (uploads, renders,
-- recommends from the UI), 10 = backfill and the ingest jobs it spawns.

ALTER TABLE jobs ADD COLUMN priority int NOT NULL DEFAULT 0;
CREATE INDEX jobs_claim_idx ON jobs (priority, run_at, id) WHERE status = 'queued';
