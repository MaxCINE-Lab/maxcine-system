ALTER TABLE orders ADD COLUMN package_materials TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN fulfillment_carrier TEXT NOT NULL DEFAULT '顺丰速运';
ALTER TABLE orders ADD COLUMN fulfillment_tracking_number TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN fulfillment_updated_at TEXT;
ALTER TABLE orders ADD COLUMN fulfillment_updated_by TEXT REFERENCES users(id) ON DELETE SET NULL;
