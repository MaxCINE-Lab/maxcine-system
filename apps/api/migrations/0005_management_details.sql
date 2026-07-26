-- Administrative display and qualification fields. Historical orders keep their
-- existing snapshots and foreign keys; this migration never deletes business data.
PRAGMA foreign_keys = ON;

ALTER TABLE products ADD COLUMN product_version TEXT NOT NULL DEFAULT '';

ALTER TABLE dealers ADD COLUMN authorization_type TEXT NOT NULL DEFAULT '授权经销商';
ALTER TABLE dealers ADD COLUMN service_center_id TEXT REFERENCES service_centers(id) ON DELETE SET NULL;
ALTER TABLE dealers ADD COLUMN contact_name TEXT NOT NULL DEFAULT '';
ALTER TABLE after_sales_approvals ADD COLUMN resolution TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_dealers_service_center ON dealers(service_center_id, status);
CREATE INDEX IF NOT EXISTS idx_products_active_sku ON products(is_active, sku);
