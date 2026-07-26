-- RBAC and scope model. The legacy users.role/users.dealer_id columns remain only
-- for backward-compatible reads of pre-0003 databases; application authorization
-- must use the relationship tables below.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS permissions (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code TEXT NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  assigned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, role_id)
);

-- Dealer qualification is independent from service-center qualification.
CREATE TABLE IF NOT EXISTS dealer_user_assignments (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dealer_id TEXT NOT NULL REFERENCES dealers(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  assigned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, dealer_id)
);

CREATE TABLE IF NOT EXISTS service_centers (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  province TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS service_center_user_assignments (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service_center_id TEXT NOT NULL REFERENCES service_centers(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  assigned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, service_center_id)
);

ALTER TABLE dealers ADD COLUMN province TEXT NOT NULL DEFAULT '';
ALTER TABLE stores ADD COLUMN platform TEXT NOT NULL DEFAULT '未标注';
ALTER TABLE stores ADD COLUMN owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;

-- Store access is the data-isolation boundary for dealer accounts.
CREATE TABLE IF NOT EXISTS store_user_assignments (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  access_level TEXT NOT NULL DEFAULT 'member' CHECK (access_level IN ('owner','manager','member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  assigned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, store_id)
);

CREATE TABLE IF NOT EXISTS system_email_accounts (
  address TEXT PRIMARY KEY COLLATE NOCASE CHECK (address = lower(address)),
  purpose TEXT NOT NULL,
  accepts_replies INTEGER NOT NULL CHECK (accepts_replies IN (0,1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  environment TEXT NOT NULL DEFAULT 'local' CHECK (environment IN ('local','staging','production')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE notifications ADD COLUMN store_id TEXT REFERENCES stores(id) ON DELETE CASCADE;
ALTER TABLE after_sales_cases ADD COLUMN workflow_stage TEXT NOT NULL DEFAULT 'open'
  CHECK (workflow_stage IN ('open','received','assessed','recommended','approved','rejected','closed'));

CREATE TABLE IF NOT EXISTS after_sales_assignments (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL UNIQUE REFERENCES after_sales_cases(id) ON DELETE CASCADE,
  service_center_id TEXT NOT NULL REFERENCES service_centers(id) ON DELETE RESTRICT,
  assigned_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS after_sales_assessments (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES after_sales_cases(id) ON DELETE CASCADE,
  result TEXT NOT NULL,
  details TEXT NOT NULL,
  assessed_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  assessed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS after_sales_recommendations (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES after_sales_cases(id) ON DELETE CASCADE,
  recommendation TEXT NOT NULL,
  details TEXT NOT NULL,
  recommended_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  recommended_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS after_sales_approvals (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES after_sales_cases(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('approved','rejected')),
  note TEXT NOT NULL DEFAULT '',
  approved_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions(role_id);
CREATE INDEX IF NOT EXISTS idx_dealer_user_assignments_user ON dealer_user_assignments(user_id, dealer_id);
CREATE INDEX IF NOT EXISTS idx_service_center_user_assignments_user ON service_center_user_assignments(user_id, service_center_id);
CREATE INDEX IF NOT EXISTS idx_store_user_assignments_user ON store_user_assignments(user_id, store_id);
CREATE INDEX IF NOT EXISTS idx_notifications_store_unread ON notifications(store_id, read_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_after_sales_assignments_center ON after_sales_assignments(service_center_id, case_id);
CREATE INDEX IF NOT EXISTS idx_after_sales_assessments_case ON after_sales_assessments(case_id, assessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_after_sales_recommendations_case ON after_sales_recommendations(case_id, recommended_at DESC);
CREATE INDEX IF NOT EXISTS idx_after_sales_approvals_case ON after_sales_approvals(case_id, approved_at DESC);

-- Existing accounts were already case-insensitive. These guards make lowercase
-- storage explicit for all accounts created after the RBAC migration.
UPDATE users SET email = lower(email) WHERE email <> lower(email);

CREATE TRIGGER IF NOT EXISTS users_email_must_be_lowercase_insert
BEFORE INSERT ON users FOR EACH ROW WHEN NEW.email <> lower(NEW.email)
BEGIN
  SELECT RAISE(ABORT, 'User email must be stored in lowercase');
END;

CREATE TRIGGER IF NOT EXISTS users_email_must_be_lowercase_update
BEFORE UPDATE OF email ON users FOR EACH ROW WHEN NEW.email <> lower(NEW.email)
BEGIN
  SELECT RAISE(ABORT, 'User email must be stored in lowercase');
END;
