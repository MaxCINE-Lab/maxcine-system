-- Per-user employee watermark preference. Existing and newly created users
-- default to enabled so current accountability markings remain unchanged.
ALTER TABLE users
  ADD COLUMN watermark_enabled INTEGER NOT NULL DEFAULT 1
  CHECK (watermark_enabled IN (0, 1));
