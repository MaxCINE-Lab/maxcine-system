-- B-5F1 hardening. 0044 is already applied, so this incremental migration only
-- replaces or adds guards; tables, events, indexes and history are unchanged.
--
-- "Active replacement commitment" for an Asset means an execution that names it
-- as replacement_asset_id with status REPLACEMENT_IN_PROGRESS or
-- REPLACEMENT_COMPLETED. A future shipment phase adds its own status and
-- releases these guards explicitly; nothing here releases the reservation.

-- 1. Selection eligibility. Product compatibility fails closed: both canonical
-- product_id values must be present and equal; name and version are extra
-- consistency guards that must be non-empty and match, never a substitute.
-- Any order reservation or fulfilment, non-terminal listing, transfer, active
-- RMA or customer-ownership fact disqualifies the unit.
DROP TRIGGER trg_rma_replace_select;
CREATE TRIGGER trg_rma_replace_select BEFORE UPDATE OF replacement_asset_id ON rma_replace_executions
WHEN OLD.replacement_asset_id IS NULL AND NEW.replacement_asset_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM after_sales_cases c JOIN assets o ON o.id=c.asset_id JOIN assets r ON r.id=NEW.replacement_asset_id
  JOIN asset_locations l ON l.asset_id=r.id JOIN warehouses w ON w.id=l.warehouse_id JOIN current_asset_certifications cert ON cert.asset_id=r.id
 WHERE (c.id=NEW.rma_id AND c.status='in_progress' AND c.service_stage='REPLACEMENT_IN_PROGRESS' AND c.cross_border_resolution='REPLACE')
 AND (OLD.status='REPLACEMENT_IN_PROGRESS' AND NEW.status='REPLACEMENT_IN_PROGRESS' AND o.id=NEW.original_asset_id AND r.id<>o.id)
 AND (r.asset_code=NEW.replacement_asset_code AND r.inventory_status='NORMAL' AND r.asset_status NOT IN ('in_service','scrapped','unknown'))
 AND (l.warehouse_id=NEW.replacement_warehouse_id AND l.warehouse_id='wh-uk' AND l.custody='WAREHOUSE' AND l.status='on_hand')
 AND (w.status='active' AND w.market_region=c.market_region AND c.market_region='UK')
 AND (cert.id=NEW.replacement_certification_id AND cert.certification_status='certified' AND cert.final_qc=1 AND cert.grade<>'D' AND cert.inspection_result IN ('PASS','ADVISORY'))
 AND (o.product_id IS NOT NULL AND r.product_id=o.product_id)
 AND (length(trim(o.product_name_snapshot))>0 AND lower(trim(r.product_name_snapshot))=lower(trim(o.product_name_snapshot)))
 AND (length(trim(o.version_snapshot))>0 AND lower(trim(r.version_snapshot))=lower(trim(o.version_snapshot)))
 AND NOT EXISTS(SELECT 1 FROM international_asset_allocations x WHERE x.asset_id=r.id AND x.status IN ('reserved','fulfilled'))
 AND NOT EXISTS(SELECT 1 FROM marketplace_listings m WHERE m.asset_id=r.id AND m.status IN ('draft','active','paused','reserved','sold'))
 AND NOT EXISTS(SELECT 1 FROM asset_transfers t WHERE t.asset_id=r.id AND t.status IN ('created','shipped'))
 AND NOT EXISTS(SELECT 1 FROM after_sales_cases other WHERE other.asset_id=r.id AND other.status IN ('open','in_progress'))
 AND NOT EXISTS(SELECT 1 FROM rma_customer_return_releases owned WHERE owned.asset_id=r.id)
 AND NOT EXISTS(SELECT 1 FROM rma_replace_executions original WHERE original.original_asset_id=r.id))
BEGIN SELECT RAISE(ABORT,'Invalid replacement asset'); END;

-- 2. Commitment and reservation are one database fact. Writing
-- replacement_asset_id performs the guarded on_hand -> reserved transition of
-- the unit's single canonical location row (asset_id is its primary key; the
-- selection trigger above has just proven it was on_hand in the committed
-- warehouse). If the row is not reserved afterwards, the whole statement
-- aborts, so a commitment can never exist without its reservation.
-- The body holds no conditional expression and no comments: the D1 remote
-- statement splitter would otherwise close the trigger early.
CREATE TRIGGER trg_rma_replace_reserve AFTER UPDATE OF replacement_asset_id ON rma_replace_executions
WHEN OLD.replacement_asset_id IS NULL AND NEW.replacement_asset_id IS NOT NULL
BEGIN
 UPDATE asset_locations SET status='reserved',updated_at=NEW.replacement_selected_at,updated_by=NEW.replacement_selected_by
  WHERE asset_id=NEW.replacement_asset_id AND status='on_hand' AND custody='WAREHOUSE' AND warehouse_id=NEW.replacement_warehouse_id;
 SELECT RAISE(ABORT,'Replacement reservation failed') WHERE NOT EXISTS(SELECT 1 FROM asset_locations WHERE asset_id=NEW.replacement_asset_id
   AND status='reserved' AND custody='WAREHOUSE' AND warehouse_id=NEW.replacement_warehouse_id);
END;

-- The reverse direction: while committed, the location row can be neither
-- replaced, re-inserted nor deleted (0044 already blocks updates away from
-- WAREHOUSE / reserved / the committed warehouse).
CREATE TRIGGER trg_replace_commit_location_insert BEFORE INSERT ON asset_locations
WHEN EXISTS(SELECT 1 FROM rma_replace_executions e WHERE e.replacement_asset_id=NEW.asset_id AND e.status IN ('REPLACEMENT_IN_PROGRESS','REPLACEMENT_COMPLETED'))
BEGIN SELECT RAISE(ABORT,'Asset is committed as an RMA replacement; location change forbidden'); END;
CREATE TRIGGER trg_replace_commit_location_delete BEFORE DELETE ON asset_locations
WHEN EXISTS(SELECT 1 FROM rma_replace_executions e WHERE e.replacement_asset_id=OLD.asset_id AND e.status IN ('REPLACEMENT_IN_PROGRESS','REPLACEMENT_COMPLETED'))
BEGIN SELECT RAISE(ABORT,'Asset is committed as an RMA replacement; location change forbidden'); END;

-- 3. Start revalidates the original sales chain, not only the RMA stage:
-- delivered UK Order of the RMA's Sales Account / market, exactly one fulfilled
-- Allocation linking the original Asset to it, the completed UK return, the
-- explicit resolution fact, and canonical product data able to prove
-- compatibility later.
DROP TRIGGER trg_rma_replace_start;
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
CREATE TRIGGER trg_rma_replace_start_sales_chain BEFORE INSERT ON rma_replace_executions
WHEN NOT EXISTS(
 SELECT 1 FROM after_sales_cases c JOIN orders o ON o.id=c.order_id JOIN sales_accounts account ON account.id=o.sales_account_id JOIN assets a ON a.id=c.asset_id
 WHERE (c.id=NEW.rma_id AND c.order_id=NEW.order_id AND c.asset_id=NEW.original_asset_id AND a.id=NEW.original_asset_id)
 AND (o.status='delivered' AND o.sales_account_id=c.sales_account_id AND o.fulfilment_warehouse_id='wh-uk')
 AND (account.market_region=c.market_region AND c.market_region='UK' AND c.return_warehouse_id='wh-uk')
 AND (c.return_authorized_at IS NOT NULL AND c.return_shipped_at IS NOT NULL AND c.return_received_at IS NOT NULL)
 AND (a.product_id IS NOT NULL AND length(trim(a.product_name_snapshot))>0 AND length(trim(a.version_snapshot))>0)
 AND (SELECT COUNT(*) FROM international_asset_allocations al WHERE al.order_id=o.id AND al.asset_id=a.id AND al.status='fulfilled')=1
 AND EXISTS(SELECT 1 FROM asset_events e WHERE e.related_service_case_id=c.id AND e.event_type='rma_resolution_decided' AND e.source='international-rma-resolution'))
BEGIN SELECT RAISE(ABORT,'Invalid replacement start'); END;

-- 4. Completion revalidates every canonical eligibility fact at the write
-- boundary, so a unit made ineligible after commitment can never be completed
-- (and is never silently substituted).
DROP TRIGGER trg_rma_replace_complete;
CREATE TRIGGER trg_rma_replace_complete BEFORE UPDATE OF status ON rma_replace_executions
WHEN NEW.status='REPLACEMENT_COMPLETED' AND NOT EXISTS(
 SELECT 1 FROM after_sales_cases c JOIN assets o ON o.id=c.asset_id JOIN asset_locations ol ON ol.asset_id=o.id
  JOIN assets r ON r.id=NEW.replacement_asset_id JOIN asset_locations l ON l.asset_id=r.id JOIN warehouses w ON w.id=l.warehouse_id
  JOIN current_asset_certifications cert ON cert.asset_id=r.id
 WHERE (c.id=NEW.rma_id AND c.status='in_progress' AND c.service_stage='REPLACEMENT_IN_PROGRESS' AND c.cross_border_resolution='REPLACE' AND c.outbound_shipped_at IS NULL)
 AND (OLD.status='REPLACEMENT_IN_PROGRESS' AND OLD.replacement_asset_id IS NOT NULL AND NEW.replacement_asset_id=OLD.replacement_asset_id)
 AND (o.id=NEW.original_asset_id AND o.inventory_status='QUARANTINED' AND ol.custody='WAREHOUSE' AND ol.status='returned' AND ol.warehouse_id='wh-uk')
 AND (r.asset_code=NEW.replacement_asset_code AND r.inventory_status='NORMAL' AND r.asset_status NOT IN ('in_service','scrapped','unknown'))
 AND (l.warehouse_id=NEW.replacement_warehouse_id AND l.warehouse_id='wh-uk' AND l.custody='WAREHOUSE' AND l.status='reserved')
 AND (w.status='active' AND w.market_region=c.market_region AND c.market_region='UK')
 AND (cert.id=NEW.replacement_certification_id AND cert.certification_status='certified' AND cert.final_qc=1 AND cert.grade<>'D' AND cert.inspection_result IN ('PASS','ADVISORY'))
 AND (o.product_id IS NOT NULL AND r.product_id=o.product_id)
 AND (length(trim(o.product_name_snapshot))>0 AND lower(trim(r.product_name_snapshot))=lower(trim(o.product_name_snapshot)))
 AND (length(trim(o.version_snapshot))>0 AND lower(trim(r.version_snapshot))=lower(trim(o.version_snapshot))))
BEGIN SELECT RAISE(ABORT,'Invalid replacement completion'); END;
CREATE TRIGGER trg_rma_replace_complete_conflicts BEFORE UPDATE OF status ON rma_replace_executions
WHEN NEW.status='REPLACEMENT_COMPLETED' AND (
 EXISTS(SELECT 1 FROM rma_replace_executions x WHERE x.replacement_asset_id=NEW.replacement_asset_id AND x.id<>NEW.id)
 OR EXISTS(SELECT 1 FROM rma_replace_executions x WHERE x.original_asset_id=NEW.replacement_asset_id)
 OR EXISTS(SELECT 1 FROM international_asset_allocations x WHERE x.asset_id=NEW.replacement_asset_id AND x.status IN ('reserved','fulfilled'))
 OR EXISTS(SELECT 1 FROM marketplace_listings m WHERE m.asset_id=NEW.replacement_asset_id AND m.status IN ('draft','active','paused','reserved','sold'))
 OR EXISTS(SELECT 1 FROM asset_transfers t WHERE t.asset_id=NEW.replacement_asset_id AND t.status IN ('created','shipped'))
 OR EXISTS(SELECT 1 FROM after_sales_cases other WHERE other.asset_id=NEW.replacement_asset_id AND other.status IN ('open','in_progress'))
 OR EXISTS(SELECT 1 FROM after_sales_cases other WHERE other.asset_id=NEW.original_asset_id AND other.id<>NEW.rma_id AND other.status IN ('open','in_progress'))
 OR EXISTS(SELECT 1 FROM rma_customer_return_releases owned WHERE owned.asset_id=NEW.replacement_asset_id OR owned.rma_id=NEW.rma_id))
BEGIN SELECT RAISE(ABORT,'Invalid replacement completion'); END;

-- 5. Consumers. A committed unit cannot receive a new active after-sales record
-- (insert or reopen / re-point), an order reservation or fulfilment, a
-- non-terminal listing state, an active or received transfer, or a change to
-- its identity, product compatibility or inventory status. Terminal listing
-- states (cancelled / expired / ended) and transfer cancellation stay allowed.
CREATE TRIGGER trg_replace_commit_case_insert BEFORE INSERT ON after_sales_cases
WHEN NEW.asset_id IS NOT NULL AND NEW.status IN ('open','in_progress')
 AND EXISTS(SELECT 1 FROM rma_replace_executions e WHERE e.replacement_asset_id=NEW.asset_id AND e.status IN ('REPLACEMENT_IN_PROGRESS','REPLACEMENT_COMPLETED'))
BEGIN SELECT RAISE(ABORT,'Asset is committed as an RMA replacement; after-sales case forbidden'); END;
CREATE TRIGGER trg_replace_commit_case_update BEFORE UPDATE OF asset_id,status ON after_sales_cases
WHEN NEW.asset_id IS NOT NULL AND NEW.status IN ('open','in_progress')
 AND EXISTS(SELECT 1 FROM rma_replace_executions e WHERE e.replacement_asset_id=NEW.asset_id AND e.status IN ('REPLACEMENT_IN_PROGRESS','REPLACEMENT_COMPLETED'))
BEGIN SELECT RAISE(ABORT,'Asset is committed as an RMA replacement; after-sales case forbidden'); END;

DROP TRIGGER trg_replace_commit_allocation_insert;
CREATE TRIGGER trg_replace_commit_allocation_insert BEFORE INSERT ON international_asset_allocations
WHEN NEW.status IN ('reserved','fulfilled')
 AND EXISTS(SELECT 1 FROM rma_replace_executions e WHERE e.replacement_asset_id=NEW.asset_id AND e.status IN ('REPLACEMENT_IN_PROGRESS','REPLACEMENT_COMPLETED'))
BEGIN SELECT RAISE(ABORT,'Asset is committed as an RMA replacement; allocation forbidden'); END;
DROP TRIGGER trg_replace_commit_allocation_update;
CREATE TRIGGER trg_replace_commit_allocation_update BEFORE UPDATE OF status,asset_id ON international_asset_allocations
WHEN NEW.status IN ('reserved','fulfilled')
 AND EXISTS(SELECT 1 FROM rma_replace_executions e WHERE e.replacement_asset_id=NEW.asset_id AND e.status IN ('REPLACEMENT_IN_PROGRESS','REPLACEMENT_COMPLETED'))
BEGIN SELECT RAISE(ABORT,'Asset is committed as an RMA replacement; allocation forbidden'); END;

DROP TRIGGER trg_replace_commit_listing_update;
CREATE TRIGGER trg_replace_commit_listing_update BEFORE UPDATE OF status,asset_id ON marketplace_listings
WHEN NEW.status NOT IN ('cancelled','expired','ended')
 AND EXISTS(SELECT 1 FROM rma_replace_executions e WHERE e.replacement_asset_id=NEW.asset_id AND e.status IN ('REPLACEMENT_IN_PROGRESS','REPLACEMENT_COMPLETED'))
BEGIN SELECT RAISE(ABORT,'Asset is committed as an RMA replacement; listing forbidden'); END;

CREATE TRIGGER trg_replace_commit_transfer_update BEFORE UPDATE OF status,asset_id ON asset_transfers
WHEN NEW.status<>'cancelled' AND (NEW.status IS NOT OLD.status OR NEW.asset_id IS NOT OLD.asset_id)
 AND EXISTS(SELECT 1 FROM rma_replace_executions e WHERE e.replacement_asset_id=NEW.asset_id AND e.status IN ('REPLACEMENT_IN_PROGRESS','REPLACEMENT_COMPLETED'))
BEGIN SELECT RAISE(ABORT,'Asset is committed as an RMA replacement; transfer forbidden'); END;

CREATE TRIGGER trg_replace_commit_asset_update BEFORE UPDATE OF id,original_sn,current_sn,product_id,product_name_snapshot,version_snapshot,inventory_status ON assets
WHEN EXISTS(SELECT 1 FROM rma_replace_executions e WHERE e.replacement_asset_id=OLD.id AND e.status IN ('REPLACEMENT_IN_PROGRESS','REPLACEMENT_COMPLETED'))
 AND (NEW.id IS NOT OLD.id OR NEW.original_sn IS NOT OLD.original_sn OR NEW.current_sn IS NOT OLD.current_sn OR NEW.product_id IS NOT OLD.product_id
  OR NEW.product_name_snapshot IS NOT OLD.product_name_snapshot OR NEW.version_snapshot IS NOT OLD.version_snapshot OR NEW.inventory_status IS NOT OLD.inventory_status)
BEGIN SELECT RAISE(ABORT,'Asset is committed as an RMA replacement; critical field change forbidden'); END;
