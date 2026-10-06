-- Decision only. No execution, asset, location, certification or warranty updates.
ALTER TABLE after_sales_cases ADD COLUMN resolution_decision_reason TEXT;
ALTER TABLE after_sales_cases ADD COLUMN resolution_decision_notes TEXT NOT NULL DEFAULT '';
ALTER TABLE after_sales_cases ADD COLUMN resolution_decided_by TEXT REFERENCES users(id);
ALTER TABLE after_sales_cases ADD COLUMN resolution_decided_at TEXT;
ALTER TABLE after_sales_cases ADD COLUMN resolution_inspection_id TEXT REFERENCES rma_return_inspections(id);
INSERT INTO permissions (code,name,description) VALUES
  ('international-after-sales:decide','国际 RMA 售后决策','仅确认不可覆盖的处理决策，不执行维修、更换或退款');
INSERT INTO roles (id,code,name,description) VALUES
  ('role-international-resolution-manager','international_resolution_manager','国际售后决策授权','必须明确分配；仍受 Sales Account、Market 和 Warehouse Scope 限制');
INSERT INTO role_permissions (role_id,permission_code)
  SELECT 'role-international-resolution-manager',code FROM permissions
  WHERE code IN ('international-after-sales:decide','international-after-sales:read','workspace:read');
INSERT INTO role_permissions (role_id,permission_code)
  SELECT id,'international-after-sales:decide' FROM roles WHERE code='super_admin';
-- No users are auto-enrolled in the decision role.

CREATE TABLE asset_events_resolution (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'imported','sold','shipped','warranty_started','warranty_extended','warranty_cancelled','warranty_denied','service_received',
    'inspection_started','inspection_completed','repaired','replaced','refurbished','sn_changed','returned_to_inventory','resold','scrapped','note_added',
    'asset_received','inspection_assigned','asset_graded','certification_issued','certification_rejected',
    'transfer_created','transfer_shipped','transfer_received','listing_created','listing_activated','listing_cancelled',
    'asset_reserved','allocation_released','sale_completed','customer_shipped','customer_delivered','warranty_activated',
    'rma_resolution_decided','return_inspection_started','return_inspection_completed','rma_opened','return_shipped','return_received','service_started','service_completed','recertified','refund_completed'
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
INSERT INTO asset_events_resolution SELECT * FROM asset_events;
DROP TABLE asset_events;
ALTER TABLE asset_events_resolution RENAME TO asset_events;
CREATE INDEX idx_asset_events_timeline ON asset_events(asset_id, occurred_at DESC, created_at DESC);
CREATE INDEX idx_asset_events_service_case ON asset_events(related_service_case_id, created_at DESC);
CREATE INDEX idx_asset_events_machine_type ON asset_events(asset_id, event_type, occurred_at DESC);
CREATE UNIQUE INDEX idx_certified_warranty_activation_event ON asset_events(related_order_id)
  WHERE event_type = 'warranty_activated' AND source = 'certified-sale-delivery' AND related_order_id IS NOT NULL;
CREATE UNIQUE INDEX idx_rma_return_events ON asset_events(related_service_case_id,event_type)
  WHERE source = 'international-return-logistics' AND event_type IN ('return_shipped','return_received');

CREATE UNIQUE INDEX idx_rma_inspection_events ON asset_events(related_service_case_id,event_type)
  WHERE source='international-return-inspection' AND event_type IN ('return_inspection_started','return_inspection_completed');

CREATE UNIQUE INDEX idx_rma_resolution_event ON asset_events(related_service_case_id)
  WHERE source='international-rma-resolution' AND event_type='rma_resolution_decided';

CREATE TRIGGER trg_rma_resolution_valid BEFORE UPDATE OF resolution_decided_at,resolution_decided_by,resolution_inspection_id,resolution_decision_reason,resolution_decision_notes,cross_border_resolution ON after_sales_cases
WHEN OLD.resolution_decided_at IS NULL AND
  (NEW.resolution_decided_at IS NOT NULL OR NEW.resolution_decided_by IS NOT NULL OR NEW.resolution_inspection_id IS NOT NULL OR NEW.resolution_decision_reason IS NOT NULL)
  AND COALESCE(NEW.resolution_decided_at IS NOT NULL AND datetime(NEW.resolution_decided_at) IS NOT NULL
    AND NEW.resolution_decided_by IS NOT NULL AND length(trim(NEW.resolution_decision_reason)) BETWEEN 1 AND 1000
    AND length(NEW.resolution_decision_notes)<=4000 AND NEW.cross_border_resolution IN ('REPAIR','REPLACE','REFUND','REJECT')
    AND OLD.service_stage='INSPECTION_COMPLETED' AND OLD.status='in_progress'
    AND NEW.service_stage='RESOLUTION_DECIDED' AND NEW.status='in_progress'
    AND EXISTS (SELECT 1 FROM rma_return_inspections i JOIN assets a ON a.id=i.asset_id JOIN asset_locations l ON l.asset_id=a.id
      JOIN warehouse_locations area ON area.id=l.location_id
      WHERE i.id=NEW.resolution_inspection_id AND i.rma_id=NEW.id AND i.asset_id=NEW.asset_id AND i.order_id=NEW.order_id
        AND i.status='INSPECTION_COMPLETED' AND i.completed_at IS NOT NULL AND i.submission_fingerprint IS NOT NULL
        AND json_array_length(i.checklist_json)=8 AND json_array_length(i.evidence_snapshot_json)>0
        AND json_extract(i.findings_json,'$.issueReproduced') IN ('YES','NO','INCONCLUSIVE')
        AND json_extract(i.findings_json,'$.conditionAssessment') IN ('GOOD','COSMETIC_DAMAGE','FUNCTIONAL_DEFECT','PHYSICAL_DAMAGE','INCOMPLETE','OTHER')
        AND length(trim(json_extract(i.findings_json,'$.inspectorNotes')))>0
        AND a.inventory_status='QUARANTINED' AND l.custody='WAREHOUSE' AND l.status='returned' AND l.warehouse_id='wh-uk'
        AND area.warehouse_id='wh-uk' AND area.code='RETURN-QUARANTINE'),0)=0
BEGIN SELECT RAISE(ABORT,'Invalid RMA resolution decision'); END;
CREATE TRIGGER trg_rma_resolution_immutable BEFORE UPDATE ON after_sales_cases
WHEN OLD.resolution_decided_at IS NOT NULL AND (
  NEW.cross_border_resolution IS NOT OLD.cross_border_resolution OR NEW.resolution_decision_reason IS NOT OLD.resolution_decision_reason
  OR NEW.resolution_decision_notes IS NOT OLD.resolution_decision_notes OR NEW.resolution_decided_by IS NOT OLD.resolution_decided_by
  OR NEW.resolution_decided_at IS NOT OLD.resolution_decided_at OR NEW.resolution_inspection_id IS NOT OLD.resolution_inspection_id
  OR NEW.asset_id IS NOT OLD.asset_id OR NEW.order_id IS NOT OLD.order_id)
BEGIN SELECT RAISE(ABORT,'RMA resolution decision is immutable'); END;

CREATE TRIGGER trg_rma_resolution_no_initial_decision BEFORE INSERT ON after_sales_cases
WHEN NEW.resolution_decided_at IS NOT NULL OR NEW.resolution_decided_by IS NOT NULL OR NEW.resolution_inspection_id IS NOT NULL OR NEW.resolution_decision_reason IS NOT NULL
BEGIN SELECT RAISE(ABORT,'Resolution requires an existing inspected RMA'); END;
