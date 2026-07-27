-- Order sales information is collected with the dealer order. The screenshot is
-- deliberately capped by the API and stored as a small data URL for local V1;
-- it can later move to R2 without changing the order workflow.
ALTER TABLE orders ADD COLUMN sale_price_cents INTEGER CHECK (sale_price_cents IS NULL OR sale_price_cents >= 0);
ALTER TABLE orders ADD COLUMN shipping_address TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN customer_profile TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN screenshot_data_url TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_orders_submitted_sales_data
  ON orders(status, submitted_at DESC);
