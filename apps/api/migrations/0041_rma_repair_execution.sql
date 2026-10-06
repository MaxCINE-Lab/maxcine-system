-- One repair execution child of the existing RMA; never a second case system.
CREATE TABLE rma_repair_executions (
  id TEXT PRIMARY KEY,
  rma_id TEXT NOT NULL UNIQUE REFERENCES after_sales_cases(id) ON DELETE RESTRICT,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  resolution_reference TEXT NOT NULL REFERENCES after_sales_cases(id) ON DELETE RESTRICT,
  resolution_decided_at TEXT NOT NULL,
  inspection_id TEXT NOT NULL REFERENCES rma_return_inspections(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK(status IN ('REPAIR_IN_PROGRESS','REPAIR_COMPLETED')),
  technician_id TEXT NOT NULL REFERENCES users(id),
  started_by TEXT NOT NULL REFERENCES users(id),
  started_at TEXT NOT NULL CHECK(datetime(started_at) IS NOT NULL),
  completed_by TEXT REFERENCES users(id),
  completed_at TEXT,
  repair_summary TEXT NOT NULL DEFAULT '',
  work_performed TEXT NOT NULL DEFAULT '',
  repair_notes TEXT NOT NULL DEFAULT '',
  parts_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(parts_json) AND json_type(parts_json)='array' AND json_array_length(parts_json)<=30),
  post_repair_check TEXT CHECK(post_repair_check IN ('PASS','FAIL','INCONCLUSIVE')),
  submission_fingerprint TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(resolution_reference=rma_id),
  CHECK(length(repair_notes)<=4000),
  CHECK((status='REPAIR_IN_PROGRESS' AND completed_at IS NULL AND completed_by IS NULL AND submission_fingerprint IS NULL
    AND repair_summary='' AND work_performed='' AND repair_notes='' AND parts_json='[]' AND post_repair_check IS NULL)
    OR (status='REPAIR_COMPLETED' AND completed_by IS NOT NULL AND completed_at IS NOT NULL AND datetime(completed_at) IS NOT NULL
    AND datetime(completed_at)>=datetime(started_at) AND length(trim(repair_summary)) BETWEEN 1 AND 1000
    AND length(trim(work_performed)) BETWEEN 1 AND 4000 AND post_repair_check IS NOT NULL AND submission_fingerprint IS NOT NULL))
);
CREATE INDEX idx_rma_repair_asset ON rma_repair_executions(asset_id,created_at);

INSERT INTO permissions (code,name,description) VALUES
  ('international-repair:execute','国际 RMA 维修执行','独立明确授权；仅执行已批准的 REPAIR，设备保持隔离');
INSERT INTO roles (id,code,name,description) VALUES
  ('role-international-repair-operator','international_repair_operator','国际维修执行授权','不自动分配给仓库、Certified、普通 International 或售后决策人员');
INSERT INTO role_permissions (role_id,permission_code)
  SELECT 'role-international-repair-operator',code FROM permissions WHERE code IN ('international-repair:execute','international-after-sales:read','workspace:read');
INSERT INTO role_permissions (role_id,permission_code)
  SELECT id,'international-repair:execute' FROM roles WHERE code='super_admin';

CREATE TRIGGER trg_rma_repair_start BEFORE INSERT ON rma_repair_executions
WHEN NEW.status<>'REPAIR_IN_PROGRESS' OR NOT EXISTS (
  SELECT 1 FROM after_sales_cases c JOIN rma_return_inspections i ON i.id=c.resolution_inspection_id
    JOIN assets a ON a.id=c.asset_id JOIN asset_locations l ON l.asset_id=a.id JOIN warehouse_locations area ON area.id=l.location_id
  WHERE c.id=NEW.rma_id AND c.asset_id=NEW.asset_id AND c.order_id=NEW.order_id AND c.status='in_progress'
    AND c.service_stage='RESOLUTION_DECIDED' AND c.cross_border_resolution='REPAIR' AND c.resolution_decided_by IS NOT NULL
    AND c.resolution_decided_at=NEW.resolution_decided_at AND c.resolution_inspection_id=NEW.inspection_id
    AND i.rma_id=c.id AND i.asset_id=c.asset_id AND i.order_id=c.order_id AND i.status='INSPECTION_COMPLETED'
    AND i.completed_at IS NOT NULL AND i.submission_fingerprint IS NOT NULL
    AND a.inventory_status='QUARANTINED' AND l.custody='WAREHOUSE' AND l.status='returned' AND l.warehouse_id='wh-uk'
    AND c.market_region='UK' AND c.return_warehouse_id='wh-uk' AND area.warehouse_id='wh-uk' AND area.code='RETURN-QUARANTINE')
BEGIN SELECT RAISE(ABORT,'Invalid repair start'); END;

CREATE TRIGGER trg_rma_repair_identity BEFORE UPDATE ON rma_repair_executions
WHEN OLD.status='REPAIR_COMPLETED' OR NEW.id IS NOT OLD.id OR NEW.rma_id IS NOT OLD.rma_id OR NEW.asset_id IS NOT OLD.asset_id
  OR NEW.order_id IS NOT OLD.order_id OR NEW.resolution_reference IS NOT OLD.resolution_reference
  OR NEW.resolution_decided_at IS NOT OLD.resolution_decided_at OR NEW.inspection_id IS NOT OLD.inspection_id
  OR NEW.technician_id IS NOT OLD.technician_id OR NEW.started_by IS NOT OLD.started_by OR NEW.started_at IS NOT OLD.started_at OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'Repair execution is immutable'); END;

CREATE TRIGGER trg_rma_repair_no_delete BEFORE DELETE ON rma_repair_executions
BEGIN SELECT RAISE(ABORT,'Repair execution history cannot be deleted'); END;

CREATE TRIGGER trg_rma_repair_complete BEFORE UPDATE ON rma_repair_executions
WHEN NEW.status<>'REPAIR_COMPLETED' OR NOT EXISTS (
  SELECT 1 FROM after_sales_cases c JOIN rma_return_inspections i ON i.id=NEW.inspection_id
    JOIN assets a ON a.id=NEW.asset_id JOIN asset_locations l ON l.asset_id=a.id JOIN warehouse_locations area ON area.id=l.location_id
  WHERE c.id=NEW.rma_id AND c.status='in_progress' AND c.service_stage='REPAIR_IN_PROGRESS' AND c.cross_border_resolution='REPAIR'
    AND c.asset_id=NEW.asset_id AND c.order_id=NEW.order_id AND c.resolution_decided_at=NEW.resolution_decided_at AND c.resolution_inspection_id=NEW.inspection_id
    AND i.rma_id=c.id AND i.asset_id=a.id AND i.order_id=c.order_id AND i.status='INSPECTION_COMPLETED' AND i.completed_at IS NOT NULL
    AND a.inventory_status='QUARANTINED' AND l.custody='WAREHOUSE' AND l.status='returned' AND l.warehouse_id='wh-uk'
    AND c.market_region='UK' AND c.return_warehouse_id='wh-uk' AND area.warehouse_id='wh-uk' AND area.code='RETURN-QUARANTINE')
BEGIN SELECT RAISE(ABORT,'Invalid repair completion'); END;

CREATE TRIGGER trg_rma_repair_case_state BEFORE UPDATE OF service_stage,status ON after_sales_cases
WHEN (NEW.service_stage IN ('REPAIR_IN_PROGRESS','REPAIR_COMPLETED') AND (NEW.status<>'in_progress' OR NOT EXISTS
  (SELECT 1 FROM rma_repair_executions e WHERE e.rma_id=NEW.id AND e.status=NEW.service_stage)))
  OR (OLD.service_stage='REPAIR_COMPLETED' AND NEW.service_stage<>'REPAIR_COMPLETED')
  OR (OLD.service_stage='REPAIR_IN_PROGRESS' AND NEW.service_stage NOT IN ('REPAIR_IN_PROGRESS','REPAIR_COMPLETED'))
BEGIN SELECT RAISE(ABORT,'Invalid repair case state'); END;

CREATE TABLE asset_events_repair (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'imported','sold','shipped','warranty_started','warranty_extended','warranty_cancelled','warranty_denied','service_received',
    'inspection_started','inspection_completed','repaired','replaced','refurbished','sn_changed','returned_to_inventory','resold','scrapped','note_added',
    'asset_received','inspection_assigned','asset_graded','certification_issued','certification_rejected',
    'transfer_created','transfer_shipped','transfer_received','listing_created','listing_activated','listing_cancelled',
    'asset_reserved','allocation_released','sale_completed','customer_shipped','customer_delivered','warranty_activated',
    'repair_started','repair_completed','rma_resolution_decided','return_inspection_started','return_inspection_completed','rma_opened',
    'return_shipped','return_received','service_started','service_completed','recertified','refund_completed'
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
INSERT INTO asset_events_repair SELECT * FROM asset_events;
DROP TABLE asset_events;
ALTER TABLE asset_events_repair RENAME TO asset_events;
CREATE INDEX idx_asset_events_timeline ON asset_events(asset_id,occurred_at DESC,created_at DESC);
CREATE INDEX idx_asset_events_service_case ON asset_events(related_service_case_id,created_at DESC);
CREATE INDEX idx_asset_events_machine_type ON asset_events(asset_id,event_type,occurred_at DESC);
CREATE UNIQUE INDEX idx_certified_warranty_activation_event ON asset_events(related_order_id)
  WHERE event_type='warranty_activated' AND source='certified-sale-delivery' AND related_order_id IS NOT NULL;
CREATE UNIQUE INDEX idx_rma_return_events ON asset_events(related_service_case_id,event_type)
  WHERE source='international-return-logistics' AND event_type IN ('return_shipped','return_received');
CREATE UNIQUE INDEX idx_rma_inspection_events ON asset_events(related_service_case_id,event_type)
  WHERE source='international-return-inspection' AND event_type IN ('return_inspection_started','return_inspection_completed');
CREATE UNIQUE INDEX idx_rma_resolution_event ON asset_events(related_service_case_id)
  WHERE source='international-rma-resolution' AND event_type='rma_resolution_decided';
CREATE UNIQUE INDEX idx_rma_repair_events ON asset_events(related_service_case_id,event_type)
  WHERE source='international-rma-repair' AND event_type IN ('repair_started','repair_completed');
