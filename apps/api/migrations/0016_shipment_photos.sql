PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS shipment_photos (
  id TEXT PRIMARY KEY,
  shipment_id TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('box_sn', 'packed_photo_1', 'packed_photo_2')),
  data_url TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  uploaded_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(order_id, category)
);

CREATE INDEX IF NOT EXISTS idx_shipment_photos_order ON shipment_photos(order_id, category);
