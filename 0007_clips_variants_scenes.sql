-- Clips, named variants, scenes and per-ratio crops.

-- Clips, variants and scenes
--
--   clips            one accepted segment from a source video
--    └ clip_variants named hook alternatives (A, B, C) — each becomes one ad
--       └ variant_scenes  ordered scenes, one layout each
--          └ scene_crops  one crop per output aspect ratio
--
-- Approval sits on the variant, not the clip, because each variant is
-- reviewed and pushed independently.

-- Reusable structure without content. Applying one to an accepted
-- recommendation produces a finished variant in a single action.
CREATE TABLE clip_templates (
    id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id   text NOT NULL DEFAULT 'klira',
    name        text NOT NULL,
    is_default  boolean NOT NULL DEFAULT false,
    spec        jsonb NOT NULL,   -- ordered scene shapes, proportional durations, slot roles
    created_at  timestamptz NOT NULL DEFAULT now()
);


CREATE TABLE clips (
    id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id           text NOT NULL DEFAULT 'klira',
    video_id            uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    candidate_id        uuid REFERENCES clip_candidates(id) ON DELETE SET NULL,
    name                text,
    source_in_s         numeric(10,3) NOT NULL,
    source_out_s        numeric(10,3) NOT NULL,
    subtitle_preset_id  uuid REFERENCES subtitle_presets(id),
    subtitle_overrides  jsonb,          -- per-clip tweaks + manual text corrections
    created_by          text,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_clips_video ON clips (video_id);

CREATE TYPE variant_status AS ENUM (
    'draft', 'in_review', 'approved', 'sending', 'sent', 'failed'
);

CREATE TABLE clip_variants (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    clip_id       uuid NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    label         text NOT NULL,                  -- 'A', 'B', 'C'
    name          text NOT NULL,                  -- 'Control', 'Emotional hook'
    slug          text NOT NULL,                  -- derived; used in ad name and utm_content
    template_id   uuid REFERENCES clip_templates(id) ON DELETE SET NULL,
    status        variant_status NOT NULL DEFAULT 'draft',
    submitted_by  text,
    submitted_at  timestamptz,
    approved_by   text,                           -- must differ from submitted_by if
    approved_at   timestamptz,                    -- separation of duties is enforced
    export_uri    text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (clip_id, label)
);

CREATE INDEX idx_variants_clip ON clip_variants (clip_id);
CREATE INDEX idx_variants_status ON clip_variants (status);

-- Layouts are a fixed, named set. Content flows into slots; nothing is
-- free-positioned, which is what makes a variant templatable.
CREATE TYPE scene_layout AS ENUM (
    'full',             -- source video, cropped to the target ratio
    'split_product',    -- speaker above, brand asset below
    'split_speakers',   -- both speakers stacked
    'card'              -- full-frame asset, no source video
);

CREATE TYPE scene_audio AS ENUM ('source', 'mute');

CREATE TABLE variant_scenes (
    id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    variant_id     uuid NOT NULL REFERENCES clip_variants(id) ON DELETE CASCADE,
    idx            int NOT NULL,          -- output order; reordering is an idx change
    layout         scene_layout NOT NULL DEFAULT 'full',

    source_in_s    numeric(10,3),         -- source-backed scenes
    source_out_s   numeric(10,3),
    lifted         boolean NOT NULL DEFAULT true,  -- removed from its original position?

    duration_s     numeric(10,3),         -- card scenes (no source video)

    slot_a_asset   uuid REFERENCES assets(id) ON DELETE SET NULL,
    slot_b_asset   uuid REFERENCES assets(id) ON DELETE SET NULL,

    split_ratio    numeric(4,3) DEFAULT 0.5,   -- upper share in split layouts
    audio          scene_audio NOT NULL DEFAULT 'source',

    CONSTRAINT scene_has_content CHECK (
        (source_in_s IS NOT NULL AND source_out_s IS NOT NULL) OR duration_s IS NOT NULL
    ),
    UNIQUE (variant_id, idx) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX idx_vscenes_variant ON variant_scenes (variant_id, idx);

-- One crop per scene per output ratio. A 9:16 crop does not transfer to 1:1 —
-- the square window is nearly twice as wide and pulls in the other speaker.
-- 1.91:1 is wider than a 16:9 source, so it crops HEIGHT, not width.
CREATE TYPE output_ratio AS ENUM ('9x16', '4x5', '1x1', '1.91x1');

CREATE TABLE scene_crops (
    scene_id   uuid NOT NULL REFERENCES variant_scenes(id) ON DELETE CASCADE,
    ratio      output_ratio NOT NULL,
    crop_x     numeric(6,5) NOT NULL,   -- normalised 0-1 against source dimensions
    crop_y     numeric(6,5) NOT NULL,
    crop_w     numeric(6,5) NOT NULL,
    crop_h     numeric(6,5) NOT NULL,
    PRIMARY KEY (scene_id, ratio)
);
