-- Meta push records and the job queue.

CREATE TYPE push_status AS ENUM ('queued', 'uploading', 'processing', 'created', 'failed');

-- Two send modes. 'library' uploads the video only — no ad is created, so
-- there is no ad review and nothing can be rejected. 'ads' builds a full ad.
CREATE TYPE send_mode AS ENUM ('library', 'ads');

CREATE TABLE meta_pushes (
    id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    variant_id        uuid NOT NULL REFERENCES clip_variants(id) ON DELETE CASCADE,
    mode              send_mode NOT NULL DEFAULT 'ads',
    ratio             output_ratio NOT NULL DEFAULT '9x16',
    ad_account_id     text NOT NULL,
    target_adset_id   text,               -- required for mode='ads'; null for library
    page_id           text,               -- Facebook Page identity
    instagram_actor_id text,              -- IG identity; without it ads run under a shadow profile
    meta_video_id     text,
    creative_id       text,
    ad_id             text,
    primary_text      text,
    headline          text,
    cta_type          text,               -- Meta CTA enum, e.g. LEARN_MORE
    link_url          text,               -- destination including UTMs
    thumbnail_uri     text,
    status            push_status NOT NULL DEFAULT 'queued',
    review_status     text,               -- Meta ad review outcome
    rejection_reason  text,
    error             text,
    attempts          int NOT NULL DEFAULT 0,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT adset_required_for_ads CHECK (mode = 'library' OR target_adset_id IS NOT NULL)
);

CREATE INDEX idx_pushes_variant ON meta_pushes (variant_id);
CREATE INDEX idx_pushes_status ON meta_pushes (status);

-- Job queue (skip if using a dedicated queue)
