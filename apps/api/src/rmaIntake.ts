import { AppError, badRequest, conflict, forbidden, hasGlobalInternationalAccess, workspaceScopeIds, type SessionUser } from '@maxcine/shared';
import { z } from 'zod';
import { all, id, one } from './db';
import { hashIdentifier } from './auth';
import { requireOrderAccess, requireRmaAccess, requireRmaIntakeAccess } from './internationalAuthorization';
import { internalCertifiedWarranty } from './certifiedWarranty';

export const rmaReasons = ['DEFECTIVE', 'DAMAGED', 'NOT_AS_DESCRIBED', 'BUYER_REMORSE', 'WRONG_ITEM', 'OTHER'] as const;
export const rmaIntakeSchema = z.object({
  orderId: z.string().min(1).max(100), assetId: z.string().uuid(), reason: z.enum(rmaReasons),
  reasonNote: z.string().trim().max(1000).default(''), returnWarehouseId: z.string().min(1).max(100),
  carrier: z.string().trim().max(80).default(''), returnTracking: z.string().trim().max(160).default(''),
  idempotencyKey: z.string().uuid().optional()
}).strict();
type Input = z.infer<typeof rmaIntakeSchema>;

const rmaSelect = `SELECT c.id, c.rma_reference AS rmaReference, c.asset_id AS assetId, a.asset_code AS assetCode,
  a.product_name_snapshot AS productName, c.order_id AS orderId, o.order_no AS orderReference,
  c.market_region AS marketRegion, c.return_reason AS reason, c.reason_note AS reasonNote,
  c.status, CASE WHEN c.status IN ('open','in_progress') THEN 'RETURN_AUTHORIZED' ELSE UPPER(c.status) END AS businessStatus,
  c.return_warehouse_id AS returnWarehouseId, w.code AS returnWarehouse, c.return_carrier AS carrier,
  c.return_tracking AS returnTracking, c.created_at AS createdAt, c.return_authorized_at AS authorizedAt,
  c.rma_warranty_snapshot_json AS warrantySnapshotJson
  FROM after_sales_cases c JOIN assets a ON a.id = c.asset_id JOIN orders o ON o.id = c.order_id
  JOIN warehouses w ON w.id = c.return_warehouse_id`;

export async function rmaDetail(db: D1Database, user: SessionUser, rmaId: string) {
  await requireRmaAccess(db, user, rmaId);
  const row = await one<Record<string, unknown>>(db, `${rmaSelect} WHERE c.id = ? AND c.return_authorized_at IS NOT NULL`, rmaId);
  if (!row) throw conflict('该工单不是国际退货授权 RMA。');
  const { warrantySnapshotJson, ...result } = row;
  return { ...result, warrantySnapshot: warrantySnapshotJson ? JSON.parse(String(warrantySnapshotJson)) : null };
}

export async function rmaList(db: D1Database, user: SessionUser) {
  const accounts = workspaceScopeIds(user, 'salesAccountIds');
  const global = hasGlobalInternationalAccess(user);
  if (!global && !accounts.length) return [];
  const rows = await all<{ id: string }>(db, `SELECT id FROM after_sales_cases WHERE return_authorized_at IS NOT NULL
    AND status IN ('open','in_progress') ${global ? '' : `AND sales_account_id IN (${accounts.map(() => '?').join(',')})`}
    ORDER BY created_at DESC`, ...(global ? [] : accounts));
  const result = [];
  for (const row of rows) {
    try { result.push(await rmaDetail(db, user, row.id)); }
    catch (error) { if (!(error instanceof AppError && error.status === 403)) throw error; }
  }
  return result;
}

export async function rmaIntakeContext(db: D1Database, user: SessionUser, orderId: string) {
  const order = await requireOrderAccess(db, user, orderId);
  await requireRmaIntakeAccess(db, user, orderId, order.fulfilmentWarehouseId ?? '');
  if (order.status !== 'delivered') throw conflict('只有已送达的客户订单可以 Open RMA。');
  const rows = await all<{ assetId: string; assetCode: string; productName: string; orderReference: string; marketRegion: string;
    custody: string; locationStatus: string }>(db, `SELECT a.id AS assetId, a.asset_code AS assetCode, a.product_name_snapshot AS productName,
    o.order_no AS orderReference, account.market_region AS marketRegion, l.custody, l.status AS locationStatus
    FROM orders o JOIN sales_accounts account ON account.id = o.sales_account_id
    JOIN international_asset_allocations al ON al.order_id = o.id AND al.status = 'fulfilled'
    JOIN assets a ON a.id = al.asset_id JOIN asset_locations l ON l.asset_id = a.id WHERE o.id = ?`, orderId);
  if (rows.length !== 1 || rows[0].custody !== 'CUSTOMER' || rows[0].locationStatus !== 'delivered') throw conflict('该订单设备不在客户持有状态，不能 Open RMA。');
  const asset = rows[0];
  if (asset.marketRegion !== 'UK' || order.fulfilmentWarehouseId !== 'wh-uk') throw forbidden('当前仅支持有权限的 UK 客户订单退货授权。');
  const candidates = await all<{ id: string; code: string; name: string }>(db, "SELECT id, code, name FROM warehouses WHERE status = 'active' AND market_region = 'UK' ORDER BY code");
  const warehouses = [];
  for (const warehouse of candidates) {
    try { await requireRmaIntakeAccess(db, user, orderId, warehouse.id); warehouses.push(warehouse); }
    catch (error) { if (!(error instanceof AppError && error.status === 403)) throw error; }
  }
  const active = await one<{ id: string; rmaReference: string | null }>(db, `SELECT id, rma_reference AS rmaReference FROM after_sales_cases
    WHERE asset_id = ? AND status IN ('open','in_progress') LIMIT 1`, asset.assetId);
  return { ...asset, orderId, warehouses, reasons: rmaReasons, activeRma: active,
    warranty: await internalCertifiedWarranty(db, asset.assetId, orderId) };
}

export async function openRma(db: D1Database, user: SessionUser, input: Input, requestId: string) {
  // Scope is enforced before inspecting existing requests or conflict records.
  const scoped = await requireRmaIntakeAccess(db, user, input.orderId, input.returnWarehouseId);
  const fingerprint = await hashIdentifier(JSON.stringify({ ...input, idempotencyKey: undefined }));
  const existingRequest = async () => {
    if (!input.idempotencyKey) return null;
    const row = await one<{ id: string; fingerprint: string }>(db,
      'SELECT id, rma_request_fingerprint AS fingerprint FROM after_sales_cases WHERE rma_idempotency_key = ?', input.idempotencyKey);
    if (!row) return null;
    await requireRmaAccess(db, user, row.id);
    if (row.fingerprint !== fingerprint) throw conflict('重复提交标识已用于另一份 RMA 内容，请刷新工单。');
    return rmaDetail(db, user, row.id);
  };
  const repeated = await existingRequest(); if (repeated) return repeated;
  const context = await rmaIntakeContext(db, user, input.orderId);
  if (context.assetId !== input.assetId) throw conflict('该设备与已送达订单不匹配。');
  if (context.activeRma) throw conflict('该设备已有活动 RMA，请打开现有工单，不要重复创建。');
  const warehouse = await one<{ market: string; status: string }>(db, 'SELECT market_region AS market, status FROM warehouses WHERE id = ?', input.returnWarehouseId);
  if (!warehouse || warehouse.status !== 'active' || warehouse.market === 'TRANSIT') throw badRequest('请选择系统中的有效实体退货仓库，不能使用 Transit。');
  if (warehouse.market !== context.marketRegion) throw forbidden('退货仓库不在该订单的市场范围内。');
  const rmaId = id(); const auditId = id(); const eventId = id(); const now = new Date().toISOString();
  const prefix = `MC-RMA-${now.slice(2,4)}-`;
  try {
    await db.batch([
      db.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM orders o JOIN international_asset_allocations al ON al.order_id = o.id
        JOIN asset_locations l ON l.asset_id = al.asset_id JOIN sales_accounts account ON account.id = o.sales_account_id
        JOIN warehouses w ON w.id = ?
        WHERE o.id = ? AND o.status = 'delivered' AND o.fulfilment_warehouse_id = 'wh-uk' AND o.sales_account_id = ?
          AND account.market_region = 'UK' AND w.market_region = account.market_region AND w.status = 'active'
          AND al.asset_id = ? AND al.status = 'fulfilled' AND l.custody = 'CUSTOMER' AND l.status = 'delivered'
          AND (SELECT COUNT(*) FROM international_asset_allocations x WHERE x.order_id = o.id AND x.status = 'fulfilled') = 1
          AND NOT EXISTS (SELECT 1 FROM after_sales_cases c WHERE c.asset_id = al.asset_id AND c.status IN ('open','in_progress'))
          AND NOT EXISTS (SELECT 1 FROM asset_transfers t WHERE t.asset_id = al.asset_id AND t.status IN ('created','shipped'))
          AND NOT EXISTS (SELECT 1 FROM international_asset_allocations x WHERE x.asset_id = al.asset_id AND x.status = 'reserved')
      ) THEN 1 ELSE json('RMA state changed') END`).bind(input.returnWarehouseId, input.orderId, scoped.salesAccountId, input.assetId),
      db.prepare(`INSERT INTO after_sales_cases (id, case_no, dealer_id, order_id, asset_id, subject, description,
        status, workflow_stage, service_stage, source_role, market_region, channel_id, sales_account_id,
        return_warehouse_id, return_reason, reason_note, return_carrier, return_tracking, rma_reference,
        return_authorized_at, rma_warranty_snapshot_json, rma_idempotency_key, rma_request_fingerprint, created_at, created_by, updated_by)
        SELECT ?, sequence.reference, o.dealer_id, o.id, a.id, 'International RMA return authorization', '',
          'open', 'open', 'RETURN_AUTHORIZED', 'international', account.market_region, o.channel_id, o.sales_account_id,
          ?, ?, ?, ?, ?, sequence.reference, ?,
          json_object('policyCode', a.certified_warranty_policy_code, 'sourceOrderId', a.warranty_source_order_id,
            'marketRegion', a.warranty_market_region, 'start', a.warranty_start_at, 'end', a.warranty_end_at,
            'status', CASE WHEN a.certified_warranty_policy_code IS NULL THEN 'not_activated'
              WHEN a.warranty_override_status IS NOT NULL THEN 'restricted'
              WHEN julianday(a.warranty_start_at) > julianday(?) THEN 'pending'
              WHEN julianday(a.warranty_end_at) <= julianday(?) THEN 'expired' ELSE 'active' END), ?, ?, ?, ?, ?
        FROM orders o JOIN sales_accounts account ON account.id = o.sales_account_id JOIN assets a ON a.id = ?
        CROSS JOIN (SELECT ? || printf('%06d', COALESCE(MAX(CAST(substr(reference,11) AS INTEGER)),0)+1) AS reference
          FROM (SELECT rma_reference AS reference FROM after_sales_cases UNION ALL SELECT case_no FROM after_sales_cases)
          WHERE reference LIKE ?) sequence WHERE o.id = ?`)
        .bind(rmaId, input.returnWarehouseId, input.reason, input.reasonNote, input.carrier, input.returnTracking, now,
          now, now, input.idempotencyKey ?? null, fingerprint, now, user.id, user.id, input.assetId, prefix, `${prefix}%`, input.orderId),
      db.prepare(`INSERT INTO asset_events (id, asset_id, event_type, occurred_at, title, related_order_id, related_service_case_id,
        operator_user_id, visibility, source, new_value_json)
        SELECT ?, asset_id, 'rma_opened', ?, 'RMA 已创建，退货已授权（尚未收货）', order_id, id, ?, 'admin_private', 'international-rma-intake',
          json_object('rma_id', id, 'rma_reference', rma_reference, 'order_id', order_id, 'reason', return_reason,
            'return_warehouse_id', return_warehouse_id, 'market_region', market_region, 'carrier', return_carrier, 'return_tracking', return_tracking)
        FROM after_sales_cases WHERE id = ?`).bind(eventId, now, user.id, rmaId),
      db.prepare(`INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, request_id, after_json)
        SELECT ?, ?, 'international.rma.open', 'after_sales_case', id, ?, json_object('asset_id', asset_id, 'order_id', order_id,
          'sales_account_id', sales_account_id, 'rma_reference', rma_reference, 'reason', return_reason,
          'return_warehouse_id', return_warehouse_id, 'market_region', market_region)
        FROM after_sales_cases WHERE id = ?`).bind(auditId, user.id, requestId, rmaId)
    ]);
  } catch (error) {
    if (error instanceof Error && /malformed JSON|RMA state changed|active RMA|UNIQUE constraint failed/i.test(error.message)) {
      const retry = await existingRequest(); if (retry) return retry;
      throw conflict('设备状态已变化或已有活动 RMA，请刷新后打开现有工单。');
    }
    throw error;
  }
  return rmaDetail(db, user, rmaId);
}
