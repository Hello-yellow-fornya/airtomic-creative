-- 0020: social-editor reframe — ONE transform per (variant, ratio),
-- replacing the per-scene vertical-axis crop as the source of truth.
--
-- {tx, ty, scale}: tx/ty are the source centre's offset from the frame
-- centre as fractions of the frame; scale is relative to cover-fill
-- (1.0 = frame exactly covered on its shorter axis). mode 'fit'
-- letterboxes with fit_color (brand swatch), stored per ratio.
--
-- Every existing crop converts to the equivalent transform (first scene
-- by idx wins where scenes differ — the proof script reports both the
-- converted count and any (variant, ratio) that doesn't round-trip to
-- the same pixel window within 1px). scene_crops stays in place as the
-- legacy record; the renderer reads variant_transforms from now on.
--
-- stale_ratios: editing a transform marks only that variant AND ratio
-- stale; rendering that ratio clears it.

BEGIN;

CREATE TABLE variant_transforms (
  variant_id uuid NOT NULL REFERENCES clip_variants(id) ON DELETE CASCADE,
  ratio output_ratio NOT NULL,
  tx numeric(8,5) NOT NULL DEFAULT 0,
  ty numeric(8,5) NOT NULL DEFAULT 0,
  scale numeric(7,4) NOT NULL DEFAULT 1,
  mode text NOT NULL DEFAULT 'cover' CHECK (mode IN ('cover','fit')),
  fit_color text NOT NULL DEFAULT '#0A0B0D',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (variant_id, ratio)
);

ALTER TABLE clip_variants
  ADD COLUMN stale_ratios text[] NOT NULL DEFAULT '{}';

INSERT INTO variant_transforms (variant_id, ratio, tx, ty, scale)
SELECT variant_id, ratio,
  round((((0.5 - (crop_x + crop_w/2)) / crop_w))::numeric, 5),
  round((((0.5 - (crop_y + crop_h/2)) / crop_h))::numeric, 5),
  round((fw / (crop_w * src_w) / GREATEST(fw/src_w, fh/src_h))::numeric, 4)
FROM (
  SELECT DISTINCT ON (vs.variant_id, sc.ratio)
    vs.variant_id, sc.ratio,
    sc.crop_x::float8, sc.crop_y::float8,
    sc.crop_w::float8, sc.crop_h::float8,
    v.width::float8 AS src_w, v.height::float8 AS src_h,
    CASE sc.ratio::text WHEN '1.91x1' THEN 1200.0 ELSE 1080.0 END AS fw,
    CASE sc.ratio::text WHEN '9x16' THEN 1920.0 WHEN '4x5' THEN 1350.0
                        WHEN '1x1' THEN 1080.0 ELSE 628.0 END AS fh
  FROM scene_crops sc
  JOIN variant_scenes vs ON vs.id = sc.scene_id
  JOIN clip_variants cv ON cv.id = vs.variant_id
  JOIN clips c ON c.id = cv.clip_id
  JOIN videos v ON v.id = c.video_id
  WHERE v.width IS NOT NULL AND v.height IS NOT NULL
  ORDER BY vs.variant_id, sc.ratio, vs.idx
) q
ON CONFLICT DO NOTHING;

COMMIT;
