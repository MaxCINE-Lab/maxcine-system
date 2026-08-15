ALTER TABLE serial_numbers ADD COLUMN production_date TEXT;
ALTER TABLE serial_numbers ADD COLUMN warehouse_location TEXT NOT NULL DEFAULT '';
ALTER TABLE serial_numbers ADD COLUMN storage_box TEXT NOT NULL DEFAULT '';
ALTER TABLE serial_numbers ADD COLUMN carton_number TEXT NOT NULL DEFAULT '';
ALTER TABLE serial_numbers ADD COLUMN internal_note TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_serial_numbers_product_state
  ON serial_numbers(product_id, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_serial_numbers_warehouse
  ON serial_numbers(warehouse_location, updated_at DESC);
