-- Customer Risk Center V1.
-- Shared dealer risk records for MaxCINE Mavic 4 Pro anamorphic lens sales.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  recipient_name TEXT NOT NULL DEFAULT '',
  platform_nickname TEXT NOT NULL DEFAULT '',
  wechat_nickname TEXT NOT NULL DEFAULT '',
  qq_nickname TEXT NOT NULL DEFAULT '',
  telegram TEXT NOT NULL DEFAULT '',
  whatsapp TEXT NOT NULL DEFAULT '',
  shipping_address TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS customer_contacts (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  contact_type TEXT NOT NULL CHECK (contact_type IN ('name','phone','recipient_name','platform_nickname','wechat','qq','telegram','whatsapp','address','city','keyword')),
  contact_value TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (customer_id, contact_type, normalized_value)
);

CREATE TABLE IF NOT EXISTS customer_risk_profiles (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL UNIQUE REFERENCES customers(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'watchlist' CHECK (status IN ('normal','watchlist','risk','blacklist')),
  risk_level TEXT NOT NULL DEFAULT 'medium' CHECK (risk_level IN ('low','medium','high')),
  risk_reasons_json TEXT NOT NULL DEFAULT '[]',
  other_reason TEXT NOT NULL DEFAULT '',
  first_registered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_registered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  registration_count INTEGER NOT NULL DEFAULT 0,
  involved_dealer_count INTEGER NOT NULL DEFAULT 0,
  consultation_count INTEGER NOT NULL DEFAULT 0,
  deal_count INTEGER NOT NULL DEFAULT 0,
  no_deal_count INTEGER NOT NULL DEFAULT 0,
  last_consulted_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS customer_risk_events (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  dealer_id TEXT REFERENCES dealers(id) ON DELETE SET NULL,
  store_id TEXT REFERENCES stores(id) ON DELETE SET NULL,
  product_scope TEXT NOT NULL DEFAULT 'MAVIC_4_PRO_ANAMORPHIC' CHECK (product_scope IN ('MAVIC_4_PRO_ANAMORPHIC','POCKET','ND','OTHER')),
  event_type TEXT NOT NULL DEFAULT 'consultation',
  consultation_result TEXT NOT NULL DEFAULT '未成交' CHECK (consultation_result IN ('成交','未成交','跟进中','未知')),
  status TEXT NOT NULL DEFAULT 'watchlist' CHECK (status IN ('normal','watchlist','risk','blacklist')),
  risk_level TEXT NOT NULL DEFAULT 'medium' CHECK (risk_level IN ('low','medium','high')),
  risk_reasons_json TEXT NOT NULL DEFAULT '[]',
  other_reason TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  happened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_customer_contacts_lookup ON customer_contacts(contact_type, normalized_value);
CREATE INDEX IF NOT EXISTS idx_customer_contacts_customer ON customer_contacts(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_risk_profiles_status ON customer_risk_profiles(status, risk_level, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_risk_events_customer ON customer_risk_events(customer_id, happened_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_risk_events_dealer ON customer_risk_events(dealer_id, happened_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_risk_events_creator ON customer_risk_events(created_by, updated_at DESC);

INSERT OR IGNORE INTO permissions (code, name, description) VALUES
  ('customer-risk:read', '查询客户风控', '查询共享客户风险档案和咨询历史'),
  ('customer-risk:create', '登记客户风控', '新增客户风险记录和咨询记录'),
  ('customer-risk:update-own', '编辑本人风控记录', '编辑本人创建的客户风险咨询记录'),
  ('customer-risk:manage', '管理客户风控', '管理全部客户风控档案和记录');

INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT id, 'customer-risk:read' FROM roles WHERE code IN ('super_admin','dealer');
INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT id, 'customer-risk:create' FROM roles WHERE code IN ('super_admin','dealer');
INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT id, 'customer-risk:update-own' FROM roles WHERE code IN ('super_admin','dealer');
INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT id, 'customer-risk:manage' FROM roles WHERE code = 'super_admin';
