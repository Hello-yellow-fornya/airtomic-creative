-- 0023: new variants default to a 9:16-only export set (the mock's
-- "Default 9:16 only") — extra ratios are opted into per variant.
-- Existing rows keep whatever set they already have.
ALTER TABLE clip_variants ALTER COLUMN export_ratios SET DEFAULT '{9x16}';
