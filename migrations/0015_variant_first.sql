-- 0015: variant-first clip model.
--
-- Every row in the clip builder is now a clip_variant; the parent clip
-- persists only as the shared source range and grouping key. Subtitle
-- settings move to the variant so B can restyle captions without touching
-- A. clips.name stays in place as a legacy column (nothing reads or
-- writes it any more) so this migration is zero-downtime against the
-- previous deploy.

BEGIN;

ALTER TABLE clip_variants
  ADD COLUMN subtitle_preset_id uuid REFERENCES subtitle_presets(id) ON DELETE SET NULL,
  ADD COLUMN subtitle_overrides jsonb;

-- Every variant inherits the clip's subtitle settings it rendered with.
UPDATE clip_variants cv
SET subtitle_preset_id = c.subtitle_preset_id,
    subtitle_overrides = c.subtitle_overrides
FROM clips c WHERE c.id = cv.clip_id;

-- The clip's name (when one was set) becomes variant A's name; sibling
-- variants keep the names they already have. Approval state is untouched.
WITH firsts AS (
  SELECT DISTINCT ON (clip_id) id, clip_id
  FROM clip_variants ORDER BY clip_id, label
)
UPDATE clip_variants cv SET name = btrim(c.name)
FROM firsts f JOIN clips c ON c.id = f.clip_id
WHERE cv.id = f.id AND c.name IS NOT NULL AND btrim(c.name) <> '';

-- Names feed export filenames and ad-name parsing: no slashes, trimmed.
UPDATE clip_variants
SET name = btrim(replace(replace(name, '/', '-'), '\', '-'))
WHERE name LIKE '%/%' OR name LIKE '%\%' OR name <> btrim(name);

-- Names are unique within a source video. Existing collisions (seven
-- clips of the same video all carrying the seed name "Control") keep
-- their name and gain a positional suffix.
WITH dups AS (
  SELECT cv.id,
         row_number() OVER (
           PARTITION BY c.video_id, cv.name
           ORDER BY c.created_at, cv.label) AS rn
  FROM clip_variants cv JOIN clips c ON c.id = cv.clip_id
)
UPDATE clip_variants cv
SET name = cv.name || ' (' || d.rn || ')'
FROM dups d WHERE d.id = cv.id AND d.rn > 1;

COMMIT;
