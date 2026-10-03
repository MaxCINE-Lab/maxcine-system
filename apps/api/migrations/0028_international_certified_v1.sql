-- International Certified Pre-Owned V1. Additive only; production must be applied
-- from staging first. Existing assets, serial_numbers, asset_events, orders and
-- after_sales_cases remain the system of record.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  default_route TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_workspaces (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  data_scope_json TEXT NOT NULL DEFAULT '{}',
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  assigned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS asset_inspection_tasks (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  assigned_to TEXT REFERENCES users(id) ON DELETE SET NULL,
  process_code TEXT NOT NULL DEFAULT 'certified-inspection',
  status TEXT NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','in_progress','completed','failed','cancelled')),
  result TEXT CHECK (result IN ('PASS','FAIL','ADVISORY','N/A')),
  grade TEXT CHECK (grade IN ('A','B','C','D')),
  final_qc INTEGER CHECK (final_qc IN (0,1)),
  notes TEXT NOT NULL DEFAULT '',
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS asset_inspection_evidence (
  id TEXT PRIMARY KEY,
  inspection_task_id TEXT NOT NULL REFERENCES asset_inspection_tasks(id) ON DELETE CASCADE,
  evidence_type TEXT NOT NULL CHECK (evidence_type IN ('photo','video','note','test_data')),
  object_key TEXT,
  content_text TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS asset_certifications (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL UNIQUE REFERENCES assets(id) ON DELETE RESTRICT,
  inspection_task_id TEXT NOT NULL REFERENCES asset_inspection_tasks(id) ON DELETE RESTRICT,
  grade TEXT NOT NULL CHECK (grade IN ('A','B','C','D')),
  inspection_result TEXT NOT NULL CHECK (inspection_result IN ('PASS','FAIL','ADVISORY','N/A')),
  final_qc INTEGER NOT NULL CHECK (final_qc IN (0,1)),
  certification_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  certification_status TEXT NOT NULL DEFAULT 'certified' CHECK (certification_status IN ('draft','certified','suspended','revoked')),
  warranty_reference TEXT NOT NULL DEFAULT '',
  verification_code_hash TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS warehouses (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  market_region TEXT NOT NULL CHECK (market_region IN ('CN','SG','UK','TRANSIT')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS warehouse_locations (
  id TEXT PRIMARY KEY,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  UNIQUE (warehouse_id, code)
);

CREATE TABLE IF NOT EXISTS asset_locations (
  asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  location_id TEXT REFERENCES warehouse_locations(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'on_hand' CHECK (status IN ('on_hand','reserved','in_transit','shipped','returned')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS asset_transfers (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  from_warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  to_warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','shipped','received','cancelled')),
  tracking_number TEXT,
  shipped_at TEXT,
  received_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS sales_channels (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1))
);

CREATE TABLE IF NOT EXISTS sales_accounts (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES sales_channels(id) ON DELETE RESTRICT,
  account_name TEXT NOT NULL,
  market_region TEXT NOT NULL CHECK (market_region IN ('CN','SG','UK')),
  external_account_id TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  UNIQUE (channel_id, account_name)
);

CREATE TABLE IF NOT EXISTS marketplace_listings (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL UNIQUE REFERENCES assets(id) ON DELETE RESTRICT,
  channel_id TEXT NOT NULL REFERENCES sales_channels(id) ON DELETE RESTRICT,
  sales_account_id TEXT NOT NULL REFERENCES sales_accounts(id) ON DELETE RESTRICT,
  external_listing_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'GBP',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','sold','ended')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS international_asset_allocations (
  asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE RESTRICT,
  order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
  listing_id TEXT REFERENCES marketplace_listings(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','released','fulfilled')),
  reserved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reserved_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

ALTER TABLE orders ADD COLUMN channel_id TEXT REFERENCES sales_channels(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN sales_account_id TEXT REFERENCES sales_accounts(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN external_order_id TEXT;
ALTER TABLE orders ADD COLUMN currency TEXT NOT NULL DEFAULT 'CNY';
ALTER TABLE orders ADD COLUMN fulfilment_warehouse_id TEXT REFERENCES warehouses(id) ON DELETE SET NULL;

ALTER TABLE after_sales_cases ADD COLUMN market_region TEXT NOT NULL DEFAULT 'CN';
ALTER TABLE after_sales_cases ADD COLUMN channel_id TEXT REFERENCES sales_channels(id) ON DELETE SET NULL;
ALTER TABLE after_sales_cases ADD COLUMN sales_account_id TEXT REFERENCES sales_accounts(id) ON DELETE SET NULL;
ALTER TABLE after_sales_cases ADD COLUMN return_warehouse_id TEXT REFERENCES warehouses(id) ON DELETE SET NULL;
ALTER TABLE after_sales_cases ADD COLUMN return_tracking TEXT NOT NULL DEFAULT '';
ALTER TABLE after_sales_cases ADD COLUMN return_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE after_sales_cases ADD COLUMN rma_reference TEXT;
ALTER TABLE after_sales_cases ADD COLUMN cross_border_resolution TEXT;

INSERT OR IGNORE INTO workspaces (id, code, name, default_route) VALUES
  ('ws-admin', 'ADMIN', '管理中心', '/system/admin'),
  ('ws-dealer', 'DEALER', '国内经销', '/system/dashboard'),
  ('ws-service', 'SERVICE', '服务中心', '/system/service-center'),
  ('ws-certified', 'CERTIFIED', 'Certified 检测', '/system/certified'),
  ('ws-international', 'INTERNATIONAL', '国际业务', '/system/international'),
  ('ws-uk-fulfilment', 'UK_FULFILMENT', '英国履约', '/system/uk-fulfilment');

INSERT OR IGNORE INTO warehouses (id, code, name, market_region) VALUES
  ('wh-cn-sd', 'CN-SD', '山东仓', 'CN'),
  ('wh-sg', 'SG', '新加坡仓', 'SG'),
  ('wh-uk', 'UK', '英国仓', 'UK'),
  ('wh-transit', 'TRANSIT', '在途', 'TRANSIT');

INSERT OR IGNORE INTO sales_channels (id, code, name) VALUES
  ('channel-ebay-uk', 'EBAY_UK', 'eBay UK'),
  ('channel-maxcine-web', 'MAXCINE_WEB', 'MaxCINE Website'),
  ('channel-carousell-sg', 'CAROUSELL_SG', 'Carousell SG');

INSERT OR IGNORE INTO roles (id, code, name, description) VALUES
  ('role-certified-operator', 'certified_operator', 'Certified 检测员', '仅处理已分配的 Certified 检测任务'),
  ('role-international-operator', 'international_operator', '国际业务专员', '处理国际认证、调拨、渠道和订单'),
  ('role-uk-fulfilment-operator', 'uk_fulfilment_operator', '英国履约专员', '处理 UK 库存、订单履约和 RMA');

INSERT OR IGNORE INTO permissions (code, name, description) VALUES
  ('workspace:read', '查看工作台', '查看已授权 Workspace 的导航与默认入口'),
  ('certified:read', '查看 Certified', '查看已授权范围内的检测任务、证据与认证'),
  ('certified:manage', '管理 Certified', '创建、完成检测任务并签发认证'),
  ('warehouse:international-read', '查看国际仓库', '查看已授权国际仓的单机资产位置'),
  ('transfer:manage', '管理国际调拨', '创建、发运和收货单机资产调拨'),
  ('marketplace:read', '查看海外渠道', '查看已授权渠道 Listing 与订单'),
  ('marketplace:manage', '管理海外渠道', '创建及更新海外渠道 Listing'),
  ('international-order:read', '查看国际订单', '查看已授权国际订单与资产绑定'),
  ('international-order:manage', '管理国际订单', '绑定资产、锁定库存及 UK 履约'),
  ('international-after-sales:read', '查看国际售后', '查看已授权市场的 RMA'),
  ('international-after-sales:manage', '管理国际售后', '处理 RMA、维修、换机及退款');

INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT roles.id, permissions.code FROM roles JOIN permissions
  WHERE roles.code = 'certified_operator' AND permissions.code IN ('workspace:read','certified:read','certified:manage','asset:read');
INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT roles.id, permissions.code FROM roles JOIN permissions
  WHERE roles.code = 'international_operator' AND permissions.code IN ('workspace:read','certified:read','certified:manage','warehouse:international-read','transfer:manage','marketplace:read','marketplace:manage','international-order:read','international-order:manage','international-after-sales:read','international-after-sales:manage','after-sales:create','after-sales:read','asset:read');
INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT roles.id, permissions.code FROM roles JOIN permissions
  WHERE roles.code = 'uk_fulfilment_operator' AND permissions.code IN ('workspace:read','warehouse:international-read','marketplace:read','international-order:read','international-order:manage','international-after-sales:read','international-after-sales:manage','after-sales:read','asset:warehouse-read');

CREATE INDEX IF NOT EXISTS idx_user_workspaces_user ON user_workspaces(user_id, is_default);
CREATE INDEX IF NOT EXISTS idx_inspection_tasks_assignee ON asset_inspection_tasks(assigned_to, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_inspection_tasks_asset ON asset_inspection_tasks(asset_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_asset_locations_warehouse ON asset_locations(warehouse_id, status);
CREATE INDEX IF NOT EXISTS idx_transfers_status ON asset_transfers(status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_transfers_one_active_per_asset ON asset_transfers(asset_id) WHERE status IN ('created','shipped');
CREATE INDEX IF NOT EXISTS idx_listings_channel_status ON marketplace_listings(channel_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_intl_orders_external ON orders(external_order_id);
