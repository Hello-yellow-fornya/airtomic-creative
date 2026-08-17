-- Default subtitle presets, mirroring docs/prototype.html.
-- config keys: font, fs (base px at 1080w), ol (outline px), vp (vertical
-- position % from top), wpl (max words per line), hl (active-word colour),
-- caps (uppercase), box (background box).

INSERT INTO subtitle_presets (name, is_default, config) VALUES
('Klira', true,  '{"font":"DejaVu Sans","fs":30,"ol":3,"vp":72,"wpl":4,"hl":"#FFC629","caps":false,"box":false}'),
('Bold',  false, '{"font":"DejaVu Sans","fs":40,"ol":5,"vp":66,"wpl":3,"hl":"#4ED6A1","caps":true,"box":false}'),
('Clean', false, '{"font":"DejaVu Sans","fs":24,"ol":0,"vp":80,"wpl":6,"hl":"#FFFFFF","caps":false,"box":true}');
