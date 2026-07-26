-- GSX asset and warranty center. Historical Excel values are retained in import
-- snapshots, while lifecycle events and notes remain extensible rather than
-- becoming fixed columns on the asset record.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  current_sn TEXT COLLATE NOCASE,
  original_sn TEXT,
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  product_name_snapshot TEXT NOT NULL DEFAULT '',
  version_snapshot TEXT NOT NULL DEFAULT '',
  asset_status TEXT NOT NULL DEFAULT 'active' CHECK (asset_status IN ('active','in_service','refurbished','returned_to_inventory','resold','scrapped','unknown')),
  warranty_policy TEXT NOT NULL DEFAULT 'standard' CHECK (warranty_policy IN ('standard','extended','none','unknown')),
  warranty_start_at TEXT,
  warranty_end_at TEXT,
  warranty_override_status TEXT CHECK (warranty_override_status IN ('no_warranty','denied','exception','cancelled','scrapped')),
  warranty_override_reason TEXT NOT NULL DEFAULT '',
  source_channel TEXT NOT NULL DEFAULT '',
  shipping_warehouse TEXT NOT NULL DEFAULT '',
  dealer_id TEXT REFERENCES dealers(id) ON DELETE SET NULL,
  store_id TEXT REFERENCES stores(id) ON DELETE SET NULL,
  latest_order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
  data_quality_status TEXT NOT NULL DEFAULT 'normal' CHECK (data_quality_status IN ('normal','warning','duplicate_identifier','invalid_identifier','missing_identifier')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

-- Normalized, verified current SN values must stay unique. Historical duplicate
-- and malformed labels deliberately remain importable and are flagged instead.
CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_verified_current_sn
  ON assets(current_sn COLLATE NOCASE)
  WHERE current_sn IS NOT NULL AND data_quality_status = 'normal';
CREATE INDEX IF NOT EXISTS idx_assets_scope ON assets(dealer_id, store_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_assets_warranty ON assets(warranty_end_at, warranty_override_status);
CREATE INDEX IF NOT EXISTS idx_assets_quality ON assets(data_quality_status, updated_at DESC);

CREATE TABLE IF NOT EXISTS asset_identifiers (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  identifier_type TEXT NOT NULL CHECK (identifier_type IN ('current_sn','original_sn','replacement_sn','legacy_sn','duplicate_label','invalid_label','temporary_internal')),
  identifier_value TEXT NOT NULL COLLATE NOCASE,
  is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0,1)),
  valid_from TEXT,
  valid_to TEXT,
  reason TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_asset_identifiers_lookup ON asset_identifiers(identifier_value COLLATE NOCASE, is_current);
CREATE INDEX IF NOT EXISTS idx_asset_identifiers_asset ON asset_identifiers(asset_id, created_at DESC);

CREATE TABLE IF NOT EXISTS asset_import_batches (
  id TEXT PRIMARY KEY,
  source_filename TEXT NOT NULL,
  source_file_fingerprint TEXT NOT NULL UNIQUE,
  source_sheet TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('prepared','completed','completed_with_skips')),
  total_rows INTEGER NOT NULL DEFAULT 0,
  normal_rows INTEGER NOT NULL DEFAULT 0,
  warning_rows INTEGER NOT NULL DEFAULT 0,
  error_rows INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  confirmed_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  confirmed_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS asset_import_rows (
  id TEXT PRIMARY KEY,
  import_batch_id TEXT NOT NULL REFERENCES asset_import_batches(id) ON DELETE CASCADE,
  source_row_number INTEGER NOT NULL,
  raw_json TEXT NOT NULL,
  normalized_json TEXT NOT NULL,
  issues_json TEXT NOT NULL DEFAULT '[]',
  disposition TEXT NOT NULL DEFAULT 'pending' CHECK (disposition IN ('pending','imported','skipped')),
  imported_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  imported_at TEXT,
  UNIQUE(import_batch_id, source_row_number)
);
CREATE INDEX IF NOT EXISTS idx_asset_import_rows_batch ON asset_import_rows(import_batch_id, source_row_number);

CREATE TABLE IF NOT EXISTS asset_sales (
  id TEXT PRIMARY KEY,
  import_batch_id TEXT REFERENCES asset_import_batches(id) ON DELETE SET NULL,
  source_row_number INTEGER,
  source_channel TEXT NOT NULL DEFAULT '',
  purchase_date TEXT,
  purchase_date_annotation TEXT NOT NULL DEFAULT '',
  purchase_price_raw TEXT NOT NULL DEFAULT '',
  unit_price_cents INTEGER,
  quantity INTEGER,
  total_price_cents INTEGER,
  payment_status TEXT NOT NULL DEFAULT 'unknown' CHECK (payment_status IN ('received','shipped','unknown')),
  payment_amount_cents INTEGER,
  payment_raw TEXT NOT NULL DEFAULT '',
  tracking_number TEXT,
  shipping_warehouse TEXT NOT NULL DEFAULT '',
  raw_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(import_batch_id, source_row_number)
);
CREATE INDEX IF NOT EXISTS idx_asset_sales_tracking ON asset_sales(tracking_number);
CREATE INDEX IF NOT EXISTS idx_asset_sales_channel ON asset_sales(source_channel, purchase_date DESC);

CREATE TABLE IF NOT EXISTS asset_sale_assets (
  sale_id TEXT NOT NULL REFERENCES asset_sales(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (sale_id, asset_id)
);
CREATE INDEX IF NOT EXISTS idx_asset_sale_assets_asset ON asset_sale_assets(asset_id, sale_id);

CREATE TABLE IF NOT EXISTS asset_events (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('imported','sold','shipped','warranty_started','warranty_extended','warranty_cancelled','warranty_denied','service_received','inspection_started','inspection_completed','repaired','replaced','refurbished','sn_changed','returned_to_inventory','resold','scrapped','note_added')),
  occurred_at TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  related_order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
  related_service_case_id TEXT REFERENCES after_sales_cases(id) ON DELETE SET NULL,
  sale_id TEXT REFERENCES asset_sales(id) ON DELETE SET NULL,
  old_value_json TEXT,
  new_value_json TEXT,
  operator_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  visibility TEXT NOT NULL DEFAULT 'admin_private' CHECK (visibility IN ('admin_private','service_center','dealer','customer_safe')),
  source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_asset_events_timeline ON asset_events(asset_id, occurred_at DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_asset_events_service_case ON asset_events(related_service_case_id, created_at DESC);

CREATE TABLE IF NOT EXISTS asset_notes (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('general','customer_service','warranty_risk','data_quality','finance','private_admin')),
  content TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'admin_private' CHECK (visibility IN ('admin_private','service_center','dealer','customer_safe')),
  source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_asset_notes_asset ON asset_notes(asset_id, visibility, created_at DESC);

-- A warranty case is the existing after-sales case; this link keeps historical
-- and newly created service records in one workflow rather than duplicating it.
ALTER TABLE after_sales_cases ADD COLUMN asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_after_sales_asset ON after_sales_cases(asset_id, created_at DESC);

INSERT OR IGNORE INTO permissions (code, name, description) VALUES
  ('asset:read', '查看资产与保修', '查看授权范围内的资产、保修和生命周期信息'),
  ('asset:manage', '管理资产与保修', '处理保修人工覆盖和资产数据异常'),
  ('asset:import', '导入历史保修数据', '预检查并导入历史保修数据'),
  ('asset:warehouse-read', '查看仓库资产信息', '查看履约所需的产品、SN 和仓库信息');

INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT id, 'asset:read' FROM roles WHERE code IN ('super_admin', 'dealer', 'authorized_service_center');
INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT id, 'asset:manage' FROM roles WHERE code = 'super_admin';
INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT id, 'asset:import' FROM roles WHERE code = 'super_admin';
INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT id, 'asset:warehouse-read' FROM roles WHERE code IN ('super_admin', 'warehouse_manager');
