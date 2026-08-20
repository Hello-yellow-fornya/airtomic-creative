-- 0016: clips survive source deletion as orphans.
--
-- Deleting a source no longer takes its clips with it: video_id becomes
-- nullable and the FK switches CASCADE -> SET NULL. Orphaned variants
-- render read-only in the builder (no source to edit against) but their
-- finished exports in R2 remain downloadable, and they can be deleted.

BEGIN;

ALTER TABLE clips ALTER COLUMN video_id DROP NOT NULL;
ALTER TABLE clips DROP CONSTRAINT clips_video_id_fkey;
ALTER TABLE clips
  ADD CONSTRAINT clips_video_id_fkey
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE SET NULL;

COMMIT;
