-- Captions render in Inter — matches docs/prototype.html, whose sizing
-- decisions were made against it. The font is baked into the worker image
-- (fonts-inter).

UPDATE subtitle_presets SET config = jsonb_set(config, '{font}', '"Inter"');
