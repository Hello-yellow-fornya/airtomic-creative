-- 0019: the ratio tabs are the variant's EXPORT SET, stored per variant.
-- Removed ratios don't render or export. Default stays the full set so
-- existing variants keep their current behaviour.

ALTER TABLE clip_variants
  ADD COLUMN export_ratios text[] NOT NULL DEFAULT '{9x16,4x5,1x1,1.91x1}';
