-- Library tidy-up: content hashes for dedupe, and a meta-id link table so
-- merging duplicate sources can repoint performance joins.

-- sha256 of the source file, computed on ingest; backfilled for existing
-- rows by the worker's hash_backfill job (R2 single-part ETags are md5 —
-- usable for grouping — but we standardise on sha256 so the column means
-- one thing).
ALTER TABLE videos ADD COLUMN IF NOT EXISTS content_hash text;
CREATE INDEX IF NOT EXISTS idx_videos_hash ON videos (content_hash)
    WHERE content_hash IS NOT NULL;

-- ad_performance keys on meta_video_id. A merged duplicate's meta ids must
-- keep resolving to the surviving video, so the app-level join goes
-- through this table instead of videos.meta_video_id directly.
CREATE TABLE video_meta_links (
    meta_video_id  text PRIMARY KEY,
    video_id       uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_meta_links_video ON video_meta_links (video_id);

INSERT INTO video_meta_links (meta_video_id, video_id)
SELECT meta_video_id, id FROM videos WHERE meta_video_id IS NOT NULL
ON CONFLICT (meta_video_id) DO NOTHING;
