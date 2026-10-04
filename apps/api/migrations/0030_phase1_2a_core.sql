-- International Certified Phase 1.2A core model hardening.
-- This migration preserves all existing rows while making durable Asset identity,
-- Listing/Allocation history, machine-readable lifecycle and custody explicit.
PRAGMA foreign_keys = OFF;

ALTER TABLE assets ADD COLUMN asset_code TEXT;

-- Existing UUIDs remain the database identity. The migration creates stable,
-- human-readable legacy codes without deriving identity from mutable SN values.
UPDATE assets
SET asset_code = 'MC-' || substr(COALESCE(created_at, CURRENT_TIMESTAMP), 3, 2) || '-AST-' || upper(substr(replace(id, '-', ''), -12))
WHERE asset_code IS NULL OR trim(asset_code) = '';

-- Preserve the familiar Staging specimen label while keeping it separate from SN.
UPDATE assets
SET asset_code = 'MC-' || substr(COALESCE(created_at, CURRENT_TIMESTAMP), 3, 2) || '-' || substr(current_sn, 4)
WHERE current_sn LIKE 'MC-%' AND current_sn IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_asset_code ON assets(asset_code);
CREATE TRIGGER IF NOT EXISTS trg_assets_asset_code_required
BEFORE INSERT ON assets
WHEN NEW.asset_code IS NULL OR trim(NEW.asset_code) = ''
BEGIN
  SELECT RAISE(ABORT, 'asset_code is required');
END;

ALTER TABLE asset_transfers ADD COLUMN carrier TEXT NOT NULL DEFAULT '';

-- Keep the 0028 status column for backwards compatibility. Custody is the
-- authoritative physical-location category used by Phase 1.2A and later.
ALTER TABLE asset_locations ADD COLUMN custody TEXT NOT NULL DEFAULT 'WAREHOUSE'
  CHECK (custody IN ('WAREHOUSE','IN_TRANSIT','CUSTOMER','SERVICE_CENTER','RETURN_TRANSIT'));

UPDATE asset_locations
SET custody = CASE
  WHEN EXISTS (
    SELECT 1 FROM international_asset_allocations allocations
    JOIN orders ON orders.id = allocations.order_id
    WHERE allocations.asset_id = asset_locations.asset_id AND orders.status = 'delivered'
  ) THEN 'CUSTOMER'
  WHEN status = 'in_transit' THEN 'IN_TRANSIT'
  ELSE 'WAREHOUSE'
END;

ALTER TABLE marketplace_listings RENAME TO marketplace_listings_legacy;

CREATE TABLE marketplace_listings (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  channel_id TEXT NOT NULL REFERENCES sales_channels(id) ON DELETE RESTRICT,
  sales_account_id TEXT NOT NULL REFERENCES sales_accounts(id) ON DELETE RESTRICT,
  external_listing_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'GBP',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','reserved','sold','cancelled','expired','ended')),
  activated_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO marketplace_listings (
  id, asset_id, channel_id, sales_account_id, external_listing_id, title,
  price_minor, currency, status, activated_at, ended_at, created_at, updated_at, created_by
)
SELECT id, asset_id, channel_id, sales_account_id, external_listing_id, title,
  price_minor, currency, status,
  CASE WHEN status IN ('active','paused','reserved','sold','ended') THEN created_at ELSE NULL END,
  CASE WHEN status IN ('sold','ended') THEN updated_at ELSE NULL END,
  created_at, updated_at, created_by
FROM marketplace_listings_legacy;

ALTER TABLE international_asset_allocations RENAME TO international_asset_allocations_legacy;

CREATE TABLE international_asset_allocations (
  allocation_id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
  listing_id TEXT REFERENCES marketplace_listings(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','released','fulfilled','cancelled')),
  reserved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  released_at TEXT,
  fulfilled_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reserved_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO international_asset_allocations (
  allocation_id, asset_id, order_id, listing_id, status, reserved_at,
  released_at, fulfilled_at, created_at, reserved_by
)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-a' || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  asset_id, order_id, listing_id, status, reserved_at,
  CASE WHEN status = 'released' THEN reserved_at ELSE NULL END,
  CASE WHEN status = 'fulfilled' THEN reserved_at ELSE NULL END,
  reserved_at, reserved_by
FROM international_asset_allocations_legacy;

-- Phase 1 test data may have completed an order before Listing status updates
-- existed. Reconcile the new historical projection without deleting the row.
UPDATE marketplace_listings
SET status = 'sold', ended_at = COALESCE(ended_at, updated_at)
WHERE id IN (SELECT listing_id FROM international_asset_allocations WHERE status = 'fulfilled' AND listing_id IS NOT NULL);

DROP TABLE international_asset_allocations_legacy;
DROP TABLE marketplace_listings_legacy;

CREATE INDEX idx_listings_asset_history ON marketplace_listings(asset_id, created_at DESC);
CREATE INDEX idx_listings_channel_status ON marketplace_listings(channel_id, status, updated_at DESC);
CREATE UNIQUE INDEX idx_listings_one_effective_per_asset
  ON marketplace_listings(asset_id) WHERE status IN ('active','reserved');
CREATE INDEX idx_allocations_asset_history ON international_asset_allocations(asset_id, created_at DESC);
CREATE INDEX idx_allocations_order ON international_asset_allocations(order_id, created_at DESC);
CREATE UNIQUE INDEX idx_allocations_one_reserved_per_asset
  ON international_asset_allocations(asset_id) WHERE status = 'reserved';

ALTER TABLE asset_events RENAME TO asset_events_legacy;

CREATE TABLE asset_events (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'imported','sold','shipped','warranty_started','warranty_extended','warranty_cancelled','warranty_denied','service_received',
    'inspection_started','inspection_completed','repaired','replaced','refurbished','sn_changed','returned_to_inventory','resold','scrapped','note_added',
    'asset_received','inspection_assigned','asset_graded','certification_issued','certification_rejected',
    'transfer_created','transfer_shipped','transfer_received','listing_created','listing_activated','listing_cancelled',
    'asset_reserved','allocation_released','sale_completed','customer_shipped','customer_delivered','warranty_activated',
    'rma_opened','return_received','service_started','service_completed','recertified','refund_completed'
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

INSERT INTO asset_events (
  id, asset_id, event_type, occurred_at, title, description, related_order_id,
  related_service_case_id, sale_id, old_value_json, new_value_json,
  operator_user_id, visibility, source, created_at
)
SELECT id, asset_id,
  CASE
    WHEN source IN ('international-v1','international-v1-staging') AND title = '山东收货' THEN 'asset_received'
    WHEN source = 'international-v1' AND title = 'Certified 检测任务已创建' THEN 'inspection_assigned'
    WHEN source = 'international-v1' AND title = 'MaxCINE Certified' THEN 'certification_issued'
    WHEN source = 'international-v1' AND title = '国际调拨已创建' THEN 'transfer_created'
    WHEN source = 'international-v1' AND title = '国际调拨已发运' THEN 'transfer_shipped'
    WHEN source = 'international-v1' AND title = '国际调拨已收货' THEN 'transfer_received'
    WHEN source = 'international-v1' AND title = '海外 Listing 已建立' THEN 'listing_created'
    WHEN source = 'international-v1' AND title = '国际订单已绑定并锁定资产' THEN 'asset_reserved'
    WHEN source = 'international-v1' AND title = '已向客户发货' THEN 'customer_shipped'
    WHEN source = 'international-v1' AND title = '订单已妥投' THEN 'customer_delivered'
    WHEN source = 'international-v1' AND title = '国际保修已激活' THEN 'warranty_activated'
    WHEN source = 'international-v1' AND title = '国际 RMA 已创建' THEN 'rma_opened'
    ELSE event_type
  END,
  occurred_at, title, description, related_order_id, related_service_case_id,
  sale_id, old_value_json, new_value_json, operator_user_id, visibility, source, created_at
FROM asset_events_legacy;

DROP TABLE asset_events_legacy;
CREATE INDEX idx_asset_events_timeline ON asset_events(asset_id, occurred_at DESC, created_at DESC);
CREATE INDEX idx_asset_events_service_case ON asset_events(related_service_case_id, created_at DESC);
CREATE INDEX idx_asset_events_machine_type ON asset_events(asset_id, event_type, occurred_at DESC);

PRAGMA foreign_keys = ON;
