-- Independent post-repair facts, using the canonical inspection task/assignment.
CREATE TABLE rma_post_repair_inspections (
  id TEXT PRIMARY KEY,
  rma_id TEXT NOT NULL UNIQUE REFERENCES after_sales_cases(id) ON DELETE RESTRICT,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  repair_execution_id TEXT NOT NULL UNIQUE REFERENCES rma_repair_executions(id) ON DELETE RESTRICT,
  inspection_task_id TEXT NOT NULL UNIQUE REFERENCES asset_inspection_tasks(id) ON DELETE RESTRICT,
  purpose TEXT NOT NULL DEFAULT 'POST_REPAIR_RECERTIFICATION' CHECK(purpose='POST_REPAIR_RECERTIFICATION'),
  status TEXT NOT NULL CHECK(status IN ('IN_PROGRESS','COMPLETED')),
  matched_asset_code TEXT NOT NULL,
  expected_sn TEXT NOT NULL,
  observed_sn TEXT NOT NULL DEFAULT '',
  sn_verification TEXT NOT NULL DEFAULT 'NOT_TESTED' CHECK(sn_verification IN ('MATCH','MISMATCH','NOT_TESTED')),
  grade TEXT CHECK(grade IN ('A+','A','B+','B','Parts / Repair')),
  checklist_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(checklist_json) AND json_type(checklist_json)='array'),
  findings_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(findings_json)),
  evidence_snapshot_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence_snapshot_json)),
  completed_at TEXT,
  completion_fingerprint TEXT,
  CHECK((status='IN_PROGRESS' AND completed_at IS NULL AND completion_fingerprint IS NULL)
    OR(status='COMPLETED' AND completed_at IS NOT NULL AND datetime(completed_at) IS NOT NULL AND completion_fingerprint IS NOT NULL AND grade IS NOT NULL))
);
CREATE TABLE rma_recertification_decisions (
  id TEXT PRIMARY KEY,
  inspection_id TEXT NOT NULL UNIQUE REFERENCES rma_post_repair_inspections(id) ON DELETE RESTRICT,
  rma_id TEXT NOT NULL UNIQUE REFERENCES after_sales_cases(id) ON DELETE RESTRICT,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK(decision IN ('APPROVED','REJECTED')),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
  notes TEXT NOT NULL DEFAULT '' CHECK(length(notes)<=4000),
  decided_by TEXT NOT NULL REFERENCES users(id),
  decided_at TEXT NOT NULL CHECK(datetime(decided_at) IS NOT NULL),
  certification_id TEXT UNIQUE REFERENCES asset_certifications(id) DEFERRABLE INITIALLY DEFERRED,
  fingerprint TEXT NOT NULL,
  CHECK((decision='APPROVED' AND certification_id IS NOT NULL) OR(decision='REJECTED' AND certification_id IS NULL))
);

-- Remove only the one-issuance-per-asset constraint, retaining every old field.
CREATE TABLE asset_certifications_versioned (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  inspection_task_id TEXT NOT NULL REFERENCES asset_inspection_tasks(id) ON DELETE RESTRICT,
  grade TEXT NOT NULL CHECK(grade IN ('A','B','C','D')),
  inspection_result TEXT NOT NULL CHECK(inspection_result IN ('PASS','FAIL','ADVISORY','N/A')),
  final_qc INTEGER NOT NULL CHECK(final_qc IN (0,1)),
  certification_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  certification_status TEXT NOT NULL DEFAULT 'certified' CHECK(certification_status IN ('draft','certified','suspended','revoked')),
  warranty_reference TEXT NOT NULL DEFAULT '',
  verification_code_hash TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  grade_display TEXT CHECK(grade_display IN ('A+','A','B+','B','Parts / Repair')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  purpose TEXT NOT NULL DEFAULT 'ORIGINAL_CERTIFICATION' CHECK(purpose IN ('ORIGINAL_CERTIFICATION','POST_REPAIR_RECERTIFICATION')),
  post_repair_inspection_id TEXT UNIQUE REFERENCES rma_post_repair_inspections(id) ON DELETE RESTRICT,
  UNIQUE(asset_id,version),
  CHECK((purpose='ORIGINAL_CERTIFICATION' AND post_repair_inspection_id IS NULL AND version=1)
    OR(purpose='POST_REPAIR_RECERTIFICATION' AND post_repair_inspection_id IS NOT NULL AND version>1))
);
INSERT INTO asset_certifications_versioned(id,asset_id,inspection_task_id,grade,inspection_result,final_qc,certification_date,certification_status,warranty_reference,verification_code_hash,created_by,created_at,grade_display)
  SELECT id,asset_id,inspection_task_id,grade,inspection_result,final_qc,certification_date,certification_status,warranty_reference,verification_code_hash,created_by,created_at,grade_display FROM asset_certifications;
DROP TABLE asset_certifications;
ALTER TABLE asset_certifications_versioned RENAME TO asset_certifications;
CREATE VIEW current_asset_certifications AS SELECT c.* FROM asset_certifications c
  WHERE c.version=(SELECT MAX(v.version) FROM asset_certifications v WHERE v.asset_id=c.asset_id);
CREATE TRIGGER trg_certification_history_identity BEFORE UPDATE ON asset_certifications
WHEN OLD.version<(SELECT MAX(version) FROM asset_certifications WHERE asset_id=OLD.asset_id)
  OR NEW.id IS NOT OLD.id OR NEW.asset_id IS NOT OLD.asset_id OR NEW.inspection_task_id IS NOT OLD.inspection_task_id
  OR NEW.version IS NOT OLD.version OR NEW.purpose IS NOT OLD.purpose OR NEW.post_repair_inspection_id IS NOT OLD.post_repair_inspection_id
  OR NEW.certification_date IS NOT OLD.certification_date OR NEW.created_at IS NOT OLD.created_at OR NEW.created_by IS NOT OLD.created_by
  OR NEW.verification_code_hash IS NOT OLD.verification_code_hash
  OR NEW.grade IS NOT OLD.grade OR NEW.grade_display IS NOT OLD.grade_display OR NEW.inspection_result IS NOT OLD.inspection_result OR NEW.final_qc IS NOT OLD.final_qc
BEGIN SELECT RAISE(ABORT,'Certification history is immutable'); END;
CREATE TRIGGER trg_certification_history_delete BEFORE DELETE ON asset_certifications
BEGIN SELECT RAISE(ABORT,'Certification history cannot be deleted'); END;
CREATE TRIGGER trg_recertification_issuance BEFORE INSERT ON asset_certifications
WHEN NEW.purpose='POST_REPAIR_RECERTIFICATION' AND (
  NEW.version<>(SELECT COALESCE(MAX(version),0)+1 FROM asset_certifications WHERE asset_id=NEW.asset_id)
  OR NOT EXISTS(SELECT 1 FROM rma_post_repair_inspections i JOIN rma_recertification_decisions d ON d.inspection_id=i.id
    WHERE i.id=NEW.post_repair_inspection_id AND i.asset_id=NEW.asset_id AND i.inspection_task_id=NEW.inspection_task_id
      AND i.status='COMPLETED' AND d.decision='APPROVED' AND d.certification_id=NEW.id AND NEW.final_qc=1 AND NEW.certification_status='certified'))
BEGIN SELECT RAISE(ABORT,'Invalid recertification issuance'); END;
CREATE TRIGGER trg_post_repair_report_identity BEFORE UPDATE ON rma_post_repair_inspections
WHEN OLD.status='COMPLETED' OR NEW.id IS NOT OLD.id OR NEW.rma_id IS NOT OLD.rma_id OR NEW.asset_id IS NOT OLD.asset_id
  OR NEW.repair_execution_id IS NOT OLD.repair_execution_id OR NEW.inspection_task_id IS NOT OLD.inspection_task_id
  OR NEW.purpose IS NOT OLD.purpose OR NEW.matched_asset_code IS NOT OLD.matched_asset_code OR NEW.expected_sn IS NOT OLD.expected_sn
BEGIN SELECT RAISE(ABORT,'Post-repair report is immutable'); END;
CREATE TRIGGER trg_post_repair_report_delete BEFORE DELETE ON rma_post_repair_inspections
BEGIN SELECT RAISE(ABORT,'Post-repair history cannot be deleted'); END;
CREATE TRIGGER trg_recertification_decision_update BEFORE UPDATE ON rma_recertification_decisions
BEGIN SELECT RAISE(ABORT,'Recertification decision is immutable'); END;
CREATE TRIGGER trg_recertification_decision_delete BEFORE DELETE ON rma_recertification_decisions
BEGIN SELECT RAISE(ABORT,'Recertification decision cannot be deleted'); END;
CREATE TRIGGER trg_post_repair_task_locked BEFORE UPDATE ON asset_inspection_tasks
WHEN EXISTS(SELECT 1 FROM rma_post_repair_inspections i WHERE i.inspection_task_id=OLD.id AND i.status='COMPLETED')
BEGIN SELECT RAISE(ABORT,'Completed post-repair task is immutable'); END;
CREATE TRIGGER trg_post_repair_evidence_insert BEFORE INSERT ON asset_inspection_evidence
WHEN EXISTS(SELECT 1 FROM rma_post_repair_inspections i WHERE i.inspection_task_id=NEW.inspection_task_id AND i.status='COMPLETED')
BEGIN SELECT RAISE(ABORT,'Post-repair evidence is locked'); END;
CREATE TRIGGER trg_post_repair_evidence_update BEFORE UPDATE ON asset_inspection_evidence
WHEN EXISTS(SELECT 1 FROM rma_post_repair_inspections i WHERE i.inspection_task_id=OLD.inspection_task_id)
BEGIN SELECT RAISE(ABORT,'Post-repair evidence is immutable'); END;
CREATE TRIGGER trg_post_repair_evidence_delete BEFORE DELETE ON asset_inspection_evidence
WHEN EXISTS(SELECT 1 FROM rma_post_repair_inspections i WHERE i.inspection_task_id=OLD.inspection_task_id AND i.status='COMPLETED')
BEGIN SELECT RAISE(ABORT,'Completed post-repair evidence cannot be deleted'); END;
CREATE UNIQUE INDEX idx_post_repair_evidence_object ON asset_inspection_evidence(inspection_task_id,object_key)
  WHERE object_key LIKE 'post-repair-inspection/%';

INSERT INTO permissions(code,name,description) VALUES
 ('post-repair:read','维修后复检查看','受 RMA、Asset、Sales Account、Market 与 Warehouse Scope 保护'),
 ('post-repair:inspect','维修后复检执行','明确授权且指定检测员；不会自动认证'),
 ('post-repair:decide','维修后再认证决定','仅在正式复检完成后明确批准或拒绝；不释放隔离库存');
INSERT INTO roles(id,code,name) VALUES
 ('role-post-repair-inspector','post_repair_inspector','维修后复检人员'),
 ('role-post-repair-certifier','post_repair_certifier','维修后再认证审核人员');
INSERT INTO role_permissions(role_id,permission_code) SELECT 'role-post-repair-inspector',code FROM permissions
 WHERE code IN ('post-repair:read','post-repair:inspect','international-after-sales:read','workspace:read');
INSERT INTO role_permissions(role_id,permission_code) SELECT 'role-post-repair-certifier',code FROM permissions
 WHERE code IN ('post-repair:read','post-repair:decide','international-after-sales:read','workspace:read');
INSERT INTO role_permissions(role_id,permission_code) SELECT r.id,p.code FROM roles r CROSS JOIN permissions p
 WHERE r.code='super_admin' AND p.code IN ('post-repair:read','post-repair:inspect','post-repair:decide');

CREATE TABLE asset_events_post_repair (
 id TEXT PRIMARY KEY,asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
 event_type TEXT NOT NULL CHECK(event_type IN (
 'imported','sold','shipped','warranty_started','warranty_extended','warranty_cancelled','warranty_denied','service_received',
 'inspection_started','inspection_completed','repaired','replaced','refurbished','sn_changed','returned_to_inventory','resold','scrapped','note_added',
 'asset_received','inspection_assigned','asset_graded','certification_issued','certification_rejected','transfer_created','transfer_shipped','transfer_received',
 'listing_created','listing_activated','listing_cancelled','asset_reserved','allocation_released','sale_completed','customer_shipped','customer_delivered','warranty_activated',
 'repair_started','repair_completed','rma_resolution_decided','return_inspection_started','return_inspection_completed','rma_opened','return_shipped','return_received',
 'service_started','service_completed','recertified','refund_completed','post_repair_reinspection_started','post_repair_reinspection_completed','recertification_approved','recertification_rejected')),
 occurred_at TEXT,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',
 related_order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,related_service_case_id TEXT REFERENCES after_sales_cases(id) ON DELETE SET NULL,
 sale_id TEXT REFERENCES asset_sales(id) ON DELETE SET NULL,old_value_json TEXT,new_value_json TEXT,operator_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
 visibility TEXT NOT NULL DEFAULT 'admin_private' CHECK(visibility IN ('admin_private','service_center','dealer','customer_safe')),
 source TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO asset_events_post_repair SELECT * FROM asset_events;
DROP TABLE asset_events;
ALTER TABLE asset_events_post_repair RENAME TO asset_events;
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

CREATE TRIGGER trg_post_repair_start_valid BEFORE INSERT ON rma_post_repair_inspections
WHEN NEW.status<>'IN_PROGRESS' OR NOT EXISTS(
 SELECT 1 FROM after_sales_cases c JOIN rma_repair_executions e ON e.rma_id=c.id JOIN asset_inspection_tasks t ON t.id=NEW.inspection_task_id
 JOIN asset_locations l ON l.asset_id=c.asset_id JOIN assets a ON a.id=c.asset_id JOIN warehouse_locations area ON area.id=l.location_id
 WHERE (c.id=NEW.rma_id AND c.asset_id=NEW.asset_id AND c.status='in_progress' AND c.service_stage='REPAIR_COMPLETED')
 AND (c.cross_border_resolution='REPAIR' AND e.id=NEW.repair_execution_id AND e.status='REPAIR_COMPLETED' AND e.asset_id=c.asset_id)
 AND (t.asset_id=c.asset_id AND t.process_code=NEW.purpose AND t.status='in_progress')
 AND (l.warehouse_id='wh-uk' AND l.custody='WAREHOUSE' AND l.status='returned' AND a.inventory_status='QUARANTINED')
 AND (area.warehouse_id='wh-uk' AND area.code='RETURN-QUARANTINE'))
BEGIN SELECT RAISE(ABORT,'Invalid post-repair inspection start'); END;
CREATE TRIGGER trg_recertification_decision_valid BEFORE INSERT ON rma_recertification_decisions
WHEN NOT EXISTS(SELECT 1 FROM rma_post_repair_inspections i JOIN after_sales_cases c ON c.id=i.rma_id
 JOIN rma_repair_executions e ON e.id=i.repair_execution_id JOIN assets a ON a.id=i.asset_id JOIN asset_locations l ON l.asset_id=a.id
 JOIN warehouse_locations area ON area.id=l.location_id
 WHERE (i.id=NEW.inspection_id AND i.rma_id=NEW.rma_id AND i.asset_id=NEW.asset_id AND i.status='COMPLETED')
 AND (c.status='in_progress' AND c.service_stage='REPAIR_COMPLETED' AND c.cross_border_resolution='REPAIR' AND e.status='REPAIR_COMPLETED')
 AND (a.inventory_status='QUARANTINED' AND l.warehouse_id='wh-uk' AND l.custody='WAREHOUSE' AND l.status='returned')
 AND (area.warehouse_id='wh-uk' AND area.code='RETURN-QUARANTINE'))
BEGIN SELECT RAISE(ABORT,'Invalid recertification decision'); END;
