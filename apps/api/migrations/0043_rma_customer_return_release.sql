-- Explicit authorization to return a repaired Asset to its original customer.
-- This is not shipment, ownership transfer, quarantine release, or resale release.
CREATE TABLE rma_customer_return_releases (
  id TEXT PRIMARY KEY,
  rma_id TEXT NOT NULL UNIQUE REFERENCES after_sales_cases(id) ON DELETE RESTRICT,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  repair_execution_id TEXT NOT NULL REFERENCES rma_repair_executions(id) ON DELETE RESTRICT,
  post_repair_inspection_id TEXT NOT NULL REFERENCES rma_post_repair_inspections(id) ON DELETE RESTRICT,
  recertification_decision_id TEXT NOT NULL UNIQUE REFERENCES rma_recertification_decisions(id) ON DELETE RESTRICT,
  certification_id TEXT NOT NULL UNIQUE REFERENCES asset_certifications(id) ON DELETE RESTRICT,
  certification_version INTEGER NOT NULL CHECK(certification_version > 1),
  purpose TEXT NOT NULL DEFAULT 'CUSTOMER_RETURN' CHECK(purpose='CUSTOMER_RETURN'),
  release_reason TEXT NOT NULL CHECK(length(trim(release_reason)) BETWEEN 1 AND 1000),
  released_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  released_at TEXT NOT NULL CHECK(datetime(released_at) IS NOT NULL),
  request_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK(datetime(created_at) IS NOT NULL),
  CHECK(released_at=created_at)
);
CREATE INDEX idx_customer_return_release_asset ON rma_customer_return_releases(asset_id,released_at);

INSERT INTO permissions(code,name,description) VALUES
 ('international-customer-return:release','原客户返还授权','显式授权已修复并重新认证的隔离设备进入原客户返还后续流程；不解除隔离');
INSERT INTO roles(id,code,name,description) VALUES
 ('role-international-customer-return-manager','international_customer_return_manager','国际原客户返还授权','独立于仓库、维修和再认证权限；仅在 Scope 内授权返还原客户');
INSERT INTO role_permissions(role_id,permission_code)
 SELECT 'role-international-customer-return-manager',code FROM permissions
 WHERE code IN ('international-customer-return:release','international-after-sales:read','workspace:read');
INSERT INTO role_permissions(role_id,permission_code)
 SELECT id,'international-customer-return:release' FROM roles WHERE code='super_admin';

CREATE TRIGGER trg_customer_return_release_immutable BEFORE UPDATE ON rma_customer_return_releases
BEGIN SELECT RAISE(ABORT,'Customer return release is immutable'); END;
CREATE TRIGGER trg_customer_return_release_no_delete BEFORE DELETE ON rma_customer_return_releases
BEGIN SELECT RAISE(ABORT,'Customer return release history cannot be deleted'); END;

CREATE TABLE asset_events_customer_return_release (
 id TEXT PRIMARY KEY,asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
 event_type TEXT NOT NULL CHECK(event_type IN (
 'imported','sold','shipped','warranty_started','warranty_extended','warranty_cancelled','warranty_denied','service_received',
 'inspection_started','inspection_completed','repaired','replaced','refurbished','sn_changed','returned_to_inventory','resold','scrapped','note_added',
 'asset_received','inspection_assigned','asset_graded','certification_issued','certification_rejected','transfer_created','transfer_shipped','transfer_received',
 'listing_created','listing_activated','listing_cancelled','asset_reserved','allocation_released','sale_completed','customer_shipped','customer_delivered','warranty_activated',
 'repair_started','repair_completed','rma_resolution_decided','return_inspection_started','return_inspection_completed','rma_opened','return_shipped','return_received',
 'service_started','service_completed','recertified','refund_completed','post_repair_reinspection_started','post_repair_reinspection_completed','recertification_approved','recertification_rejected',
 'customer_return_released')),
 occurred_at TEXT,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',
 related_order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,related_service_case_id TEXT REFERENCES after_sales_cases(id) ON DELETE SET NULL,
 sale_id TEXT REFERENCES asset_sales(id) ON DELETE SET NULL,old_value_json TEXT,new_value_json TEXT,operator_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
 visibility TEXT NOT NULL DEFAULT 'admin_private' CHECK(visibility IN ('admin_private','service_center','dealer','customer_safe')),
 source TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO asset_events_customer_return_release SELECT * FROM asset_events;
DROP TABLE asset_events;
ALTER TABLE asset_events_customer_return_release RENAME TO asset_events;
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

-- Enforce the full canonical chain at the write boundary. This trigger follows
-- the asset_events rebuild so SQLite never sees a dangling trigger dependency.
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
