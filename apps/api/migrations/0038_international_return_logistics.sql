-- Reverse logistics only. Preserve original sale, certification and warranties.
ALTER TABLE after_sales_cases ADD COLUMN return_shipped_at TEXT;
ALTER TABLE after_sales_cases ADD COLUMN return_received_at TEXT;
ALTER TABLE assets ADD COLUMN inventory_status TEXT NOT NULL DEFAULT 'NORMAL'
  CHECK (inventory_status IN ('NORMAL','QUARANTINED'));
INSERT INTO warehouse_locations (id, warehouse_id, code, name)
  VALUES ('loc-uk-return-quarantine','wh-uk','RETURN-QUARANTINE','UK Return Quarantine');
INSERT INTO permissions (code,name,description)
  VALUES ('international-return:receive','UK 退货隔离收货','仅确认退货收货到 UK 隔离库存，不恢复可售');
INSERT INTO role_permissions (role_id,permission_code)
  SELECT id,'international-return:receive' FROM roles WHERE code IN ('super_admin','uk_fulfilment_operator');

CREATE TABLE asset_events_return (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'imported','sold','shipped','warranty_started','warranty_extended','warranty_cancelled','warranty_denied','service_received',
    'inspection_started','inspection_completed','repaired','replaced','refurbished','sn_changed','returned_to_inventory','resold','scrapped','note_added',
    'asset_received','inspection_assigned','asset_graded','certification_issued','certification_rejected',
    'transfer_created','transfer_shipped','transfer_received','listing_created','listing_activated','listing_cancelled',
    'asset_reserved','allocation_released','sale_completed','customer_shipped','customer_delivered','warranty_activated',
    'rma_opened','return_shipped','return_received','service_started','service_completed','recertified','refund_completed'
  )),
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
INSERT INTO asset_events_return SELECT * FROM asset_events;
DROP TABLE asset_events;
ALTER TABLE asset_events_return RENAME TO asset_events;
CREATE INDEX idx_asset_events_timeline ON asset_events(asset_id, occurred_at DESC, created_at DESC);
CREATE INDEX idx_asset_events_service_case ON asset_events(related_service_case_id, created_at DESC);
CREATE INDEX idx_asset_events_machine_type ON asset_events(asset_id, event_type, occurred_at DESC);
CREATE UNIQUE INDEX idx_certified_warranty_activation_event ON asset_events(related_order_id)
  WHERE event_type = 'warranty_activated' AND source = 'certified-sale-delivery' AND related_order_id IS NOT NULL;
CREATE UNIQUE INDEX idx_rma_return_events ON asset_events(related_service_case_id,event_type)
  WHERE source = 'international-return-logistics' AND event_type IN ('return_shipped','return_received');
CREATE INDEX idx_rma_awaiting_return ON after_sales_cases(return_warehouse_id,service_stage,return_shipped_at);

-- Persistent hold is separate from the legacy Asset lifecycle status. Ordinary
-- Location/Admin writes cannot accidentally restore sellability.
CREATE TRIGGER trg_quarantine_allocation_insert BEFORE INSERT ON international_asset_allocations
WHEN NEW.status = 'reserved' AND EXISTS (SELECT 1 FROM assets WHERE id=NEW.asset_id AND inventory_status='QUARANTINED')
BEGIN SELECT RAISE(ABORT,'Asset is QUARANTINED; allocation forbidden'); END;
CREATE TRIGGER trg_quarantine_allocation_update BEFORE UPDATE OF status,asset_id ON international_asset_allocations
WHEN NEW.status = 'reserved' AND EXISTS (SELECT 1 FROM assets WHERE id=NEW.asset_id AND inventory_status='QUARANTINED')
BEGIN SELECT RAISE(ABORT,'Asset is QUARANTINED; allocation forbidden'); END;
CREATE TRIGGER trg_quarantine_listing_insert BEFORE INSERT ON marketplace_listings
WHEN EXISTS (SELECT 1 FROM assets WHERE id=NEW.asset_id AND inventory_status='QUARANTINED')
BEGIN SELECT RAISE(ABORT,'Asset is QUARANTINED; listing forbidden'); END;
CREATE TRIGGER trg_quarantine_listing_update BEFORE UPDATE OF status,asset_id ON marketplace_listings
WHEN NEW.status IN ('active','reserved') AND EXISTS (SELECT 1 FROM assets WHERE id=NEW.asset_id AND inventory_status='QUARANTINED')
BEGIN SELECT RAISE(ABORT,'Asset is QUARANTINED; listing forbidden'); END;
CREATE TRIGGER trg_quarantine_location_insert BEFORE INSERT ON asset_locations
WHEN NEW.status IN ('on_hand','reserved') AND EXISTS (SELECT 1 FROM assets WHERE id=NEW.asset_id AND inventory_status='QUARANTINED')
BEGIN SELECT RAISE(ABORT,'Asset is QUARANTINED; sellable location forbidden'); END;
CREATE TRIGGER trg_quarantine_location_update BEFORE UPDATE ON asset_locations
WHEN NEW.status IN ('on_hand','reserved') AND EXISTS (SELECT 1 FROM assets WHERE id=NEW.asset_id AND inventory_status='QUARANTINED')
BEGIN SELECT RAISE(ABORT,'Asset is QUARANTINED; sellable location forbidden'); END;
