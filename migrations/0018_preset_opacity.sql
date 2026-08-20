-- 0018: background opacity defaults per overlay preset.
-- Opacity lives on the overlay (sv.bg_alpha) and burns as the alpha byte
-- on BackColour; presets only seed it. Hook 70%, Caption 0% (geometry
-- kept, visually background-less), CTA 100%.

BEGIN;
UPDATE overlay_style_presets SET config = jsonb_set(config, '{box_alpha}', '0.7')  WHERE key = 'hook';
UPDATE overlay_style_presets SET config = jsonb_set(config, '{box_alpha}', '0.0')  WHERE key = 'caption';
UPDATE overlay_style_presets SET config = jsonb_set(config, '{box_alpha}', '1.0')  WHERE key = 'cta';
COMMIT;
