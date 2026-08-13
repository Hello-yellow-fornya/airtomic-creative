-- Scene detection and versioned creative tags.

CREATE TABLE scenes (
    id            bigserial PRIMARY KEY,
    video_id      uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    idx           int NOT NULL,
    start_s       numeric(10,3) NOT NULL,
    end_s         numeric(10,3) NOT NULL,
    keyframe_uri  text
);

CREATE INDEX idx_scenes_video ON scenes (video_id, start_s);

-- Tags kept as JSONB with an explicit schema version, so re-tagging
-- after a schema change is a new row rather than a destructive update.
CREATE TABLE creative_tags (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    video_id        uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    schema_version  text NOT NULL,
    universal       jsonb NOT NULL DEFAULT '{}'::jsonb,  -- hook type, cuts/10s, CTA type...
    brand           jsonb NOT NULL DEFAULT '{}'::jsonb,  -- skin concern, claim type...
    model           text,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_tags_video ON creative_tags (video_id);
CREATE INDEX idx_tags_universal ON creative_tags USING gin (universal);
CREATE INDEX idx_tags_brand ON creative_tags USING gin (brand);
