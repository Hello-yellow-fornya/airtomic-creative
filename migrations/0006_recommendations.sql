-- Candidate segments surfaced by the recommendation engine.

CREATE TYPE candidate_status AS ENUM ('suggested', 'shortlisted', 'rejected', 'used');

CREATE TABLE clip_candidates (
    id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    video_id       uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    start_s        numeric(10,3) NOT NULL,
    end_s          numeric(10,3) NOT NULL,
    score          numeric(6,4),
    rationale      text,                 -- why the model flagged it
    matched_tags   jsonb,                -- which historical patterns it resembles
    model_version  text,
    status         candidate_status NOT NULL DEFAULT 'suggested',
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_candidates_video ON clip_candidates (video_id, score DESC);

CREATE TABLE subtitle_presets (
    id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id   text NOT NULL DEFAULT 'klira',
    name        text NOT NULL,
    is_default  boolean NOT NULL DEFAULT false,
    config      jsonb NOT NULL,   -- font, size, colours, outline, position,
                                  -- max words/line, caps, active-word highlight
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
