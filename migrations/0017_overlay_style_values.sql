-- 0017: overlays store RESOLVED style values, not a preset reference.
--
-- The shared "Text style" panel edits size / outline / vertical position /
-- words-per-line / background / colours per overlay. Values live on the
-- overlay row (sv jsonb) so retuning a preset later never silently
-- restyles burned work. The style column stays as the chip label
-- ('hook' | 'caption' | 'cta' | 'custom').
--
-- vp is a percentage of frame height (like subtitle presets). Backfill
-- maps the old position enum at its 9:16 reference values: top 20,
-- centre 50, lower third 76.

BEGIN;

ALTER TABLE clip_overlays ADD COLUMN sv jsonb;
ALTER TABLE clip_overlays DROP CONSTRAINT IF EXISTS clip_overlays_style_check;

UPDATE clip_overlays o SET sv = (
  SELECT jsonb_build_object(
    'fs',       coalesce((p.config->>'fs')::numeric, 40),
    'ol',       0,
    'vp',       CASE o.position WHEN 'top' THEN 20
                                WHEN 'center' THEN 50
                                ELSE 76 END,
    'wpl',      NULL,
    'color',    coalesce(p.config->>'color', '#FFFFFF'),
    'bg',       CASE WHEN coalesce((p.config->>'box')::boolean, false)
                     THEN 'pill' ELSE 'none' END,
    'bg_color', coalesce(p.config->>'box_color', '#0A0B0D'),
    'bg_alpha', coalesce((p.config->>'box_alpha')::numeric, 0.75),
    'caps',     coalesce((p.config->>'uppercase')::boolean, false),
    'weight',   coalesce((p.config->>'weight')::numeric, 800)
  )
  FROM overlay_style_presets p WHERE p.key = o.style
)
WHERE o.sv IS NULL AND EXISTS
  (SELECT 1 FROM overlay_style_presets p WHERE p.key = o.style);

COMMIT;
