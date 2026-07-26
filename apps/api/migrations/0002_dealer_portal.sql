-- Dealer portal fields. All values are local-first and remain compatible with Cloudflare D1 SQLite.
ALTER TABLE products ADD COLUMN specification TEXT NOT NULL DEFAULT '';

ALTER TABLE after_sales_cases ADD COLUMN store_id TEXT REFERENCES stores(id) ON DELETE SET NULL;
ALTER TABLE after_sales_cases ADD COLUMN product_id TEXT REFERENCES products(id) ON DELETE SET NULL;
ALTER TABLE after_sales_cases ADD COLUMN serial_number TEXT;
ALTER TABLE after_sales_cases ADD COLUMN case_type TEXT NOT NULL DEFAULT '其他问题';
ALTER TABLE after_sales_cases ADD COLUMN contact_name TEXT;
ALTER TABLE after_sales_cases ADD COLUMN contact_phone TEXT;

CREATE INDEX IF NOT EXISTS idx_after_sales_dealer_status ON after_sales_cases(dealer_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_after_sales_order ON after_sales_cases(order_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, read_at, created_at DESC);
