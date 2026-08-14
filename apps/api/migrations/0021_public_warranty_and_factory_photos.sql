PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS asset_public_warranties (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL UNIQUE REFERENCES assets(id) ON DELETE CASCADE,
  serial_number_snapshot TEXT NOT NULL COLLATE NOCASE,
  product_name_snapshot TEXT NOT NULL DEFAULT '',
  product_version_snapshot TEXT NOT NULL DEFAULT '',
  public_warranty_start_date TEXT,
  public_warranty_end_date TEXT,
  public_warranty_status TEXT NOT NULL DEFAULT 'auto' CHECK (public_warranty_status IN ('auto','pending','active','expired','no_warranty','blocked','hidden','unknown')),
  public_note TEXT NOT NULL DEFAULT '',
  is_public_query_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_public_query_enabled IN (0,1)),
  initialized_from_order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
  initialized_from_shipment_id TEXT REFERENCES shipments(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_public_warranty_lookup
  ON asset_public_warranties(serial_number_snapshot COLLATE NOCASE, is_public_query_enabled);
CREATE INDEX IF NOT EXISTS idx_public_warranty_asset ON asset_public_warranties(asset_id);

CREATE TABLE IF NOT EXISTS asset_factory_photos (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  photo_type TEXT NOT NULL CHECK (photo_type IN ('front','back','sn_plate','package','other')),
  object_key TEXT NOT NULL,
  original_filename TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT '',
  file_size INTEGER NOT NULL DEFAULT 0,
  remark TEXT NOT NULL DEFAULT '',
  uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(asset_id, photo_type)
);

CREATE INDEX IF NOT EXISTS idx_asset_factory_photos_asset ON asset_factory_photos(asset_id, photo_type);

CREATE TABLE IF NOT EXISTS public_warranty_challenges (
  id TEXT PRIMARY KEY,
  token_hash TEXT,
  completed_at TEXT,
  used_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ip_hash TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_public_warranty_challenges_expiry ON public_warranty_challenges(expires_at, used_at);
