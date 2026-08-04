-- Quote review, immutable snapshot and explicit delivery workflow.
-- Existing quote rows remain readable and are mapped to the new workflow state.
PRAGMA foreign_keys = ON;

ALTER TABLE after_sales_quotes ADD COLUMN workflow_status TEXT NOT NULL DEFAULT 'DRAFT'
  CHECK (workflow_status IN ('DRAFT','READY_FOR_REVIEW','SENDING','SENT','SEND_FAILED','SUPERSEDED','CANCELLED'));
ALTER TABLE after_sales_quotes ADD COLUMN case_number TEXT NOT NULL DEFAULT '';
ALTER TABLE after_sales_quotes ADD COLUMN customer_phone TEXT NOT NULL DEFAULT '';
ALTER TABLE after_sales_quotes ADD COLUMN customer_address TEXT NOT NULL DEFAULT '';
ALTER TABLE after_sales_quotes ADD COLUMN report_date TEXT NOT NULL DEFAULT '';
ALTER TABLE after_sales_quotes ADD COLUMN warranty_status TEXT NOT NULL DEFAULT '';
ALTER TABLE after_sales_quotes ADD COLUMN service_center TEXT NOT NULL DEFAULT '';
ALTER TABLE after_sales_quotes ADD COLUMN engineer TEXT NOT NULL DEFAULT '';
ALTER TABLE after_sales_quotes ADD COLUMN customer_description TEXT NOT NULL DEFAULT '';
ALTER TABLE after_sales_quotes ADD COLUMN liability_result TEXT NOT NULL DEFAULT '';
ALTER TABLE after_sales_quotes ADD COLUMN subtotal_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE after_sales_quotes ADD COLUMN discount_total_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE after_sales_quotes ADD COLUMN shipping_fee_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE after_sales_quotes ADD COLUMN snapshot_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE after_sales_quotes ADD COLUMN email_text TEXT NOT NULL DEFAULT '';
ALTER TABLE after_sales_quotes ADD COLUMN pdf_object_key TEXT;
ALTER TABLE after_sales_quotes ADD COLUMN from_email TEXT NOT NULL DEFAULT 'notification@maxcine.cn';
ALTER TABLE after_sales_quotes ADD COLUMN reply_to_email TEXT NOT NULL DEFAULT 'support@maxcine.cn';
ALTER TABLE after_sales_quotes ADD COLUMN confirmed_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE after_sales_quotes ADD COLUMN confirmed_at TEXT;
ALTER TABLE after_sales_quotes ADD COLUMN locked_at TEXT;
ALTER TABLE after_sales_quotes ADD COLUMN sent_at TEXT;
ALTER TABLE after_sales_quotes ADD COLUMN supersedes_quote_id TEXT REFERENCES after_sales_quotes(id) ON DELETE SET NULL;
ALTER TABLE after_sales_quotes ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';

ALTER TABLE after_sales_quote_emails ADD COLUMN reply_to_email TEXT NOT NULL DEFAULT 'support@maxcine.cn';
ALTER TABLE after_sales_quote_emails ADD COLUMN provider_message_id TEXT NOT NULL DEFAULT '';
ALTER TABLE after_sales_quote_emails ADD COLUMN attempt_no INTEGER NOT NULL DEFAULT 1;
ALTER TABLE after_sales_quote_emails ADD COLUMN idempotency_key TEXT;
ALTER TABLE after_sales_quote_emails ADD COLUMN email_html TEXT NOT NULL DEFAULT '';
ALTER TABLE after_sales_quote_emails ADD COLUMN email_text TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_after_sales_quote_email_idempotency
  ON after_sales_quote_emails(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

UPDATE after_sales_quotes
SET workflow_status = CASE status
    WHEN 'sent' THEN 'SENT'
    WHEN 'send_failed' THEN 'SEND_FAILED'
    ELSE 'READY_FOR_REVIEW'
  END,
  case_number = COALESCE((SELECT case_no FROM after_sales_cases WHERE id = after_sales_quotes.case_id), ''),
  report_date = substr(created_at, 1, 10),
  subtotal_cents = total_cents,
  snapshot_json = CASE WHEN snapshot_json = '{}' THEN json_object(
    'quoteNumber', quote_no,
    'quoteVersion', version,
    'caseNumber', COALESCE((SELECT case_no FROM after_sales_cases WHERE id = after_sales_quotes.case_id), ''),
    'customerName', customer_name,
    'customerEmail', customer_email,
    'productName', product_name,
    'productVersion', product_version,
    'serialNumber', serial_number,
    'diagnosisSummary', inspection_summary,
    'finalSolution', final_decision,
    'grandTotal', total_cents,
    'currency', currency,
    'validUntil', valid_until
  ) ELSE snapshot_json END,
  confirmed_at = CASE WHEN status IN ('sent','send_failed') THEN created_at ELSE confirmed_at END,
  locked_at = CASE WHEN status IN ('sent','send_failed') THEN created_at ELSE locked_at END,
  sent_at = CASE WHEN status = 'sent' THEN created_at ELSE sent_at END,
  updated_at = created_at;

UPDATE after_sales_quote_emails
SET reply_to_email = 'support@maxcine.cn',
    attempt_no = (
      SELECT COUNT(*)
      FROM after_sales_quote_emails earlier
      WHERE earlier.quote_id = after_sales_quote_emails.quote_id
        AND earlier.created_at <= after_sales_quote_emails.created_at
    );
