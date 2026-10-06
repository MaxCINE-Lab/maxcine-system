import { AppError, can, conflict, forbidden, hasGlobalInternationalAccess, type SessionUser } from '@maxcine/shared';
import { z } from 'zod';
import { all, id, one } from './db';
import { requireOrderAccess, requireRmaAccess } from './internationalAuthorization';
import { rmaDetail, rmaList } from './rmaIntake';

export const returnShipmentSchema = z.object({ carrier: z.string().trim().min(1).max(80), returnTracking: z.string().trim().min(1).max(160) }).strict();
export const returnReceiveSchema = z.object({ assetCode: z.string().trim().min(1).max(100) }).strict();
const quarantineLocation = 'loc-uk-return-quarantine';
type ReturnCase = { id: string; assetId: string; orderId: string; warehouseId: string; market: string; stage: string; status: string;
  salesAccountId: string | null; carrier: string; tracking: string; shippedAt: string | null; receivedAt: string | null; assetCode: string };

function requireReturnPermission(user: SessionUser, receive: boolean) {
  if (!hasGlobalInternationalAccess(user) && !can(user, receive ? 'international-return:receive' : 'international-after-sales:manage')) throw forbidden('你没有处理该退货物流操作的权限。');
}
async function scopedReturn(db: D1Database, user: SessionUser, rmaId: string, receive: boolean) {
  requireReturnPermission(user, receive);
  await requireRmaAccess(db, user, rmaId);
  const row = await one<ReturnCase>(db, `SELECT c.id, c.asset_id AS assetId, c.order_id AS orderId, c.return_warehouse_id AS warehouseId,
    c.market_region AS market, c.service_stage AS stage, c.status, c.sales_account_id AS salesAccountId, c.return_carrier AS carrier, c.return_tracking AS tracking,
    c.return_shipped_at AS shippedAt, c.return_received_at AS receivedAt, a.asset_code AS assetCode
    FROM after_sales_cases c JOIN assets a ON a.id=c.asset_id WHERE c.id=? AND c.return_authorized_at IS NOT NULL`, rmaId);
  if (!row) throw conflict('该工单不是已授权的国际 RMA。');
  await requireOrderAccess(db, user, row.orderId);
  if (row.market !== 'UK' || row.warehouseId !== 'wh-uk') throw forbidden('当前退货物流仅允许有权限的 UK 退货仓操作。');
  return row;
}

// Re-check mutable business state inside the same atomic D1 batch. Quarantine
// does not overwrite original certification, sale/allocation, or warranties.
function returnGuard(db: D1Database, row: ReturnCase, receive: boolean, assetCode?: string) {
  return db.prepare(`SELECT CASE WHEN EXISTS (
    SELECT 1 FROM after_sales_cases c JOIN orders o ON o.id=c.order_id JOIN assets a ON a.id=c.asset_id
      JOIN asset_locations l ON l.asset_id=a.id JOIN warehouses w ON w.id=c.return_warehouse_id
    WHERE c.id=? AND c.asset_id=? AND c.order_id=? AND c.return_authorized_at IS NOT NULL
      AND c.status IN ('open','in_progress') AND c.market_region='UK' AND c.return_warehouse_id='wh-uk'
      AND o.status='delivered' AND o.sales_account_id=c.sales_account_id AND o.sales_account_id=? AND o.fulfilment_warehouse_id='wh-uk'
      AND w.market_region='UK' AND w.status='active' AND l.warehouse_id IS NULL
      AND (SELECT COUNT(*) FROM international_asset_allocations al WHERE al.order_id=o.id AND al.asset_id=a.id AND al.status='fulfilled')=1
      AND NOT EXISTS (SELECT 1 FROM international_asset_allocations al WHERE al.asset_id=a.id AND al.status='reserved')
      AND NOT EXISTS (SELECT 1 FROM asset_transfers t WHERE t.asset_id=a.id AND t.status IN ('created','shipped'))
      AND ${receive ? `c.service_stage='RETURN_IN_TRANSIT' AND c.return_shipped_at IS NOT NULL AND c.return_received_at IS NULL
        AND l.custody='RETURN_TRANSIT' AND l.status='in_transit' AND UPPER(a.asset_code)=?
        AND EXISTS (SELECT 1 FROM warehouse_locations area WHERE area.id='${quarantineLocation}' AND area.warehouse_id=w.id)
        AND EXISTS (SELECT 1 FROM asset_events e WHERE e.related_service_case_id=c.id AND e.event_type='return_shipped' AND e.source='international-return-logistics')`
      : `c.service_stage='RETURN_AUTHORIZED' AND c.return_shipped_at IS NULL AND c.return_received_at IS NULL
        AND l.custody='CUSTOMER' AND l.status='delivered'`}
    ) THEN 1 ELSE json('Return state changed') END`).bind(row.id, row.assetId, row.orderId, row.salesAccountId, ...(receive ? [assetCode] : []));
}

function logisticsRecords(db: D1Database, user: SessionUser, row: ReturnCase, now: string, requestId: string, receive: boolean) {
  const event = receive ? 'return_received' : 'return_shipped';
  const metadata = `json_object('rma_id',id,'rma_reference',rma_reference,'asset_id',asset_id,'order_id',order_id,
    'return_warehouse_id',return_warehouse_id,'carrier',return_carrier,'return_tracking',return_tracking,
    'shipped_at',return_shipped_at,'received_at',return_received_at,'inventory_status',${receive ? "'QUARANTINED'" : 'NULL'})`;
  return [
    db.prepare(`INSERT INTO asset_events (id,asset_id,event_type,occurred_at,title,related_order_id,related_service_case_id,operator_user_id,visibility,source,new_value_json)
      SELECT ?,asset_id,?,?,?,order_id,id,?,'admin_private','international-return-logistics',${metadata} FROM after_sales_cases WHERE id=?`)
      .bind(id(), event, now, receive ? 'UK 退货已收货，设备进入隔离库存（不可售）' : '客户退货已寄回', user.id, row.id),
    db.prepare(`INSERT INTO audit_logs (id,actor_id,action,entity_type,entity_id,request_id,after_json)
      SELECT ?,?,?,'after_sales_case',id,?,${metadata} FROM after_sales_cases WHERE id=?`)
      .bind(id(), user.id, `international.rma.${event}`, requestId, row.id)
  ];
}

export async function recordReturnShipment(db: D1Database, user: SessionUser, rmaId: string, input: z.infer<typeof returnShipmentSchema>, requestId: string) {
  const row = await scopedReturn(db, user, rmaId, false);
  const repeated = () => {
    if (!row.shippedAt) return false;
    if (row.carrier !== input.carrier || row.tracking !== input.returnTracking) throw conflict('该 RMA 已记录寄回，Carrier / Tracking 与已有记录不同。');
    return true;
  };
  if (repeated()) return rmaDetail(db, user, rmaId);
  const now = new Date().toISOString();
  try {
    await db.batch([
      returnGuard(db, row, false),
      db.prepare(`UPDATE after_sales_cases SET service_stage='RETURN_IN_TRANSIT',return_carrier=?,return_tracking=?,return_shipped_at=?,updated_at=?,updated_by=? WHERE id=?`)
        .bind(input.carrier, input.returnTracking, now, now, user.id, row.id),
      db.prepare(`UPDATE asset_locations SET custody='RETURN_TRANSIT',status='in_transit',warehouse_id=NULL,location_id=NULL,updated_at=?,updated_by=? WHERE asset_id=?`).bind(now,user.id,row.assetId),
      ...logisticsRecords(db, user, row, now, requestId, false)
    ]);
  } catch (error) {
    if (error instanceof Error && /malformed JSON|Return state changed|UNIQUE constraint failed/i.test(error.message)) {
      const latest = await scopedReturn(db, user, rmaId, false);
      if (latest.shippedAt && latest.carrier === input.carrier && latest.tracking === input.returnTracking) return rmaDetail(db,user,rmaId);
      throw conflict('该 RMA 或设备状态已变化，只有已授权且由客户持有的设备可以记录寄回。');
    }
    throw error;
  }
  return rmaDetail(db,user,rmaId);
}

export async function receiveReturn(db: D1Database, user: SessionUser, rmaId: string, input: z.infer<typeof returnReceiveSchema>, requestId: string) {
  const row = await scopedReturn(db, user, rmaId, true);
  const code = input.assetCode.trim().toUpperCase();
  if (code !== row.assetCode.toUpperCase()) throw conflict('Asset 不匹配：输入的设备与 RMA 预期设备不一致，不能收货。');
  if (row.receivedAt) return rmaDetail(db,user,rmaId);
  const now = new Date().toISOString();
  try {
    await db.batch([
      returnGuard(db,row,true,code),
      db.prepare(`UPDATE after_sales_cases SET status='in_progress',workflow_stage='received',service_stage='RECEIVED',return_received_at=?,updated_at=?,updated_by=? WHERE id=?`).bind(now,now,user.id,row.id),
      db.prepare(`UPDATE assets SET inventory_status='QUARANTINED',updated_at=?,updated_by=? WHERE id=?`).bind(now,user.id,row.assetId),
      db.prepare(`UPDATE asset_locations SET custody='WAREHOUSE',status='returned',warehouse_id='wh-uk',location_id=?,updated_at=?,updated_by=? WHERE asset_id=?`).bind(quarantineLocation,now,user.id,row.assetId),
      ...logisticsRecords(db,user,row,now,requestId,true)
    ]);
  } catch (error) {
    if (error instanceof Error && /malformed JSON|Return state changed|UNIQUE constraint failed/i.test(error.message)) {
      const latest = await scopedReturn(db,user,rmaId,true); if (latest.receivedAt) return rmaDetail(db,user,rmaId);
      throw conflict('退货尚未寄回或状态已变化，不能跳过寄回步骤直接收货。');
    }
    throw error;
  }
  return rmaDetail(db,user,rmaId);
}

export async function awaitingReturnReceipt(db: D1Database,user: SessionUser) {
  requireReturnPermission(user,true);
  return (await rmaList(db,user)).filter((rma) => rma.businessStatus==='RETURN_IN_TRANSIT' && rma.returnWarehouseId==='wh-uk');
}

export async function quarantineInventory(db: D1Database,user: SessionUser) {
  requireReturnPermission(user,true);
  const rows = await all<{ rmaId: string; assetId: string; assetCode: string; productName: string; assetStatus: string; custody: string;
    locationStatus: string; warehouse: string; location: string; rmaReference: string; receivedAt: string }>(db,
    `SELECT c.id AS rmaId,a.id AS assetId,a.asset_code AS assetCode,a.product_name_snapshot AS productName,a.inventory_status AS assetStatus,
      l.custody,l.status AS locationStatus,w.code AS warehouse,area.name AS location,c.rma_reference AS rmaReference,c.return_received_at AS receivedAt
      FROM assets a JOIN asset_locations l ON l.asset_id=a.id JOIN warehouses w ON w.id=l.warehouse_id
      JOIN warehouse_locations area ON area.id=l.location_id JOIN after_sales_cases c ON c.asset_id=a.id
      WHERE a.inventory_status='QUARANTINED' AND l.custody='WAREHOUSE' AND l.warehouse_id='wh-uk'
        AND c.return_received_at IS NOT NULL AND c.return_warehouse_id='wh-uk' ORDER BY c.return_received_at DESC`);
  const visible = [];
  for (const row of rows) {
    try { await requireRmaAccess(db,user,row.rmaId); visible.push(row); }
    catch (error) { if (!(error instanceof AppError && error.status===403)) throw error; }
  }
  return visible;
}

export async function requireNonQuarantined(db: D1Database,assetId: string) {
  if (await one(db,"SELECT id FROM assets WHERE id=? AND inventory_status='QUARANTINED'",assetId)) throw conflict('该设备处于 UK Return Quarantine，不能分配订单或重新 Listing。');
}
