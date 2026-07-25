PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS dealers (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','dealer','warehouse')),
  dealer_id TEXT REFERENCES dealers(id) ON DELETE SET NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT,
  updated_by TEXT,
  CHECK ((role = 'dealer' AND dealer_id IS NOT NULL) OR role != 'dealer')
);

CREATE TABLE IF NOT EXISTS stores (
  id TEXT PRIMARY KEY,
  dealer_id TEXT NOT NULL REFERENCES dealers(id) ON DELETE RESTRICT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  image_key TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS inventory (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL UNIQUE REFERENCES products(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  reorder_level INTEGER NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  order_no TEXT NOT NULL UNIQUE,
  dealer_id TEXT NOT NULL REFERENCES dealers(id) ON DELETE RESTRICT,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected','picking','packed','shipped','delivered','cancelled')),
  note TEXT NOT NULL DEFAULT '',
  total_cents INTEGER NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  submitted_at TEXT,
  reviewed_at TEXT,
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  product_name_snapshot TEXT NOT NULL,
  sku_snapshot TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(order_id, product_id)
);

CREATE TABLE IF NOT EXISTS shipments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  carrier TEXT NOT NULL DEFAULT 'SF Express',
  tracking_number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'shipped' CHECK (status IN ('shipped','delivered','exception')),
  shipped_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS serial_numbers (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  serial_number TEXT NOT NULL COLLATE NOCASE UNIQUE,
  state TEXT NOT NULL DEFAULT 'available' CHECK (state IN ('available','allocated','shipped','returned','blocked')),
  order_item_id TEXT REFERENCES order_items(id) ON DELETE SET NULL,
  shipment_id TEXT REFERENCES shipments(id) ON DELETE SET NULL,
  bound_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  CHECK ((state IN ('allocated','shipped')) = (order_item_id IS NOT NULL)),
  CHECK (state != 'shipped' OR shipment_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS inventory_transactions (
  id TEXT PRIMARY KEY,
  inventory_id TEXT NOT NULL REFERENCES inventory(id) ON DELETE RESTRICT,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  order_id TEXT REFERENCES orders(id) ON DELETE RESTRICT,
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('opening_balance','order_reserved','order_released','adjustment','return')),
  quantity_delta INTEGER NOT NULL CHECK (quantity_delta <> 0),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT
);

-- Internal trigger guard; it is not exposed through the application API.
CREATE TABLE IF NOT EXISTS inventory_write_guards (
  inventory_id TEXT PRIMARY KEY REFERENCES inventory(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS after_sales_cases (
  id TEXT PRIMARY KEY,
  case_no TEXT NOT NULL UNIQUE,
  dealer_id TEXT NOT NULL REFERENCES dealers(id) ON DELETE RESTRICT,
  order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
  subject TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  dealer_id TEXT REFERENCES dealers(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  link TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (user_id IS NOT NULL OR dealer_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  request_id TEXT NOT NULL,
  ip_hash TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id TEXT PRIMARY KEY,
  identifier_hash TEXT NOT NULL,
  attempted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  succeeded INTEGER NOT NULL DEFAULT 0 CHECK (succeeded IN (0,1))
);

CREATE INDEX IF NOT EXISTS idx_users_dealer ON users(dealer_id);
CREATE INDEX IF NOT EXISTS idx_stores_dealer ON stores(dealer_id);
CREATE INDEX IF NOT EXISTS idx_orders_dealer_status ON orders(dealer_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_serials_order_item ON serial_numbers(order_item_id);
CREATE INDEX IF NOT EXISTS idx_inventory_transactions_inventory ON inventory_transactions(inventory_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_dealer_unread ON notifications(dealer_id, read_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_attempts_identifier ON login_attempts(identifier_hash, attempted_at DESC);

CREATE TRIGGER IF NOT EXISTS inventory_updated_at
AFTER UPDATE ON inventory FOR EACH ROW
BEGIN
  UPDATE inventory SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS inventory_no_direct_quantity_update
BEFORE UPDATE OF quantity ON inventory FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM inventory_write_guards WHERE inventory_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'Inventory quantity may only change through inventory transactions');
END;

CREATE TRIGGER IF NOT EXISTS inventory_transaction_guard
BEFORE INSERT ON inventory_transactions FOR EACH ROW
BEGIN
  INSERT INTO inventory_write_guards (inventory_id) VALUES (NEW.inventory_id);
END;

CREATE TRIGGER IF NOT EXISTS inventory_transaction_product_match
BEFORE INSERT ON inventory_transactions FOR EACH ROW
WHEN (SELECT product_id FROM inventory WHERE id = NEW.inventory_id) != NEW.product_id
BEGIN
  SELECT RAISE(ABORT, 'Inventory transaction product does not match inventory record');
END;

CREATE TRIGGER IF NOT EXISTS inventory_transaction_apply
AFTER INSERT ON inventory_transactions FOR EACH ROW
BEGIN
  UPDATE inventory
  SET quantity = quantity + NEW.quantity_delta, updated_by = NEW.created_by
  WHERE id = NEW.inventory_id;
  SELECT CASE WHEN (SELECT quantity FROM inventory WHERE id = NEW.inventory_id) < 0
    THEN RAISE(ABORT, 'Inventory cannot be negative') END;
  DELETE FROM inventory_write_guards WHERE inventory_id = NEW.inventory_id;
END;
