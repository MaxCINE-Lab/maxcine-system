-- Convert factory photos from fixed typed slots to a simple append-only photo
-- gallery. photo_type is retained only for backward compatibility with rows
-- created by the first skeleton implementation; the new UI/API no longer asks
-- users to classify photos.

CREATE TABLE IF NOT EXISTS asset_factory_photos_v2 (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  photo_type TEXT,
  object_key TEXT NOT NULL,
  original_filename TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT '',
  file_size INTEGER NOT NULL DEFAULT 0,
  remark TEXT NOT NULL DEFAULT '',
  uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

INSERT OR IGNORE INTO asset_factory_photos_v2 (
  id, asset_id, photo_type, object_key, original_filename, content_type,
  file_size, remark, uploaded_at, uploaded_by
)
SELECT
  id, asset_id, photo_type, object_key, original_filename, content_type,
  file_size, remark, uploaded_at, uploaded_by
FROM asset_factory_photos;

DROP TABLE asset_factory_photos;

ALTER TABLE asset_factory_photos_v2 RENAME TO asset_factory_photos;

CREATE INDEX IF NOT EXISTS idx_asset_factory_photos_asset
  ON asset_factory_photos(asset_id, uploaded_at DESC);
