-- Delivery needs its own timestamp and a customer-held location, not a warehouse.
ALTER TABLE orders ADD COLUMN delivered_at TEXT;

CREATE TABLE asset_locations_delivery (
  asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  warehouse_id TEXT REFERENCES warehouses(id) ON DELETE RESTRICT,
  location_id TEXT REFERENCES warehouse_locations(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'on_hand' CHECK (status IN ('on_hand','reserved','in_transit','shipped','returned','delivered')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  custody TEXT NOT NULL DEFAULT 'WAREHOUSE' CHECK (custody IN ('WAREHOUSE','IN_TRANSIT','CUSTOMER','SERVICE_CENTER','RETURN_TRANSIT')),
  CHECK (custody <> 'WAREHOUSE' OR warehouse_id IS NOT NULL)
);
INSERT INTO asset_locations_delivery SELECT asset_id, warehouse_id, location_id, status, updated_at, updated_by, custody FROM asset_locations;
DROP TABLE asset_locations;
ALTER TABLE asset_locations_delivery RENAME TO asset_locations;
CREATE INDEX idx_asset_locations_warehouse ON asset_locations(warehouse_id, status);

INSERT INTO permissions (code, name, description) VALUES ('international-order:deliver', '确认客户送达', '确认已授权 UK 订单送达，不激活保修');
INSERT INTO role_permissions (role_id, permission_code)
  SELECT id, 'international-order:deliver' FROM roles WHERE code IN ('super_admin','international_operator','uk_fulfilment_operator');
