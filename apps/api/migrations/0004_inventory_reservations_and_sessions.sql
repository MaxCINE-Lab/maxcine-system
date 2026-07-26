-- Available stock and reserved stock are maintained independently.
ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN password_changed_at TEXT;
ALTER TABLE orders ADD COLUMN review_note TEXT NOT NULL DEFAULT '';
ALTER TABLE inventory ADD COLUMN reserved_quantity INTEGER NOT NULL DEFAULT 0 CHECK (reserved_quantity >= 0);

DROP TRIGGER IF EXISTS inventory_transaction_guard;
DROP TRIGGER IF EXISTS inventory_transaction_product_match;
DROP TRIGGER IF EXISTS inventory_transaction_apply;
DROP TRIGGER IF EXISTS inventory_no_direct_quantity_update;

ALTER TABLE inventory_transactions RENAME TO inventory_transactions_legacy;
CREATE TABLE inventory_transactions (
  id TEXT PRIMARY KEY,
  inventory_id TEXT NOT NULL REFERENCES inventory(id) ON DELETE RESTRICT,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  order_id TEXT REFERENCES orders(id) ON DELETE RESTRICT,
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('opening_balance','inbound','order_reserved','order_released','order_shipped','adjustment','return')),
  quantity_delta INTEGER NOT NULL,
  reserved_delta INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  CHECK (quantity_delta <> 0 OR reserved_delta <> 0)
);
INSERT INTO inventory_transactions (id, inventory_id, product_id, order_id, transaction_type, quantity_delta, reserved_delta, note, created_at, created_by)
  SELECT id, inventory_id, product_id, order_id, transaction_type, quantity_delta,
    CASE WHEN transaction_type = 'order_reserved' THEN -quantity_delta WHEN transaction_type = 'order_released' THEN -quantity_delta ELSE 0 END,
    note, created_at, created_by
  FROM inventory_transactions_legacy;
DROP TABLE inventory_transactions_legacy;
CREATE INDEX IF NOT EXISTS idx_inventory_transactions_inventory ON inventory_transactions(inventory_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_transactions_order ON inventory_transactions(order_id, created_at DESC);

UPDATE inventory
SET reserved_quantity = COALESCE((
  SELECT SUM(order_items.quantity) FROM order_items JOIN orders ON orders.id = order_items.order_id
  WHERE order_items.product_id = inventory.product_id AND orders.status IN ('approved', 'picking', 'packed')
), 0);

CREATE TRIGGER inventory_no_direct_quantity_update
BEFORE UPDATE OF quantity, reserved_quantity ON inventory FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM inventory_write_guards WHERE inventory_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'Inventory may only change through inventory transactions');
END;

CREATE TRIGGER inventory_transaction_guard
BEFORE INSERT ON inventory_transactions FOR EACH ROW
BEGIN
  INSERT INTO inventory_write_guards (inventory_id) VALUES (NEW.inventory_id);
END;

CREATE TRIGGER inventory_transaction_product_match
BEFORE INSERT ON inventory_transactions FOR EACH ROW
WHEN (SELECT product_id FROM inventory WHERE id = NEW.inventory_id) != NEW.product_id
BEGIN
  SELECT RAISE(ABORT, 'Inventory transaction product does not match inventory record');
END;

CREATE TRIGGER inventory_transaction_apply
AFTER INSERT ON inventory_transactions FOR EACH ROW
BEGIN
  UPDATE inventory
  SET quantity = quantity + NEW.quantity_delta,
      reserved_quantity = reserved_quantity + CASE
        WHEN NEW.transaction_type = 'order_reserved' AND NEW.reserved_delta = 0 THEN -NEW.quantity_delta
        WHEN NEW.transaction_type = 'order_released' AND NEW.reserved_delta = 0 THEN -NEW.quantity_delta
        ELSE NEW.reserved_delta END,
      updated_by = NEW.created_by
  WHERE id = NEW.inventory_id;
  SELECT CASE WHEN (SELECT quantity FROM inventory WHERE id = NEW.inventory_id) < 0 OR (SELECT reserved_quantity FROM inventory WHERE id = NEW.inventory_id) < 0
    THEN RAISE(ABORT, 'Inventory cannot be negative') END;
  DELETE FROM inventory_write_guards WHERE inventory_id = NEW.inventory_id;
END;
