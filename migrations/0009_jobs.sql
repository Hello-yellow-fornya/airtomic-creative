-- Job queue. 0008 ended before defining it; forward-only, so it lands here.
--
-- Claimed with SELECT ... FOR UPDATE SKIP LOCKED — no pg-boss, no Redis
-- (see CLAUDE.md). Workers poll; a claim marks the row 'running' and bumps
-- attempts in the same statement, so a crash mid-job still counts the attempt.

CREATE TYPE job_status AS ENUM ('queued', 'running', 'done', 'failed');

CREATE TABLE jobs (
    id            bigserial PRIMARY KEY,
    client_id     text NOT NULL DEFAULT 'klira',
    type          text NOT NULL,                     -- 'ingest'; later: scene_detect, tag, render, push
    payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
    status        job_status NOT NULL DEFAULT 'queued',
    attempts      int NOT NULL DEFAULT 0,
    max_attempts  int NOT NULL DEFAULT 3,
    run_at        timestamptz NOT NULL DEFAULT now(),  -- backoff pushes this forward
    locked_by     text,                              -- worker id, for debugging
    locked_at     timestamptz,
    error         text,                              -- last failure, kept across retries
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_jobs_claim ON jobs (run_at, id) WHERE status = 'queued';
CREATE INDEX idx_jobs_status ON jobs (status);
