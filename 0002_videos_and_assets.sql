-- Source videos (ad creatives + long-form) and brand assets.

CREATE TYPE video_source AS ENUM ('ad_creative', 'longform');
CREATE TYPE ingest_status AS ENUM (
    'uploading', 'queued', 'transcribing', 'detecting', 'tagging', 'ready', 'failed'
);

CREATE TABLE videos (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id       text NOT NULL DEFAULT 'klira',   -- always klira for now; cheap insurance
    source          video_source NOT NULL,
    meta_video_id   text,                            -- null for uploaded long-form
    title           text,
    storage_uri     text NOT NULL,                   -- R2/S3 path to the file we control
    proxy_uri       text,                            -- 720p transcode for browser scrubbing
    duration_s      numeric(10,3),
    width           int,
    height          int,
    fps             numeric(6,3),
    has_audio       boolean DEFAULT true,
    status          ingest_status NOT NULL DEFAULT 'queued',
    status_detail   text,                            -- progress or failure reason
    uploaded_by     text,
    ingested_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (client_id, meta_video_id)
);

CREATE INDEX idx_videos_source ON videos (client_id, source);

CREATE TYPE asset_kind AS ENUM ('product_still', 'end_card', 'logo', 'broll', 'other');

CREATE TABLE assets (
    id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id    text NOT NULL DEFAULT 'klira',
    kind         asset_kind NOT NULL,
    name         text NOT NULL,
    storage_uri  text NOT NULL,
    width        int,
    height       int,
    duration_s   numeric(10,3),          -- null for stills
    tags         jsonb NOT NULL DEFAULT '{}'::jsonb,  -- product, concern, campaign
    uploaded_by  text,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_assets_kind ON assets (client_id, kind);
CREATE INDEX idx_assets_tags ON assets USING gin (tags);
