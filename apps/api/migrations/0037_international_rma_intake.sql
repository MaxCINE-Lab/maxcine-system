-- Intake authorization only; physical custody and Warranty remain unchanged.
ALTER TABLE after_sales_cases ADD COLUMN return_carrier TEXT NOT NULL DEFAULT '';
ALTER TABLE after_sales_cases ADD COLUMN reason_note TEXT NOT NULL DEFAULT '';
ALTER TABLE after_sales_cases ADD COLUMN return_authorized_at TEXT;
ALTER TABLE after_sales_cases ADD COLUMN rma_warranty_snapshot_json TEXT
  CHECK (rma_warranty_snapshot_json IS NULL OR json_valid(rma_warranty_snapshot_json));
ALTER TABLE after_sales_cases ADD COLUMN rma_idempotency_key TEXT;
ALTER TABLE after_sales_cases ADD COLUMN rma_request_fingerprint TEXT;
CREATE UNIQUE INDEX idx_rma_intake_reference ON after_sales_cases(rma_reference)
  WHERE return_authorized_at IS NOT NULL;
CREATE UNIQUE INDEX idx_rma_intake_request ON after_sales_cases(rma_idempotency_key)
  WHERE rma_idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX idx_rma_intake_active_asset ON after_sales_cases(asset_id)
  WHERE asset_id IS NOT NULL AND status IN ('open','in_progress') AND return_authorized_at IS NOT NULL;
-- Preserve old unrelated cases, including any pre-existing legacy duplicates.
-- New authorized RMAs conflict with all active cases; legacy writes cannot
-- subsequently create a competing active case for an authorized RMA asset.
CREATE TRIGGER trg_rma_intake_active_insert BEFORE INSERT ON after_sales_cases
WHEN NEW.asset_id IS NOT NULL AND NEW.status IN ('open','in_progress')
  AND EXISTS (SELECT 1 FROM after_sales_cases c WHERE c.asset_id = NEW.asset_id
    AND c.status IN ('open','in_progress')
    AND (NEW.return_authorized_at IS NOT NULL OR c.return_authorized_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'active RMA already exists'); END;
CREATE TRIGGER trg_rma_intake_active_update BEFORE UPDATE OF asset_id, status, return_authorized_at ON after_sales_cases
WHEN NEW.asset_id IS NOT NULL AND NEW.status IN ('open','in_progress')
  AND EXISTS (SELECT 1 FROM after_sales_cases c WHERE c.id <> NEW.id AND c.asset_id = NEW.asset_id
    AND c.status IN ('open','in_progress')
    AND (NEW.return_authorized_at IS NOT NULL OR c.return_authorized_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'active RMA already exists'); END;
CREATE TRIGGER trg_rma_intake_reference_insert BEFORE INSERT ON after_sales_cases
WHEN NEW.return_authorized_at IS NOT NULL AND EXISTS
  (SELECT 1 FROM after_sales_cases c WHERE c.rma_reference = NEW.rma_reference)
BEGIN SELECT RAISE(ABORT, 'RMA reference already exists'); END;
