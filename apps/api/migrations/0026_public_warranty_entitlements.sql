PRAGMA foreign_keys = ON;

ALTER TABLE asset_public_warranties
  ADD COLUMN public_product_name TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS asset_public_warranty_entitlements (
  id TEXT PRIMARY KEY,
  public_warranty_id TEXT NOT NULL REFERENCES asset_public_warranties(id) ON DELETE CASCADE,
  entitlement_type TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0,1)),
  is_public INTEGER NOT NULL DEFAULT 1 CHECK (is_public IN (0,1)),
  date_mode TEXT NOT NULL DEFAULT 'inherit' CHECK (date_mode IN ('inherit','custom')),
  start_date TEXT,
  end_date TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(public_warranty_id, entitlement_type)
);

CREATE INDEX IF NOT EXISTS idx_public_warranty_entitlements_warranty
  ON asset_public_warranty_entitlements(public_warranty_id, is_enabled, is_public);
