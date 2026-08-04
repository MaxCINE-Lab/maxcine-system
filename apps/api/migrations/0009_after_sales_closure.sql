-- After-sales closure V1. Existing status/workflow_stage columns remain for
-- compatibility; service_stage carries the newer customer-service workflow.
PRAGMA foreign_keys = ON;

ALTER TABLE after_sales_cases ADD COLUMN service_stage TEXT NOT NULL DEFAULT 'PENDING_ADMIN_REVIEW';
ALTER TABLE after_sales_cases ADD COLUMN source_role TEXT NOT NULL DEFAULT '';
ALTER TABLE after_sales_cases ADD COLUMN source_service_center_id TEXT REFERENCES service_centers(id) ON DELETE SET NULL;
ALTER TABLE after_sales_cases ADD COLUMN customer_email TEXT NOT NULL DEFAULT '';
ALTER TABLE after_sales_cases ADD COLUMN customer_address TEXT NOT NULL DEFAULT '';
ALTER TABLE after_sales_cases ADD COLUMN customer_note TEXT NOT NULL DEFAULT '';
ALTER TABLE after_sales_cases ADD COLUMN internal_note TEXT NOT NULL DEFAULT '';
ALTER TABLE after_sales_cases ADD COLUMN requires_customer_shipment INTEGER NOT NULL DEFAULT 1 CHECK (requires_customer_shipment IN (0,1));
ALTER TABLE after_sales_cases ADD COLUMN inbound_carrier TEXT NOT NULL DEFAULT '';
ALTER TABLE after_sales_cases ADD COLUMN inbound_tracking_number TEXT NOT NULL DEFAULT '';
ALTER TABLE after_sales_cases ADD COLUMN inbound_note TEXT NOT NULL DEFAULT '';
ALTER TABLE after_sales_cases ADD COLUMN inbound_recorded_at TEXT;
ALTER TABLE after_sales_cases ADD COLUMN inbound_recorded_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE after_sales_cases ADD COLUMN admin_review_note TEXT NOT NULL DEFAULT '';
ALTER TABLE after_sales_cases ADD COLUMN admin_reviewed_at TEXT;
ALTER TABLE after_sales_cases ADD COLUMN admin_reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE after_sales_cases ADD COLUMN final_decision TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS after_sales_attachments (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES after_sales_cases(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN (
    'customer_problem_photo',
    'package_label',
    'received_items_front',
    'received_items_back',
    'product_front',
    'product_back',
    'product_left',
    'product_right',
    'product_top',
    'product_bottom',
    'accidental_damage',
    'inspection_other'
  )),
  photo_slot TEXT NOT NULL DEFAULT '',
  object_key TEXT NOT NULL UNIQUE,
  original_filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  file_size INTEGER NOT NULL CHECK (file_size > 0),
  uploaded_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_after_sales_attachments_case ON after_sales_attachments(case_id, category, photo_slot, created_at DESC);

CREATE TABLE IF NOT EXISTS after_sales_timeline (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES after_sales_cases(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_after_sales_timeline_case ON after_sales_timeline(case_id, created_at DESC);

CREATE TABLE IF NOT EXISTS after_sales_receipts (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES after_sales_cases(id) ON DELETE CASCADE,
  received_items_json TEXT NOT NULL DEFAULT '[]',
  packaging_intact INTEGER NOT NULL CHECK (packaging_intact IN (0,1)),
  packaging_note TEXT NOT NULL DEFAULT '',
  items_match INTEGER NOT NULL CHECK (items_match IN (0,1)),
  missing_items_note TEXT NOT NULL DEFAULT '',
  receipt_note TEXT NOT NULL DEFAULT '',
  received_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_after_sales_receipts_case ON after_sales_receipts(case_id, received_at DESC);

CREATE TABLE IF NOT EXISTS after_sales_inspections_v2 (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES after_sales_cases(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  fault_reproduced TEXT NOT NULL CHECK (fault_reproduced IN ('yes','no','uncertain')),
  conclusion TEXT NOT NULL,
  fault_cause TEXT NOT NULL DEFAULT '',
  affected_parts TEXT NOT NULL DEFAULT '',
  suggested_action TEXT NOT NULL,
  suggested_parts TEXT NOT NULL DEFAULT '',
  recommend_warranty INTEGER NOT NULL CHECK (recommend_warranty IN (0,1)),
  recommend_charge INTEGER NOT NULL CHECK (recommend_charge IN (0,1)),
  engineer_note TEXT NOT NULL DEFAULT '',
  difficulty TEXT NOT NULL DEFAULT '',
  estimated_days TEXT NOT NULL DEFAULT '',
  accidental_damage INTEGER NOT NULL CHECK (accidental_damage IN (0,1)),
  accidental_damage_type TEXT NOT NULL DEFAULT '',
  accidental_damage_note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','returned','approved')),
  submitted_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  review_note TEXT NOT NULL DEFAULT '',
  UNIQUE(case_id, version)
);
CREATE INDEX IF NOT EXISTS idx_after_sales_inspections_v2_case ON after_sales_inspections_v2(case_id, version DESC);

CREATE TABLE IF NOT EXISTS after_sales_quotes (
  id TEXT PRIMARY KEY,
  quote_no TEXT NOT NULL UNIQUE,
  case_id TEXT NOT NULL REFERENCES after_sales_cases(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  product_name TEXT NOT NULL DEFAULT '',
  product_version TEXT NOT NULL DEFAULT '',
  serial_number TEXT NOT NULL DEFAULT '',
  case_type TEXT NOT NULL,
  inspection_summary TEXT NOT NULL,
  final_decision TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  valid_until TEXT NOT NULL,
  estimated_cycle TEXT NOT NULL DEFAULT '',
  payment_instructions TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  html_content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','sent','send_failed')),
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(case_id, version)
);
CREATE INDEX IF NOT EXISTS idx_after_sales_quotes_case ON after_sales_quotes(case_id, version DESC);

CREATE TABLE IF NOT EXISTS after_sales_quote_items (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL REFERENCES after_sales_quotes(id) ON DELETE CASCADE,
  item_name TEXT NOT NULL,
  item_type TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL,
  subtotal_cents INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_after_sales_quote_items_quote ON after_sales_quote_items(quote_id);

CREATE TABLE IF NOT EXISTS after_sales_quote_emails (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL REFERENCES after_sales_quotes(id) ON DELETE CASCADE,
  to_email TEXT NOT NULL,
  from_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent','failed')),
  failure_reason TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  sent_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_after_sales_quote_emails_quote ON after_sales_quote_emails(quote_id, created_at DESC);

INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT id, 'after-sales:create' FROM roles WHERE code = 'authorized_service_center';

INSERT INTO after_sales_timeline (id, case_id, event_type, title, description, actor_id, created_at)
  SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))),
    id, 'legacy_imported', '历史工单已接入售后闭环', '', created_by, created_at
  FROM after_sales_cases
  WHERE NOT EXISTS (SELECT 1 FROM after_sales_timeline WHERE after_sales_timeline.case_id = after_sales_cases.id);
