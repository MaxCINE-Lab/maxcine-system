-- REPLACE execution child of the existing RMA. The original returned Asset and
-- the replacement Asset remain two separate canonical Assets; nothing here ships,
-- delivers, releases quarantine, closes the RMA or changes any Warranty.
CREATE TABLE rma_replace_executions (
  id TEXT PRIMARY KEY,
  rma_id TEXT NOT NULL UNIQUE REFERENCES after_sales_cases(id) ON DELETE RESTRICT,
  original_asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  resolution_reference TEXT NOT NULL REFERENCES after_sales_cases(id) ON DELETE RESTRICT,
  resolution_decided_at TEXT NOT NULL,
  inspection_id TEXT NOT NULL REFERENCES rma_return_inspections(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK(status IN ('REPLACEMENT_IN_PROGRESS','REPLACEMENT_COMPLETED')),
  started_by TEXT NOT NULL REFERENCES users(id),
  started_at TEXT NOT NULL CHECK(datetime(started_at) IS NOT NULL),
  replacement_asset_id TEXT REFERENCES assets(id) ON DELETE RESTRICT,
  replacement_asset_code TEXT,
  replacement_warehouse_id TEXT REFERENCES warehouses(id) ON DELETE RESTRICT,
  replacement_certification_id TEXT REFERENCES asset_certifications(id) ON DELETE RESTRICT,
  replacement_selected_by TEXT REFERENCES users(id),
  replacement_selected_at TEXT,
  selection_fingerprint TEXT,
  completed_by TEXT REFERENCES users(id),
  completed_at TEXT,
  execution_notes TEXT NOT NULL DEFAULT '',
  completion_fingerprint TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(resolution_reference=rma_id),
  CHECK(replacement_asset_id IS NULL OR replacement_asset_id<>original_asset_id),
  CHECK((replacement_asset_id IS NULL AND replacement_asset_code IS NULL AND replacement_warehouse_id IS NULL AND replacement_certification_id IS NULL
      AND replacement_selected_by IS NULL AND replacement_selected_at IS NULL AND selection_fingerprint IS NULL)
    OR (replacement_asset_id IS NOT NULL AND replacement_asset_code IS NOT NULL AND replacement_warehouse_id IS NOT NULL AND replacement_certification_id IS NOT NULL
      AND replacement_selected_by IS NOT NULL AND datetime(replacement_selected_at) IS NOT NULL AND selection_fingerprint IS NOT NULL)),
  CHECK(length(execution_notes)<=4000),
  CHECK((status='REPLACEMENT_IN_PROGRESS' AND completed_by IS NULL AND completed_at IS NULL AND completion_fingerprint IS NULL AND execution_notes='')
    OR (status='REPLACEMENT_COMPLETED' AND replacement_asset_id IS NOT NULL AND completed_by IS NOT NULL AND datetime(completed_at) IS NOT NULL
      AND datetime(completed_at)>=datetime(replacement_selected_at) AND length(trim(execution_notes)) BETWEEN 1 AND 4000 AND completion_fingerprint IS NOT NULL))
);
-- One physical replacement device can be committed to at most one execution.
CREATE UNIQUE INDEX idx_rma_replace_committed_asset ON rma_replace_executions(replacement_asset_id) WHERE replacement_asset_id IS NOT NULL;
CREATE INDEX idx_rma_replace_original_asset ON rma_replace_executions(original_asset_id,created_at);

INSERT INTO permissions(code,name,description) VALUES
 ('international-rma-replace:execute','国际 RMA 更换执行','独立明确授权；仅执行已批准的 REPLACE 并锁定 Scope 内替换设备，不发货、不关闭 RMA、不改变保修');
INSERT INTO roles(id,code,name,description) VALUES
 ('role-international-replacement-operator','international_replacement_operator','国际更换执行授权','不自动分配给仓库、维修、Certified、普通 International 或售后决策人员');
INSERT INTO role_permissions(role_id,permission_code)
 SELECT 'role-international-replacement-operator',code FROM permissions
 WHERE code IN ('international-rma-replace:execute','international-after-sales:read','workspace:read');
INSERT INTO role_permissions(role_id,permission_code)
 SELECT id,'international-rma-replace:execute' FROM roles WHERE code='super_admin';

-- Rebuild asset_events from the complete 0043 definition, adding only the
-- three replacement execution facts. The 0043 trigger that reads asset_events
-- is dropped first and recreated verbatim after the rename.
DROP TRIGGER trg_customer_return_release_valid;
CREATE TABLE asset_events_replace_execution (
 id TEXT PRIMARY KEY,asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
 event_type TEXT NOT NULL CHECK(event_type IN (
 'imported','sold','shipped','warranty_started','warranty_extended','warranty_cancelled','warranty_denied','service_received',
 'inspection_started','inspection_completed','repaired','replaced','refurbished','sn_changed','returned_to_inventory','resold','scrapped','note_added',
 'asset_received','inspection_assigned','asset_graded','certification_issued','certification_rejected','transfer_created','transfer_shipped','transfer_received',
 'listing_created','listing_activated','listing_cancelled','asset_reserved','allocation_released','sale_completed','customer_shipped','customer_delivered','warranty_activated',
 'repair_started','repair_completed','rma_resolution_decided','return_inspection_started','return_inspection_completed','rma_opened','return_shipped','return_received',
 'service_started','service_completed','recertified','refund_completed','post_repair_reinspection_started','post_repair_reinspection_completed','recertification_approved','recertification_rejected',
 'customer_return_released','replacement_execution_started','replacement_asset_committed','replacement_execution_completed')),
 occurred_at TEXT,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',
 related_order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,related_service_case_id TEXT REFERENCES after_sales_cases(id) ON DELETE SET NULL,
 sale_id TEXT REFERENCES asset_sales(id) ON DELETE SET NULL,old_value_json TEXT,new_value_json TEXT,operator_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
 visibility TEXT NOT NULL DEFAULT 'admin_private' CHECK(visibility IN ('admin_private','service_center','dealer','customer_safe')),
 source TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO asset_events_replace_execution SELECT * FROM asset_events;
DROP TABLE asset_events;
ALTER TABLE asset_events_replace_execution RENAME TO asset_events;
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
CREATE UNIQUE INDEX idx_post_repair_events ON asset_events(related_service_case_id,event_type)
 WHERE source='post-repair-recertification';
CREATE UNIQUE INDEX idx_customer_return_release_event ON asset_events(related_service_case_id)
 WHERE source='international-customer-return-release' AND event_type='customer_return_released';
CREATE UNIQUE INDEX idx_rma_replace_events ON asset_events(related_service_case_id,event_type,asset_id)
 WHERE source='international-rma-replace';

CREATE TRIGGER trg_customer_return_release_valid BEFORE INSERT ON rma_customer_return_releases
WHEN NOT EXISTS(
 SELECT 1 FROM after_sales_cases c
 JOIN rma_repair_executions repair ON repair.rma_id=c.id
 JOIN rma_post_repair_inspections inspection ON inspection.rma_id=c.id
 JOIN rma_recertification_decisions decision ON decision.rma_id=c.id
 JOIN current_asset_certifications cert ON cert.asset_id=c.asset_id
 JOIN assets a ON a.id=c.asset_id JOIN asset_locations location ON location.asset_id=a.id
 JOIN warehouse_locations area ON area.id=location.location_id JOIN warehouses warehouse ON warehouse.id=location.warehouse_id
 JOIN orders original_order ON original_order.id=c.order_id
 WHERE (c.id=NEW.rma_id AND c.asset_id=NEW.asset_id AND c.order_id=NEW.order_id)
 AND (c.status='in_progress' AND c.service_stage='REPAIR_COMPLETED' AND c.cross_border_resolution='REPAIR')
 AND (c.market_region='UK' AND c.return_warehouse_id='wh-uk' AND c.return_shipped_at IS NOT NULL AND c.return_received_at IS NOT NULL)
 AND (c.outbound_shipped_at IS NULL AND c.resolution_decided_at=repair.resolution_decided_at AND c.resolution_inspection_id=repair.inspection_id)
 AND (repair.id=NEW.repair_execution_id AND repair.asset_id=a.id AND repair.order_id=c.order_id AND repair.status='REPAIR_COMPLETED'
      AND repair.completed_at IS NOT NULL AND repair.submission_fingerprint IS NOT NULL)
 AND (inspection.id=NEW.post_repair_inspection_id AND inspection.asset_id=a.id AND inspection.repair_execution_id=repair.id
      AND inspection.status='COMPLETED' AND inspection.completed_at IS NOT NULL AND inspection.completion_fingerprint IS NOT NULL)
 AND (decision.id=NEW.recertification_decision_id AND decision.inspection_id=inspection.id AND decision.asset_id=a.id
      AND decision.decision='APPROVED' AND decision.certification_id=NEW.certification_id)
 AND (cert.id=NEW.certification_id AND cert.version=NEW.certification_version AND cert.purpose='POST_REPAIR_RECERTIFICATION'
      AND cert.post_repair_inspection_id=inspection.id AND cert.certification_status='certified' AND cert.final_qc=1 AND cert.inspection_result='PASS')
 AND (a.inventory_status='QUARANTINED' AND location.warehouse_id='wh-uk' AND location.custody='WAREHOUSE' AND location.status='returned')
 AND (area.warehouse_id='wh-uk' AND area.code='RETURN-QUARANTINE' AND warehouse.status='active' AND warehouse.market_region='UK')
 AND (original_order.status='delivered' AND original_order.sales_account_id=c.sales_account_id AND original_order.fulfilment_warehouse_id='wh-uk')
 AND (SELECT COUNT(*) FROM international_asset_allocations allocation WHERE allocation.order_id=c.order_id AND allocation.asset_id=a.id AND allocation.status='fulfilled')=1
 AND NOT EXISTS(SELECT 1 FROM international_asset_allocations allocation WHERE allocation.asset_id=a.id AND allocation.status='reserved')
 AND NOT EXISTS(SELECT 1 FROM asset_transfers transfer WHERE transfer.asset_id=a.id AND transfer.status IN ('created','shipped'))
 AND NOT EXISTS(SELECT 1 FROM after_sales_cases other WHERE other.asset_id=a.id AND other.id<>c.id AND other.status IN ('open','in_progress'))
 AND EXISTS(SELECT 1 FROM asset_events event WHERE event.related_service_case_id=c.id AND event.event_type='repair_completed' AND event.source='international-rma-repair')
 AND EXISTS(SELECT 1 FROM asset_events event WHERE event.related_service_case_id=c.id AND event.event_type='post_repair_reinspection_completed' AND event.source='post-repair-recertification')
 AND EXISTS(SELECT 1 FROM asset_events event WHERE event.related_service_case_id=c.id AND event.event_type='recertification_approved' AND event.source='post-repair-recertification')
)
BEGIN SELECT RAISE(ABORT,'Invalid customer return release'); END;

-- Write-boundary guards. Conjunction groups stay shallow for D1's expression depth.
CREATE TRIGGER trg_rma_replace_start BEFORE INSERT ON rma_replace_executions
WHEN NEW.status<>'REPLACEMENT_IN_PROGRESS' OR NEW.replacement_asset_id IS NOT NULL OR NOT EXISTS(
 SELECT 1 FROM after_sales_cases c JOIN rma_return_inspections i ON i.id=c.resolution_inspection_id
  JOIN assets a ON a.id=c.asset_id JOIN asset_locations l ON l.asset_id=a.id JOIN warehouse_locations area ON area.id=l.location_id
 WHERE (c.id=NEW.rma_id AND c.asset_id=NEW.original_asset_id AND c.order_id=NEW.order_id AND c.status='in_progress')
 AND (c.service_stage='RESOLUTION_DECIDED' AND c.cross_border_resolution='REPLACE' AND c.resolution_decided_by IS NOT NULL)
 AND (c.resolution_decided_at=NEW.resolution_decided_at AND c.resolution_inspection_id=NEW.inspection_id AND c.outbound_shipped_at IS NULL)
 AND (i.rma_id=c.id AND i.asset_id=c.asset_id AND i.order_id=c.order_id AND i.status='INSPECTION_COMPLETED' AND i.completed_at IS NOT NULL)
 AND (a.inventory_status='QUARANTINED' AND l.custody='WAREHOUSE' AND l.status='returned' AND l.warehouse_id='wh-uk')
 AND (c.market_region='UK' AND c.return_warehouse_id='wh-uk' AND area.warehouse_id='wh-uk' AND area.code='RETURN-QUARANTINE'))
BEGIN SELECT RAISE(ABORT,'Invalid replacement start'); END;

CREATE TRIGGER trg_rma_replace_identity BEFORE UPDATE ON rma_replace_executions
WHEN OLD.status='REPLACEMENT_COMPLETED' OR NEW.id IS NOT OLD.id OR NEW.rma_id IS NOT OLD.rma_id OR NEW.original_asset_id IS NOT OLD.original_asset_id
 OR NEW.order_id IS NOT OLD.order_id OR NEW.resolution_reference IS NOT OLD.resolution_reference OR NEW.resolution_decided_at IS NOT OLD.resolution_decided_at
 OR NEW.inspection_id IS NOT OLD.inspection_id OR NEW.started_by IS NOT OLD.started_by OR NEW.started_at IS NOT OLD.started_at OR NEW.created_at IS NOT OLD.created_at
 OR (OLD.replacement_asset_id IS NOT NULL AND (NEW.replacement_asset_id IS NOT OLD.replacement_asset_id OR NEW.replacement_asset_code IS NOT OLD.replacement_asset_code
   OR NEW.replacement_warehouse_id IS NOT OLD.replacement_warehouse_id OR NEW.replacement_certification_id IS NOT OLD.replacement_certification_id
   OR NEW.replacement_selected_by IS NOT OLD.replacement_selected_by OR NEW.replacement_selected_at IS NOT OLD.replacement_selected_at
   OR NEW.selection_fingerprint IS NOT OLD.selection_fingerprint))
BEGIN SELECT RAISE(ABORT,'Replacement execution is immutable'); END;

CREATE TRIGGER trg_rma_replace_no_delete BEFORE DELETE ON rma_replace_executions
BEGIN SELECT RAISE(ABORT,'Replacement execution history cannot be deleted'); END;

-- Selection: the replacement must be a different, in-scope UK sellable unit
-- (WAREHOUSE / on_hand / NORMAL), with a valid current Certification, no
-- reservation, listing, transfer, RMA or customer ownership, and the same
-- recorded product identity (product_id, product name and version snapshots).
CREATE TRIGGER trg_rma_replace_select BEFORE UPDATE OF replacement_asset_id ON rma_replace_executions
WHEN OLD.replacement_asset_id IS NULL AND NEW.replacement_asset_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM after_sales_cases c JOIN assets o ON o.id=c.asset_id JOIN assets r ON r.id=NEW.replacement_asset_id
  JOIN asset_locations l ON l.asset_id=r.id JOIN warehouses w ON w.id=l.warehouse_id JOIN current_asset_certifications cert ON cert.asset_id=r.id
 WHERE (c.id=NEW.rma_id AND c.status='in_progress' AND c.service_stage='REPLACEMENT_IN_PROGRESS' AND c.cross_border_resolution='REPLACE')
 AND (OLD.status='REPLACEMENT_IN_PROGRESS' AND NEW.status='REPLACEMENT_IN_PROGRESS' AND o.id=NEW.original_asset_id AND r.id<>o.id)
 AND (r.asset_code=NEW.replacement_asset_code AND r.inventory_status='NORMAL' AND r.asset_status NOT IN ('in_service','scrapped','unknown'))
 AND (l.warehouse_id=NEW.replacement_warehouse_id AND l.warehouse_id='wh-uk' AND l.custody='WAREHOUSE' AND l.status='on_hand')
 AND (w.status='active' AND w.market_region=c.market_region)
 AND (cert.id=NEW.replacement_certification_id AND cert.certification_status='certified' AND cert.final_qc=1 AND cert.grade<>'D' AND cert.inspection_result IN ('PASS','ADVISORY'))
 AND (r.product_id IS o.product_id AND length(trim(o.product_name_snapshot))>0
   AND lower(trim(r.product_name_snapshot))=lower(trim(o.product_name_snapshot)) AND lower(trim(r.version_snapshot))=lower(trim(o.version_snapshot)))
 AND NOT EXISTS(SELECT 1 FROM international_asset_allocations x WHERE x.asset_id=r.id AND x.status='reserved')
 AND NOT EXISTS(SELECT 1 FROM marketplace_listings m WHERE m.asset_id=r.id AND m.status IN ('active','reserved'))
 AND NOT EXISTS(SELECT 1 FROM asset_transfers t WHERE t.asset_id=r.id AND t.status IN ('created','shipped'))
 AND NOT EXISTS(SELECT 1 FROM after_sales_cases other WHERE other.asset_id=r.id AND other.status IN ('open','in_progress'))
 AND NOT EXISTS(SELECT 1 FROM rma_customer_return_releases owned WHERE owned.asset_id=r.id)
 AND NOT EXISTS(SELECT 1 FROM rma_replace_executions original WHERE original.original_asset_id=r.id))
BEGIN SELECT RAISE(ABORT,'Invalid replacement asset'); END;

-- Completion: the committed unit must still be reserved, certified and free.
-- If it became ineligible, completion fails; it is never silently substituted.
CREATE TRIGGER trg_rma_replace_complete BEFORE UPDATE OF status ON rma_replace_executions
WHEN NEW.status='REPLACEMENT_COMPLETED' AND NOT EXISTS(
 SELECT 1 FROM after_sales_cases c JOIN assets o ON o.id=c.asset_id JOIN asset_locations ol ON ol.asset_id=o.id
  JOIN assets r ON r.id=NEW.replacement_asset_id JOIN asset_locations l ON l.asset_id=r.id JOIN current_asset_certifications cert ON cert.asset_id=r.id
 WHERE (c.id=NEW.rma_id AND c.status='in_progress' AND c.service_stage='REPLACEMENT_IN_PROGRESS' AND c.cross_border_resolution='REPLACE' AND c.outbound_shipped_at IS NULL)
 AND (OLD.status='REPLACEMENT_IN_PROGRESS' AND OLD.replacement_asset_id IS NOT NULL AND NEW.replacement_asset_id=OLD.replacement_asset_id)
 AND (o.id=NEW.original_asset_id AND o.inventory_status='QUARANTINED' AND ol.custody='WAREHOUSE' AND ol.status='returned' AND ol.warehouse_id='wh-uk')
 AND (r.inventory_status='NORMAL' AND r.asset_status NOT IN ('in_service','scrapped','unknown') AND l.warehouse_id=NEW.replacement_warehouse_id AND l.custody='WAREHOUSE' AND l.status='reserved')
 AND (cert.id=NEW.replacement_certification_id AND cert.certification_status='certified' AND cert.final_qc=1 AND cert.grade<>'D' AND cert.inspection_result IN ('PASS','ADVISORY'))
 AND NOT EXISTS(SELECT 1 FROM international_asset_allocations x WHERE x.asset_id=r.id AND x.status='reserved')
 AND NOT EXISTS(SELECT 1 FROM marketplace_listings m WHERE m.asset_id=r.id AND m.status IN ('active','reserved'))
 AND NOT EXISTS(SELECT 1 FROM asset_transfers t WHERE t.asset_id=r.id AND t.status IN ('created','shipped'))
 AND NOT EXISTS(SELECT 1 FROM after_sales_cases other WHERE other.asset_id=r.id AND other.status IN ('open','in_progress')))
BEGIN SELECT RAISE(ABORT,'Invalid replacement completion'); END;

CREATE TRIGGER trg_rma_replace_case_state BEFORE UPDATE OF service_stage,status ON after_sales_cases
WHEN (NEW.service_stage IN ('REPLACEMENT_IN_PROGRESS','REPLACEMENT_COMPLETED') AND (NEW.status<>'in_progress' OR NEW.cross_border_resolution IS NOT 'REPLACE'
  OR NOT EXISTS(SELECT 1 FROM rma_replace_executions e WHERE e.rma_id=NEW.id AND e.status=NEW.service_stage)))
 OR (OLD.service_stage='REPLACEMENT_COMPLETED' AND NEW.service_stage<>'REPLACEMENT_COMPLETED')
 OR (OLD.service_stage='REPLACEMENT_IN_PROGRESS' AND NEW.service_stage NOT IN ('REPLACEMENT_IN_PROGRESS','REPLACEMENT_COMPLETED'))
BEGIN SELECT RAISE(ABORT,'Invalid replacement case state'); END;

-- A committed replacement unit is removed from ordinary sale and movement:
-- no order reservation, listing, transfer, or location/custody change.
CREATE TRIGGER trg_replace_commit_allocation_insert BEFORE INSERT ON international_asset_allocations
WHEN NEW.status='reserved' AND EXISTS(SELECT 1 FROM rma_replace_executions e WHERE e.replacement_asset_id=NEW.asset_id)
BEGIN SELECT RAISE(ABORT,'Asset is committed as an RMA replacement; allocation forbidden'); END;
CREATE TRIGGER trg_replace_commit_allocation_update BEFORE UPDATE OF status,asset_id ON international_asset_allocations
WHEN NEW.status='reserved' AND EXISTS(SELECT 1 FROM rma_replace_executions e WHERE e.replacement_asset_id=NEW.asset_id)
BEGIN SELECT RAISE(ABORT,'Asset is committed as an RMA replacement; allocation forbidden'); END;
CREATE TRIGGER trg_replace_commit_listing_insert BEFORE INSERT ON marketplace_listings
WHEN EXISTS(SELECT 1 FROM rma_replace_executions e WHERE e.replacement_asset_id=NEW.asset_id)
BEGIN SELECT RAISE(ABORT,'Asset is committed as an RMA replacement; listing forbidden'); END;
CREATE TRIGGER trg_replace_commit_listing_update BEFORE UPDATE OF status,asset_id ON marketplace_listings
WHEN NEW.status IN ('active','reserved') AND EXISTS(SELECT 1 FROM rma_replace_executions e WHERE e.replacement_asset_id=NEW.asset_id)
BEGIN SELECT RAISE(ABORT,'Asset is committed as an RMA replacement; listing forbidden'); END;
CREATE TRIGGER trg_replace_commit_transfer_insert BEFORE INSERT ON asset_transfers
WHEN EXISTS(SELECT 1 FROM rma_replace_executions e WHERE e.replacement_asset_id=NEW.asset_id)
BEGIN SELECT RAISE(ABORT,'Asset is committed as an RMA replacement; transfer forbidden'); END;
CREATE TRIGGER trg_replace_commit_location_update BEFORE UPDATE ON asset_locations
WHEN EXISTS(SELECT 1 FROM rma_replace_executions e WHERE e.replacement_asset_id=OLD.asset_id)
 AND (NEW.status<>'reserved' OR NEW.custody<>'WAREHOUSE' OR NEW.warehouse_id IS NOT OLD.warehouse_id OR NEW.asset_id IS NOT OLD.asset_id)
BEGIN SELECT RAISE(ABORT,'Asset is committed as an RMA replacement; location change forbidden'); END;
