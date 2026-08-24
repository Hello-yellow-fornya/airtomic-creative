-- 0021: background corner radius per text target (0-40px at 1080 width),
-- stored resolved in sv like every other style value. Preset defaults:
-- Hook 8, Caption 4, CTA 6 — the old pill was far too round for ad
-- creative. The worker burns the background as a \p1 rounded-rect
-- drawing behind the text (BorderStyle 3 has no radius and seams
-- between lines).

BEGIN;
UPDATE overlay_style_presets SET config = jsonb_set(config, '{radius}', '8') WHERE key = 'hook';
UPDATE overlay_style_presets SET config = jsonb_set(config, '{radius}', '4') WHERE key = 'caption';
UPDATE overlay_style_presets SET config = jsonb_set(config, '{radius}', '6') WHERE key = 'cta';
UPDATE clip_overlays SET sv = jsonb_set(sv, '{radius}', '8')
 WHERE sv IS NOT NULL AND NOT sv ? 'radius';
COMMIT;
