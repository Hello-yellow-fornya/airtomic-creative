-- Structured metadata parsed from ad and video-asset names (worker/adnames.py):
-- funnel stage, theme/talent, hook variant, format, launch date from the ad
-- name; rendition ratio and concept stem from the video filename. Parsed at
-- import, stored raw-alongside — never inferred by a vision call.
ALTER TABLE ad_performance ADD COLUMN IF NOT EXISTS name_parts jsonb;
