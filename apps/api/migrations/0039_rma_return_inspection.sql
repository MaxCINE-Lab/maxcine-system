-- Independent reverse inspection; original Certified QC and sellability stay unchanged.
CREATE TABLE rma_return_inspections (
  id TEXT PRIMARY KEY,
  rma_id TEXT NOT NULL UNIQUE REFERENCES after_sales_cases(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  inspector_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('INSPECTION_IN_PROGRESS','INSPECTION_COMPLETED')),
  matched_asset_code TEXT NOT NULL,
  expected_sn TEXT NOT NULL DEFAULT '',
  observed_sn TEXT NOT NULL DEFAULT '',
  sn_verification TEXT NOT NULL DEFAULT 'NOT_TESTED' CHECK (sn_verification IN ('MATCH','MISMATCH','NOT_TESTED')),
  checklist_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(checklist_json)),
  findings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(findings_json)),
  evidence_snapshot_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_snapshot_json)),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  submission_fingerprint TEXT
);
CREATE TABLE rma_return_inspection_evidence (
  id TEXT PRIMARY KEY,
  inspection_id TEXT NOT NULL REFERENCES rma_return_inspections(id),
  category TEXT NOT NULL CHECK (category IN ('OVERALL_CONDITION','DAMAGE_DEFECT','ACCESSORIES','OTHER')),
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
  file_size INTEGER NOT NULL CHECK (file_size > 0 AND file_size <= 26214400),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id)
);
CREATE INDEX idx_return_inspection_evidence ON rma_return_inspection_evidence(inspection_id,created_at);
INSERT INTO permissions (code,name,description)
  VALUES ('international-return:inspect','UK 退货检测','独立退货检测与私有照片证据，不解除隔离');
INSERT INTO role_permissions (role_id,permission_code)
  SELECT id,'international-return:inspect' FROM roles WHERE code IN ('super_admin','uk_fulfilment_operator');

CREATE TABLE asset_events_inspection (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'imported','sold','shipped','warranty_started','warranty_extended','warranty_cancelled','warranty_denied','service_received',
    'inspection_started','inspection_completed','repaired','replaced','refurbished','sn_changed','returned_to_inventory','resold','scrapped','note_added',
    'asset_received','inspection_assigned','asset_graded','certification_issued','certification_rejected',
    'transfer_created','transfer_shipped','transfer_received','listing_created','listing_activated','listing_cancelled',
    'asset_reserved','allocation_released','sale_completed','customer_shipped','customer_delivered','warranty_activated',
    'return_inspection_started','return_inspection_completed','rma_opened','return_shipped','return_received','service_started','service_completed','recertified','refund_completed'
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
INSERT INTO asset_events_inspection SELECT * FROM asset_events;
DROP TABLE asset_events;
ALTER TABLE asset_events_inspection RENAME TO asset_events;
CREATE INDEX idx_asset_events_timeline ON asset_events(asset_id, occurred_at DESC, created_at DESC);
CREATE INDEX idx_asset_events_service_case ON asset_events(related_service_case_id, created_at DESC);
CREATE INDEX idx_asset_events_machine_type ON asset_events(asset_id, event_type, occurred_at DESC);
CREATE UNIQUE INDEX idx_certified_warranty_activation_event ON asset_events(related_order_id)
  WHERE event_type = 'warranty_activated' AND source = 'certified-sale-delivery' AND related_order_id IS NOT NULL;
CREATE UNIQUE INDEX idx_rma_return_events ON asset_events(related_service_case_id,event_type)
  WHERE source = 'international-return-logistics' AND event_type IN ('return_shipped','return_received');

CREATE UNIQUE INDEX idx_rma_inspection_events ON asset_events(related_service_case_id,event_type)
  WHERE source='international-return-inspection' AND event_type IN ('return_inspection_started','return_inspection_completed');

-- Completed reports and their evidence are immutable. A later resolution must
-- use a new business record, never rewrite the observed facts.
CREATE TRIGGER trg_return_inspection_immutable BEFORE UPDATE ON rma_return_inspections
WHEN OLD.status='INSPECTION_COMPLETED'
BEGIN SELECT RAISE(ABORT,'Completed return inspection is immutable'); END;
CREATE TRIGGER trg_return_evidence_insert BEFORE INSERT ON rma_return_inspection_evidence
WHEN NOT EXISTS (SELECT 1 FROM rma_return_inspections WHERE id=NEW.inspection_id AND status='INSPECTION_IN_PROGRESS')
BEGIN SELECT RAISE(ABORT,'Inspection evidence is locked'); END;
CREATE TRIGGER trg_return_evidence_update BEFORE UPDATE ON rma_return_inspection_evidence
BEGIN SELECT RAISE(ABORT,'Inspection evidence is immutable'); END;
CREATE TRIGGER trg_return_evidence_delete BEFORE DELETE ON rma_return_inspection_evidence
WHEN EXISTS (SELECT 1 FROM rma_return_inspections WHERE id=OLD.inspection_id AND status='INSPECTION_COMPLETED')
BEGIN SELECT RAISE(ABORT,'Completed inspection evidence is immutable'); END;

