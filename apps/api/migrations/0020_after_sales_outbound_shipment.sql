ALTER TABLE after_sales_cases ADD COLUMN outbound_carrier TEXT NOT NULL DEFAULT '';
ALTER TABLE after_sales_cases ADD COLUMN outbound_tracking_number TEXT NOT NULL DEFAULT '';
ALTER TABLE after_sales_cases ADD COLUMN outbound_serial_number TEXT NOT NULL DEFAULT '';
ALTER TABLE after_sales_cases ADD COLUMN outbound_shipped_at TEXT;
ALTER TABLE after_sales_cases ADD COLUMN outbound_recorded_at TEXT;
ALTER TABLE after_sales_cases ADD COLUMN outbound_recorded_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE after_sales_cases ADD COLUMN outbound_mail_status TEXT NOT NULL DEFAULT '';
ALTER TABLE after_sales_cases ADD COLUMN outbound_mail_failure_reason TEXT NOT NULL DEFAULT '';
