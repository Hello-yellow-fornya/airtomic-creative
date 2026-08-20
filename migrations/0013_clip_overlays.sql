-- Text overlays: a separate layer from subtitles, burned above them.
--
-- Overlays hang off the VARIANT, not the clip — variant B carrying a
-- different hook to control is the whole point of the A/B. (The brief
-- said "keyed to clip id" but also "overlays are part of the variant";
-- the second requirement wins, since a clip-level overlay could not
-- differ between variants.)
--
-- Times are seconds on the clip's OUTPUT timeline (0 = clip start).
-- Position and style are separate axes: position is WHERE (with safe-zone
-- offsets applied at render/preview per ratio), style is HOW (a key into
-- overlay_style_presets, which is data so new looks need no code change).

CREATE TABLE clip_overlays (
    id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    variant_id  uuid NOT NULL REFERENCES clip_variants(id) ON DELETE CASCADE,
    idx         int NOT NULL DEFAULT 0,
    text        text NOT NULL,
    start_s     numeric(10,3) NOT NULL DEFAULT 0,
    end_s       numeric(10,3) NOT NULL DEFAULT 3,   -- hooks live at the top
    position    text NOT NULL DEFAULT 'top'
                CHECK (position IN ('top', 'center', 'lower_third')),
    style       text NOT NULL DEFAULT 'hook',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CHECK (end_s > start_s)
);

CREATE INDEX idx_overlays_variant ON clip_overlays (variant_id, idx);

-- Style presets as data. fs is design-size at 1080px output width and is
-- scaled by the renderer; colours are hex; box_alpha 0..1.
CREATE TABLE overlay_style_presets (
    key         text PRIMARY KEY,
    name        text NOT NULL,
    config      jsonb NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO overlay_style_presets (key, name, config) VALUES
('hook', 'Hook', '{
  "font": "Plus Jakarta Sans", "weight": 800, "fs": 58,
  "color": "#FFFFFF", "box": true, "box_color": "#0A0B0D", "box_alpha": 0.78,
  "pad": 16, "align": "center", "uppercase": false,
  "default_position": "top"
}'),
('caption', 'Caption', '{
  "font": "Plus Jakarta Sans", "weight": 700, "fs": 38,
  "color": "#FFFFFF", "box": true, "box_color": "#0A0B0D", "box_alpha": 0.6,
  "pad": 12, "align": "center", "uppercase": false,
  "default_position": "center"
}'),
('cta', 'CTA', '{
  "font": "Plus Jakarta Sans", "weight": 800, "fs": 44,
  "color": "#0A0B0D", "box": true, "box_color": "#FFC629", "box_alpha": 1.0,
  "pad": 16, "align": "center", "uppercase": false,
  "default_position": "lower_third"
}');

-- Explicit staleness: overlay edits after a finished render mark the
-- variant stale so the UI offers "Re-render" instead of silently
-- re-queueing. Cleared when a render is requested.
ALTER TABLE clip_variants ADD COLUMN render_stale boolean NOT NULL DEFAULT false;
