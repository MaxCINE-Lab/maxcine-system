-- B-5F1 final guards. 0045 is already applied, so this incremental migration
-- only adds two guards; tables, events, indexes, earlier triggers and history
-- are unchanged.

-- 1. Completion revalidates the original sales chain at the write boundary,
-- exactly as Start does: the execution's Order is still the RMA's Order, still
-- delivered from the UK warehouse under the RMA's Sales Account and market, and
-- exactly one fulfilled Allocation still links it to the original Asset.
-- Released or cancelled Allocation rows are ignored, never counted as valid.
CREATE TRIGGER trg_rma_replace_complete_sales_chain BEFORE UPDATE OF status ON rma_replace_executions
WHEN NEW.status='REPLACEMENT_COMPLETED' AND NOT EXISTS(
 SELECT 1 FROM after_sales_cases c JOIN orders o ON o.id=c.order_id JOIN sales_accounts account ON account.id=o.sales_account_id
 WHERE (c.id=NEW.rma_id AND c.order_id=NEW.order_id AND o.id=NEW.order_id AND c.asset_id=NEW.original_asset_id)
 AND (o.status='delivered' AND o.sales_account_id=c.sales_account_id AND o.fulfilment_warehouse_id='wh-uk')
 AND (account.market_region=c.market_region AND c.market_region='UK')
 AND (SELECT COUNT(*) FROM international_asset_allocations al WHERE al.order_id=o.id AND al.asset_id=NEW.original_asset_id AND al.status='fulfilled')=1)
BEGIN SELECT RAISE(ABORT,'Invalid replacement completion'); END;

-- 2. While an Asset is under an active replacement commitment
-- (REPLACEMENT_IN_PROGRESS or REPLACEMENT_COMPLETED), its asset_status is
-- frozen. Unrelated Assets and non-critical fields are unaffected.
CREATE TRIGGER trg_replace_commit_asset_status BEFORE UPDATE OF asset_status ON assets
WHEN NEW.asset_status IS NOT OLD.asset_status
 AND EXISTS(SELECT 1 FROM rma_replace_executions e WHERE e.replacement_asset_id=OLD.id AND e.status IN ('REPLACEMENT_IN_PROGRESS','REPLACEMENT_COMPLETED'))
BEGIN SELECT RAISE(ABORT,'Asset is committed as an RMA replacement; critical field change forbidden'); END;
