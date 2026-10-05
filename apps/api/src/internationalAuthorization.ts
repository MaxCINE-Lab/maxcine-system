import {
  notFound,
  requireAssetAccess as requireAssetScope,
  requireOrderAccess as requireOrderScope,
  requireRmaAccess as requireRmaScope,
  type SessionUser
} from '@maxcine/shared';
import { all, one } from './db';

async function assertRmaRecordAccess(db: D1Database, user: SessionUser, record: {
  salesAccountId: string | null; fulfilmentWarehouseId: string | null; assetWarehouseId: string | null;
  returnWarehouseId: string | null; marketRegion: string | null;
}) {
  const warehouseIds = Array.from(new Set([record.returnWarehouseId, record.assetWarehouseId, record.fulfilmentWarehouseId].filter((value): value is string => Boolean(value))));
  const regions = warehouseIds.length ? await all<{ marketRegion: string }>(db,
    `SELECT DISTINCT market_region AS marketRegion FROM warehouses WHERE id IN (${warehouseIds.map(() => '?').join(',')})`, ...warehouseIds) : [];
  requireRmaScope(user, { ...record, scopedWarehouseRegions: regions.map((row) => row.marketRegion) });
}

export async function requireRmaIntakeAccess(db: D1Database, user: SessionUser, orderId: string, returnWarehouseId: string) {
  const order = await requireOrderAccess(db, user, orderId);
  const account = await one<{ marketRegion: string }>(db, 'SELECT market_region AS marketRegion FROM sales_accounts WHERE id = ?', order.salesAccountId);
  await assertRmaRecordAccess(db, user, { ...order, assetWarehouseId: null, returnWarehouseId, marketRegion: account?.marketRegion ?? null });
  return { ...order, marketRegion: account?.marketRegion ?? null };
}

export async function requireAssetAccess(db: D1Database, user: SessionUser, assetId: string): Promise<{ assetId: string; warehouseId: string | null; salesAccountId: string | null; custody: string | null }> {
  const asset = await one<{ assetId: string; warehouseId: string | null; salesAccountId: string | null; custody: string | null }>(db, `
    SELECT assets.id AS assetId, asset_locations.warehouse_id AS warehouseId, asset_locations.custody,
      COALESCE(active_listing.sales_account_id, latest_order.sales_account_id) AS salesAccountId
    FROM assets
    LEFT JOIN asset_locations ON asset_locations.asset_id = assets.id
    LEFT JOIN marketplace_listings active_listing ON active_listing.asset_id = assets.id AND active_listing.status IN ('active','reserved')
    LEFT JOIN international_asset_allocations latest_allocation ON latest_allocation.asset_id = assets.id
      AND latest_allocation.created_at = (SELECT MAX(history.created_at) FROM international_asset_allocations history WHERE history.asset_id = assets.id)
    LEFT JOIN orders latest_order ON latest_order.id = latest_allocation.order_id
    WHERE assets.id = ?`, assetId);
  if (!asset) throw notFound('未找到资产');
  requireAssetScope(user, asset);
  return asset;
}

export async function requireOrderAccess(db: D1Database, user: SessionUser, orderId: string): Promise<{ id: string; salesAccountId: string | null; fulfilmentWarehouseId: string | null; status: string }> {
  const order = await one<{ id: string; salesAccountId: string | null; fulfilmentWarehouseId: string | null; status: string }>(db,
    `SELECT id, sales_account_id AS salesAccountId, fulfilment_warehouse_id AS fulfilmentWarehouseId, status FROM orders WHERE id = ?`, orderId);
  if (!order) throw notFound('未找到订单');
  requireOrderScope(user, order);
  return order;
}

export async function requireRmaAccess(db: D1Database, user: SessionUser, caseId: string, requested?: { returnWarehouseId?: string; marketRegion?: string }): Promise<{ id: string; assetId: string | null; orderId: string | null; returnWarehouseId: string | null; marketRegion: string | null }> {
  const serviceCase = await one<{
    id: string;
    assetId: string | null;
    orderId: string | null;
    salesAccountId: string | null;
    fulfilmentWarehouseId: string | null;
    assetWarehouseId: string | null;
    returnWarehouseId: string | null;
    marketRegion: string | null;
  }>(db, `
    SELECT after_sales_cases.id, after_sales_cases.asset_id AS assetId, after_sales_cases.order_id AS orderId,
      COALESCE(after_sales_cases.sales_account_id, orders.sales_account_id) AS salesAccountId,
      orders.fulfilment_warehouse_id AS fulfilmentWarehouseId,
      asset_locations.warehouse_id AS assetWarehouseId,
      after_sales_cases.return_warehouse_id AS returnWarehouseId,
      after_sales_cases.market_region AS marketRegion
    FROM after_sales_cases
    LEFT JOIN orders ON orders.id = after_sales_cases.order_id
    LEFT JOIN asset_locations ON asset_locations.asset_id = after_sales_cases.asset_id
    WHERE after_sales_cases.id = ?`, caseId);
  if (!serviceCase) throw notFound('未找到售后工单');
  const effectiveReturnWarehouseId = requested?.returnWarehouseId ?? serviceCase.returnWarehouseId;
  const effectiveMarketRegion = requested?.marketRegion ?? serviceCase.marketRegion;
  await assertRmaRecordAccess(db, user, { ...serviceCase, returnWarehouseId: effectiveReturnWarehouseId, marketRegion: effectiveMarketRegion });
  return serviceCase;
}
