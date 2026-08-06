import { Hono, type Context } from 'hono';
import { ZodError, z } from 'zod';
import {
  AppError, adjustInventorySchema, adminReviewAfterSalesSchema, afterSalesAssessmentSchema, afterSalesRecommendationSchema, assignAfterSalesSchema, badRequest, can, canAccessStore, canReadOrder, canTransitionOrder, confirmHistoricalWarrantyImportSchema, conflict, createAfterSalesSchema, createAssetAfterSalesSchema,
  createCustomerRiskRecordSchema, createDealerSchema, createOrderSchema, createProductSchema, createStoreSchema, createUserSchema, forbidden, loginSchema, notFound, orderFulfillmentSchema, passwordChangeSchema, passwordResetSchema, reviewOrderSchema, scanSerialSchema, shipmentSchema, updateAfterSalesSchema, updateAssetSchema, updateCustomerRiskEventSchema, updateCustomerRiskProfileSchema, updateDealerSchema, updateOrderSchema, updateProductSchema, updateStoreSchema, updateUserSchema, updateWatermarkPreferenceSchema,
  adminDamageReviewSchema, confirmQuoteSendSchema, historicalWarrantyPrecheckSchema, HISTORICAL_WARRANTY_COLUMNS, inboundShipmentSchema, inspectionReviewSchema, inspectionSchema, mailPreviewSchema, mailTestSchema, normalizeHistoricalWarrantyRecords, quoteDraftSchema, receiptSchema, shipmentWarrantyDates, shipmentWarrantyRule, updateAssetWarrantySchema, updateRepairMaterialSchema, warrantyDisplayStatus, type ApiErrorBody, type NormalizedWarrantyRecord, type OrderStatus, type SessionUser
} from '@maxcine/shared';
import { all, caseNo, id, one, orderNo } from './db';
import { createSessionToken, hashIdentifier, hashPassword, loadSessionUser, requireAuth, verifyPassword } from './auth';
import { mailSubject, mailTemplates, renderMailHtml, renderMailText, sendEmail, type MailTemplateData, type MailTemplateKey } from './email';
import type { Env, Variables } from './types';

type App = { Bindings: Env; Variables: Variables };
type OrderRow = { id: string; orderNo: string; dealerId: string; storeId: string; status: OrderStatus; totalCents: number; note: string; reviewNote: string; salePriceCents: number | null; shippingAddress: string; customerProfile: string; screenshotDataUrl: string; packageMaterials: string; fulfillmentCarrier: string; fulfillmentTrackingNumber: string; fulfillmentUpdatedAt: string | null; createdAt: string; updatedAt: string; submittedAt: string | null; reviewedAt: string | null };
type OrderItemRow = { id: string; productId: string; name: string; sku: string; productVersion?: string; specification?: string; quantity: number; unitPriceCents: number };
type FulfillmentItemRow = OrderItemRow & { inventoryId: string; availableQuantity: number; reservedQuantity: number };
type DbUser = { id: string; email: string; passwordHash: string; name: string; isActive: number };

const app = new Hono<App>();
const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const localHostnames = new Set(['localhost', '127.0.0.1', '::1']);

function errorResponse(c: Context<App>, error: AppError): Response {
  const payload: ApiErrorBody = { error: { code: error.code, message: error.message, requestId: c.get('requestId') ?? 'unknown', ...(error.details ? { details: error.details } : {}) } };
  return c.json(payload, error.status as 400);
}

function zodDetails(error: ZodError): Record<string, string[]> {
  return error.issues.reduce<Record<string, string[]>>((accumulator, issue) => {
    const field = issue.path.join('.') || 'form';
    accumulator[field] = [...(accumulator[field] ?? []), issue.message];
    return accumulator;
  }, {});
}

function pageValue(value: string | undefined, fallback = 1): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 10000) : fallback;
}

function limitValue(value: string | undefined, fallback = 20): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : fallback;
}

function allowedOrigins(value: string | undefined): string[] {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

function isEquivalentLocalOrigin(origin: string, expected: string): boolean {
  try {
    const originUrl = new URL(origin);
    const expectedUrl = new URL(expected);
    return originUrl.protocol === expectedUrl.protocol
      && originUrl.port === expectedUrl.port
      && localHostnames.has(originUrl.hostname)
      && localHostnames.has(expectedUrl.hostname);
  } catch {
    return false;
  }
}

function isAllowedOrigin(origin: string | undefined, appOrigin: string | undefined): boolean {
  if (!origin) return false;
  return allowedOrigins(appOrigin).some((expected) => origin === expected || isEquivalentLocalOrigin(origin, expected));
}

function statusLabel(status: string): string {
  return ({ draft: '草稿', submitted: '待审核', approved: '审核通过', rejected: '审核未通过', picking: '配货中', packed: '已打包', shipped: '已发货', delivered: '已签收', cancelled: '已取消' } as Record<string, string>)[status] ?? status;
}

function assertPermission(user: SessionUser, permission: Parameters<typeof can>[1]): void {
  if (!can(user, permission)) throw forbidden();
}

// Global GSX access is a permission relationship, never an email, display name,
// legacy users.role value, or assignment scope. It also keeps historical imports
// with no dealer/store relation readable by the super-administrator role.
function hasGlobalAssetAccess(user: SessionUser): boolean {
  return can(user, 'data:read:all');
}

function hasAssetCenterReadAccess(user: SessionUser): boolean {
  return hasGlobalAssetAccess(user) || can(user, 'asset:manage') || user.roles.includes('authorized_service_center');
}

function assertAssetReadAccess(user: SessionUser): void {
  if (!hasAssetCenterReadAccess(user)) throw forbidden();
}

function normalizeLookup(value: string): string {
  return value.replace(/[\r\n\t]/g, '').trim().toUpperCase();
}

function likePattern(value: string, mode: 'prefix' | 'contains'): string {
  const escaped = normalizeLookup(value).replace(/[\\%_]/g, (match) => `\\${match}`);
  return mode === 'prefix' ? `${escaped}%` : `%${escaped}%`;
}

// Creates the matching D1 statement while keeping audit inserts in the same D1 batch as business writes.
function dbAudit(db: D1Database, input: { actorId: string; action: string; entityType: string; entityId: string; requestId: string; before?: unknown; after?: unknown }): D1PreparedStatement {
  return db.prepare(`INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, before_json, after_json, request_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id(), input.actorId, input.action, input.entityType, input.entityId,
      input.before ? JSON.stringify(input.before) : null,
      input.after ? JSON.stringify(input.after) : null,
      input.requestId);
}

async function parseBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw badRequest('提交内容格式有误，请检查后重试');
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw badRequest('请检查填写内容', zodDetails(parsed.error));
  return parsed.data;
}

async function getOrder(db: D1Database, orderId: string): Promise<OrderRow> {
  const order = await one<OrderRow>(db, `SELECT id, order_no AS orderNo, dealer_id AS dealerId, store_id AS storeId, status, total_cents AS totalCents, note,
    review_note AS reviewNote,
    sale_price_cents AS salePriceCents, shipping_address AS shippingAddress, customer_profile AS customerProfile, screenshot_data_url AS screenshotDataUrl,
    package_materials AS packageMaterials, fulfillment_carrier AS fulfillmentCarrier, fulfillment_tracking_number AS fulfillmentTrackingNumber, fulfillment_updated_at AS fulfillmentUpdatedAt,
    created_at AS createdAt, updated_at AS updatedAt, submitted_at AS submittedAt, reviewed_at AS reviewedAt FROM orders WHERE id = ?`, orderId);
  if (!order) throw notFound('未找到该订单');
  return order;
}

function orderForViewer(user: SessionUser, order: OrderRow): OrderRow {
  // Warehouse users need the delivery address to fulfil an order, but not a
  // customer profile, sales amount or the dealer's order screenshot.
  const warehouseOnly = !can(user, 'data:read:all') && can(user, 'order:warehouse-read') && !can(user, 'order:read');
  return warehouseOnly ? { ...order, salePriceCents: null, customerProfile: '', screenshotDataUrl: '' } : order;
}

function assertOrderAccess(user: SessionUser, order: OrderRow): void {
  if (!canReadOrder(user, order)) throw forbidden('你无权查看该订单');
}

function assertStoreAccess(user: SessionUser, storeId: string): void {
  if (!canAccessStore(user, storeId)) throw forbidden('该店铺不在你的授权范围内');
}

function placeholders(values: readonly unknown[]): string {
  if (!values.length) throw forbidden('当前账户没有授权的数据范围');
  return values.map(() => '?').join(',');
}

function notificationScope(user: SessionUser): { sql: string; params: string[] } {
  if (can(user, 'data:read:all')) return { sql: '1 = 1', params: [] };
  if (!user.storeIds.length) return { sql: 'user_id = ?', params: [user.id] };
  return { sql: `(user_id = ? OR store_id IN (${placeholders(user.storeIds)}))`, params: [user.id, ...user.storeIds] };
}

const riskStatusWeight: Record<string, number> = { normal: 0, watchlist: 1, risk: 2, blacklist: 3 };
const riskLevelWeight: Record<string, number> = { low: 0, medium: 1, high: 2 };
const riskStatusText: Record<string, string> = { normal: '正常', watchlist: '观察名单', risk: '风险客户', blacklist: '共享黑名单' };
const riskLevelText: Record<string, string> = { low: '低', medium: '中', high: '高' };
const strongCustomerContactTypes = new Set(['phone', 'platform_nickname', 'wechat', 'qq', 'telegram', 'whatsapp']);

function normalizeRiskContact(type: string, value: string): string {
  const trimmed = value.trim();
  if (type === 'phone') return trimmed.replace(/\D/g, '');
  return trimmed.replace(/\s+/g, '').toUpperCase();
}

function riskLikePattern(value: string): string {
  return `%${value.trim().replace(/[\\%_]/g, (match) => `\\${match}`).toUpperCase()}%`;
}

function riskPrefixPattern(value: string): string {
  return `${value.trim().replace(/[\\%_]/g, (match) => `\\${match}`).toUpperCase()}%`;
}

function parseJsonArray(value: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function strongestByWeight(values: string[], weights: Record<string, number>, fallback: string): string {
  return values.reduce((current, value) => (weights[value] ?? -1) > (weights[current] ?? -1) ? value : current, fallback);
}

type CustomerContactCandidate = { type: string; value: string; normalized: string };
type CustomerRiskInputCustomer = {
  name: string;
  phone: string;
  recipientName: string;
  platformNickname: string;
  wechatNickname: string;
  qqNickname: string;
  telegram: string;
  whatsapp: string;
  shippingAddress: string;
  city: string;
  ipLocation: string;
  keyword: string;
  note: string;
};

function customerRiskContacts(customer: CustomerRiskInputCustomer): CustomerContactCandidate[] {
  const rows: Array<[string, string]> = [
    ['name', customer.name],
    ['phone', customer.phone],
    ['recipient_name', customer.recipientName],
    ['platform_nickname', customer.platformNickname],
    ['wechat', customer.wechatNickname],
    ['qq', customer.qqNickname],
    ['telegram', customer.telegram],
    ['whatsapp', customer.whatsapp],
    ['address', customer.shippingAddress],
    ['city', customer.city],
    ['ip_location', customer.ipLocation],
    ['keyword', customer.keyword]
  ];
  return rows
    .map(([type, value]) => ({ type, value: value.trim(), normalized: normalizeRiskContact(type, value) }))
    .filter((item) => item.value && item.normalized);
}

async function findExistingRiskCustomer(db: D1Database, explicitCustomerId: string | undefined, contacts: CustomerContactCandidate[]): Promise<string | null> {
  if (explicitCustomerId) {
    const existing = await one<{ id: string }>(db, 'SELECT id FROM customers WHERE id = ?', explicitCustomerId);
    if (!existing) throw notFound('未找到该客户档案');
    return existing.id;
  }
  const strong = contacts.filter((item) => strongCustomerContactTypes.has(item.type));
  if (!strong.length) return null;
  const found = await one<{ customerId: string }>(db,
    `SELECT customer_id AS customerId FROM customer_contacts
     WHERE ${strong.map(() => '(contact_type = ? AND normalized_value = ?)').join(' OR ')}
     ORDER BY created_at LIMIT 1`,
    ...strong.flatMap((item) => [item.type, item.normalized]));
  return found?.customerId ?? null;
}

async function dealerForRiskEvent(db: D1Database, user: SessionUser, storeId: string | null | undefined, dealerId: string | null | undefined): Promise<{ dealerId: string | null; storeId: string | null }> {
  if (storeId) {
    if (!can(user, 'customer-risk:manage') && !can(user, 'data:read:all')) assertStoreAccess(user, storeId);
    const store = await one<{ id: string; dealerId: string }>(db, 'SELECT id, dealer_id AS dealerId FROM stores WHERE id = ?', storeId);
    if (!store) throw notFound('未找到该店铺');
    return { dealerId: store.dealerId, storeId: store.id };
  }
  if ((can(user, 'customer-risk:manage') || can(user, 'data:read:all')) && dealerId) {
    const dealer = await one<{ id: string }>(db, 'SELECT id FROM dealers WHERE id = ?', dealerId);
    if (!dealer) throw notFound('未找到该经销商');
    return { dealerId: dealer.id, storeId: null };
  }
  if (user.dealerIds[0]) return { dealerId: user.dealerIds[0], storeId: null };
  if (user.storeIds[0]) {
    const store = await one<{ id: string; dealerId: string }>(db, 'SELECT id, dealer_id AS dealerId FROM stores WHERE id = ?', user.storeIds[0]);
    if (store) return { dealerId: store.dealerId, storeId: store.id };
  }
  if (can(user, 'customer-risk:manage') || can(user, 'data:read:all')) return { dealerId: null, storeId: null };
  throw forbidden('当前账户没有经销商授权，不能登记客户风险');
}

async function recomputeCustomerRiskProfile(db: D1Database, customerId: string, actorId: string): Promise<void> {
  const events = await all<{ status: string; riskLevel: string; riskReasonsJson: string; otherReason: string }>(db,
    'SELECT status, risk_level AS riskLevel, risk_reasons_json AS riskReasonsJson, other_reason AS otherReason FROM customer_risk_events WHERE customer_id = ?', customerId);
  const status = strongestByWeight(events.map((event) => event.status), riskStatusWeight, 'normal');
  const riskLevel = strongestByWeight(events.map((event) => event.riskLevel), riskLevelWeight, 'low');
  const reasons = Array.from(new Set(events.flatMap((event) => parseJsonArray(event.riskReasonsJson))));
  const otherReason = Array.from(new Set(events.map((event) => event.otherReason.trim()).filter(Boolean))).join('；');
  await db.prepare(`UPDATE customer_risk_profiles SET status = ?, risk_level = ?, risk_reasons_json = ?, other_reason = ?,
    registration_count = (SELECT COUNT(*) FROM customer_risk_events WHERE customer_id = ?),
    consultation_count = (SELECT COUNT(*) FROM customer_risk_events WHERE customer_id = ?),
    deal_count = (SELECT COUNT(*) FROM customer_risk_events WHERE customer_id = ? AND consultation_result = '成交'),
    no_deal_count = (SELECT COUNT(*) FROM customer_risk_events WHERE customer_id = ? AND consultation_result = '未成交'),
    involved_dealer_count = (SELECT COUNT(DISTINCT dealer_id) FROM customer_risk_events WHERE customer_id = ? AND dealer_id IS NOT NULL),
    last_consulted_at = (SELECT MAX(happened_at) FROM customer_risk_events WHERE customer_id = ?),
    last_registered_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE customer_id = ?`)
    .bind(status, riskLevel, JSON.stringify(reasons), otherReason, customerId, customerId, customerId, customerId, customerId, customerId, actorId, customerId)
    .run();
  await db.prepare('UPDATE customers SET updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?').bind(actorId, customerId).run();
}

function afterSalesScope(user: SessionUser): { sql: string; params: string[] } {
  if (can(user, 'data:read:all')) return { sql: '1 = 1', params: [] };
  const clauses: string[] = [];
  const params: string[] = [];
  clauses.push('after_sales_cases.created_by = ?');
  params.push(user.id);
  if (user.storeIds.length) {
    clauses.push(`after_sales_cases.store_id IN (${placeholders(user.storeIds)})`);
    params.push(...user.storeIds);
  }
  if (user.serviceCenterIds.length) {
    clauses.push(`EXISTS (SELECT 1 FROM after_sales_assignments asa WHERE asa.case_id = after_sales_cases.id AND asa.service_center_id IN (${placeholders(user.serviceCenterIds)}))`);
    params.push(...user.serviceCenterIds);
  }
  if (!clauses.length) throw forbidden('当前账户没有授权的售后数据范围');
  return { sql: `(${clauses.join(' OR ')})`, params };
}

function canOperateAssignedCase(user: SessionUser, serviceCenterId: string | null): boolean {
  return can(user, 'data:read:all') || Boolean(serviceCenterId && user.serviceCenterIds.includes(serviceCenterId));
}

function afterSalesAssetScope(user: SessionUser, alias = 'assets'): { sql: string; params: string[] } {
  if (can(user, 'data:read:all') || can(user, 'asset:manage') || user.roles.includes('authorized_service_center')) return { sql: '1 = 1', params: [] };
  const clauses: string[] = [];
  const params: string[] = [];
  if (user.storeIds.length) {
    clauses.push(`${alias}.store_id IN (${placeholders(user.storeIds)})`);
    params.push(...user.storeIds);
  }
  if (user.dealerIds.length) {
    clauses.push(`${alias}.dealer_id IN (${placeholders(user.dealerIds)})`);
    params.push(...user.dealerIds);
  }
  if (!clauses.length) throw forbidden('当前账户没有授权的资产数据范围');
  return { sql: `(${clauses.join(' OR ')})`, params };
}

function assetScope(user: SessionUser, _alias = 'assets'): { sql: string; params: string[] } {
  if (hasGlobalAssetAccess(user) || user.roles.includes('authorized_service_center')) return { sql: '1 = 1', params: [] };
  if (can(user, 'asset:manage')) return { sql: '1 = 1', params: [] };
  throw forbidden('当前账户没有授权的资产数据范围');
}

function eventVisibilityScope(user: SessionUser): { sql: string; params: string[] } {
  if (hasGlobalAssetAccess(user)) return { sql: '1 = 1', params: [] };
  if (user.serviceCenterIds.length) return { sql: "visibility IN ('service_center','customer_safe')", params: [] };
  if (user.storeIds.length || user.dealerIds.length) return { sql: "visibility IN ('dealer','customer_safe')", params: [] };
  return { sql: "visibility = 'customer_safe'", params: [] };
}

function productNameSnapshot(version: string): string {
  return version ? `MaxCINE MAVIC 4 Pro 增广镜 · ${version}` : 'MaxCINE 历史产品';
}

function asImportPreviewRow(row: { sourceRowNumber: number; sequence: string; currentSn: string | null; originalSn: string | null; version: string; sourceChannel: string; issues: unknown[] }): Record<string, unknown> {
  return { rowNumber: row.sourceRowNumber, sequence: row.sequence, currentSn: row.currentSn, originalSn: row.originalSn, version: row.version, sourceChannel: row.sourceChannel, issues: row.issues };
}

async function importBatchPreview(db: D1Database, batchId: string) {
  const batch = await one<{ id: string; sourceFilename: string; sourceSheet: string; status: string; totalRows: number; normalRows: number; warningRows: number; errorRows: number; confirmedAt: string | null }>(db,
    `SELECT id, source_filename AS sourceFilename, source_sheet AS sourceSheet, status, total_rows AS totalRows, normal_rows AS normalRows, warning_rows AS warningRows, error_rows AS errorRows, confirmed_at AS confirmedAt FROM asset_import_batches WHERE id = ?`, batchId);
  if (!batch) throw notFound('未找到该历史保修导入批次');
  const rows = await all<{ sourceRowNumber: number; normalizedJson: string; issuesJson: string; disposition: string }>(db,
    `SELECT source_row_number AS sourceRowNumber, normalized_json AS normalizedJson, issues_json AS issuesJson, disposition FROM asset_import_rows WHERE import_batch_id = ? ORDER BY source_row_number`, batchId);
  return {
    batch,
    rows: rows.map((row) => ({ ...asImportPreviewRow({ ...(JSON.parse(row.normalizedJson) as NormalizedWarrantyRecord), issues: JSON.parse(row.issuesJson) }), disposition: row.disposition }))
  };
}

async function runStatementsInChunks(db: D1Database, statements: D1PreparedStatement[], size = 80): Promise<void> {
  for (let offset = 0; offset < statements.length; offset += size) await db.batch(statements.slice(offset, offset + size));
}

async function orderItemsForFulfillment(db: D1Database, orderId: string): Promise<FulfillmentItemRow[]> {
  return all<FulfillmentItemRow>(db,
    `SELECT order_items.id, order_items.product_id AS productId, order_items.product_name_snapshot AS name, order_items.sku_snapshot AS sku,
      products.product_version AS productVersion, products.specification, order_items.quantity, order_items.unit_price_cents AS unitPriceCents,
      inventory.id AS inventoryId, inventory.quantity AS availableQuantity, inventory.reserved_quantity AS reservedQuantity
     FROM order_items JOIN inventory ON inventory.product_id = order_items.product_id LEFT JOIN products ON products.id = order_items.product_id
     WHERE order_items.order_id = ?`, orderId);
}

async function allocatedSerialsForOrder(db: D1Database, orderId: string): Promise<Array<{ id: string; serialNumber: string; productId: string; orderItemId: string; state: string }>> {
  return all<{ id: string; serialNumber: string; productId: string; orderItemId: string; state: string }>(db,
    `SELECT serial_numbers.id, serial_numbers.serial_number AS serialNumber, serial_numbers.product_id AS productId, serial_numbers.order_item_id AS orderItemId, serial_numbers.state
     FROM serial_numbers JOIN order_items ON order_items.id = serial_numbers.order_item_id
     WHERE order_items.order_id = ? AND serial_numbers.state IN ('allocated','shipped')`, orderId);
}

async function findAssetByIdentifier(db: D1Database, serialNumber: string): Promise<{ id: string; currentSn: string | null; productId: string | null; productName: string; version: string; assetStatus: string; dataQualityStatus: string } | null> {
  return one<{ id: string; currentSn: string | null; productId: string | null; productName: string; version: string; assetStatus: string; dataQualityStatus: string }>(db,
    `SELECT assets.id, assets.current_sn AS currentSn, assets.product_id AS productId, assets.product_name_snapshot AS productName, assets.version_snapshot AS version,
      assets.asset_status AS assetStatus, assets.data_quality_status AS dataQualityStatus
     FROM assets LEFT JOIN asset_identifiers ON asset_identifiers.asset_id = assets.id
     WHERE assets.current_sn = ? COLLATE NOCASE OR assets.original_sn = ? COLLATE NOCASE OR asset_identifiers.identifier_value = ? COLLATE NOCASE
     ORDER BY CASE WHEN assets.current_sn = ? COLLATE NOCASE THEN 0 WHEN assets.original_sn = ? COLLATE NOCASE THEN 1 ELSE 2 END, assets.updated_at DESC
     LIMIT 1`, serialNumber, serialNumber, serialNumber, serialNumber, serialNumber);
}

async function allocationStatementsForSerials(db: D1Database, input: { orderId: string; serialNumbers: string[]; actorId: string; allowExistingOnly?: boolean }): Promise<{ statements: D1PreparedStatement[]; serials: Array<{ serialNumber: string; productId: string; orderItemId: string }> }> {
  const items = await orderItemsForFulfillment(db, input.orderId);
  const expected = items.reduce((sum, item) => sum + item.quantity, 0);
  const serialNumbers = input.serialNumbers.map(normalizeLookup).filter(Boolean);
  if (serialNumbers.length !== expected) throw conflict(`应扫描 ${expected} 个 SN，目前扫描了 ${serialNumbers.length} 个`);
  const seen = new Set<string>();
  for (const value of serialNumbers) {
    if (seen.has(value)) throw conflict(`该 SN 已重复扫描：${value}`);
    seen.add(value);
  }
  const existingForOrder = await allocatedSerialsForOrder(db, input.orderId);
  const existingBySerial = new Map(existingForOrder.map((serial) => [normalizeLookup(serial.serialNumber), serial]));
  const counts = new Map(items.map((item) => [item.id, existingForOrder.filter((serial) => serial.orderItemId === item.id).length]));
  const statements: D1PreparedStatement[] = [];
  const serials: Array<{ serialNumber: string; productId: string; orderItemId: string }> = [];
  for (const serialNumber of serialNumbers) {
    const alreadyInOrder = existingBySerial.get(serialNumber);
    if (alreadyInOrder) {
      serials.push({ serialNumber: alreadyInOrder.serialNumber, productId: alreadyInOrder.productId, orderItemId: alreadyInOrder.orderItemId });
      continue;
    }
    if (input.allowExistingOnly) throw conflict(`该 SN 与管理员预留 SN 不一致：${serialNumber}`);
    const existing = await one<{ id: string; state: string; orderId: string | null }>(db,
      `SELECT serial_numbers.id, serial_numbers.state, order_items.order_id AS orderId
       FROM serial_numbers LEFT JOIN order_items ON order_items.id = serial_numbers.order_item_id
       WHERE serial_numbers.serial_number = ? COLLATE NOCASE LIMIT 1`, serialNumber);
    if (existing?.state === 'shipped') throw conflict(`该 SN 已经发货：${serialNumber}`);
    if (existing?.orderId && existing.orderId !== input.orderId) throw conflict(`该 SN 已绑定其他订单：${serialNumber}`);
    const asset = await findAssetByIdentifier(db, serialNumber);
    if (!asset) throw notFound(`该 SN 不存在：${serialNumber}`);
    if (asset.dataQualityStatus !== 'normal' || !asset.currentSn) throw conflict(`该 SN 属于待确认异常标签，不能发货：${serialNumber}`);
    const item = asset.productId
      ? items.find((value) => value.productId === asset.productId)
      : items.find((value) => asset.version && [value.productVersion, value.specification].filter(Boolean).includes(asset.version))
        ?? items.find((value) => asset.productName && asset.productName.includes(value.name))
        ?? (items.length === 1 ? items[0] : null);
    if (!item) throw conflict(`该 SN 不属于本订单产品：${serialNumber}`);
    if ((counts.get(item.id) ?? 0) >= item.quantity) throw conflict(`产品 ${item.name} 已达到订单数量，不能继续绑定 SN`);
    counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
    if (existing?.id) {
      if (existing.state !== 'available') throw conflict(`该 SN 当前不可发货：${serialNumber}`);
      statements.push(db.prepare(`UPDATE serial_numbers SET product_id = ?, state = 'allocated', order_item_id = ?, bound_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ? AND state = 'available'`)
        .bind(item.productId, item.id, input.actorId, existing.id));
    } else {
      statements.push(db.prepare(`INSERT INTO serial_numbers (id, product_id, serial_number, state, order_item_id, bound_at, created_by, updated_by)
        VALUES (?, ?, ?, 'allocated', ?, CURRENT_TIMESTAMP, ?, ?)`).bind(id(), item.productId, serialNumber, item.id, input.actorId, input.actorId));
    }
    serials.push({ serialNumber, productId: item.productId, orderItemId: item.id });
  }
  for (const item of items) {
    const itemCount = serials.filter((serial) => serial.orderItemId === item.id).length;
    if (itemCount !== item.quantity) throw conflict(`产品 ${item.name} 应扫描 ${item.quantity} 个 SN，目前扫描了 ${itemCount} 个`);
  }
  return { statements, serials };
}

async function randomAvailableSerials(db: D1Database, orderId: string): Promise<string[]> {
  const items = await orderItemsForFulfillment(db, orderId);
  const already = await allocatedSerialsForOrder(db, orderId);
  const result: string[] = already.map((serial) => serial.serialNumber);
  for (const item of items) {
    const needed = item.quantity - already.filter((serial) => serial.productId === item.productId).length;
    if (needed <= 0) continue;
    const rows = await all<{ currentSn: string }>(db,
      `SELECT assets.current_sn AS currentSn FROM assets
       WHERE assets.current_sn IS NOT NULL AND assets.product_id = ? AND assets.asset_status IN ('active','returned_to_inventory','refurbished','unknown')
       AND NOT EXISTS (SELECT 1 FROM serial_numbers WHERE serial_numbers.serial_number = assets.current_sn COLLATE NOCASE AND serial_numbers.state IN ('allocated','shipped'))
       ORDER BY assets.updated_at DESC, assets.current_sn LIMIT ?`, item.productId, needed);
    if (rows.length < needed) throw conflict(`产品 ${item.name} 可用 SN 不足，无法随机分配`);
    result.push(...rows.map((row) => row.currentSn));
  }
  return result;
}

const afterSalesCaseTypeLabel: Record<string, string> = {
  OUT_OF_WARRANTY_REPAIR: '保外维修类',
  INSTALLATION_ISSUE: '安装异常类',
  QUALITY_ISSUE: '质量问题类',
  IMAGE_QUALITY_ISSUE: '拍摄效果类',
  MISSING_ACCESSORY: '缺少配件类',
  PART_PURCHASE: '单独购买部件类'
};

function quoteNo(): string {
  return `QT-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
}

function attachmentObjectKey(caseId: string, category: string, filename: string): string {
  const ext = filename.includes('.') ? filename.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
  return `after-sales/${caseId}/${category}/${crypto.randomUUID()}${ext ? `.${ext}` : ''}`;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

async function getCaseForAccess(db: D1Database, user: SessionUser, caseId: string): Promise<{ id: string; dealerId: string; storeId: string | null; serviceCenterId: string | null; serviceStage: string; status: string; assetId: string | null; contactEmail: string; contactName: string | null; caseNo: string; productName: string | null; serialNumber: string | null }> {
  const scope = afterSalesScope(user);
  const serviceCase = await one<{ id: string; dealerId: string; storeId: string | null; serviceCenterId: string | null; serviceStage: string; status: string; assetId: string | null; contactEmail: string; contactName: string | null; caseNo: string; productName: string | null; serialNumber: string | null }>(db,
    `SELECT after_sales_cases.id, after_sales_cases.dealer_id AS dealerId, after_sales_cases.store_id AS storeId, asa.service_center_id AS serviceCenterId,
      after_sales_cases.service_stage AS serviceStage, after_sales_cases.status, after_sales_cases.asset_id AS assetId, after_sales_cases.customer_email AS contactEmail,
      after_sales_cases.contact_name AS contactName, after_sales_cases.case_no AS caseNo, products.name AS productName, after_sales_cases.serial_number AS serialNumber
     FROM after_sales_cases LEFT JOIN after_sales_assignments asa ON asa.case_id = after_sales_cases.id LEFT JOIN products ON products.id = after_sales_cases.product_id
     WHERE after_sales_cases.id = ? AND ${scope.sql}`, caseId, ...scope.params);
  if (!serviceCase) throw forbidden('你无权查看或处理该售后工单');
  return serviceCase;
}

async function countAttachments(db: D1Database, caseId: string, category: string): Promise<number> {
  const row = await one<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM after_sales_attachments WHERE case_id = ? AND category = ?', caseId, category);
  return row?.count ?? 0;
}

type QuoteSnapshotItem = {
  materialId?: string;
  materialCode: string;
  itemName: string;
  itemType: string;
  quantity: number;
  unitPriceCents: number;
  serviceFeeCents: number;
  discountCents: number;
  subtotalCents: number;
  customerNote: string;
};

type QuoteSnapshot = {
  quoteNumber: string;
  quoteVersion: number;
  caseNumber: string;
  reportDate: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  customerAddress: string;
  caseCustomerNote: string;
  caseInternalNote: string;
  productName: string;
  productVersion: string;
  serialNumber: string;
  warrantyStatus: string;
  serviceCenter: string;
  engineer: string;
  inspectedAt: string;
  engineerNote: string;
  testResult: string;
  faultCause: string;
  suggestedAction: string;
  customerDescription: string;
  diagnosisSummary: string;
  liabilityResult: string;
  finalSolution: string;
  quoteItems: QuoteSnapshotItem[];
  subtotalCents: number;
  discountCents: number;
  shippingFeeCents: number;
  grandTotalCents: number;
  currency: string;
  validUntil: string;
  estimatedCycle: string;
  customerNote: string;
  paymentInstructions: string;
  fromEmail: string;
  replyToEmail: string;
  logoUrl?: string;
  pdfObjectKey: string | null;
};

function moneyText(value: number): string {
  return `¥${(value / 100).toFixed(2)}`;
}

function notificationSender(env: Env): { address: string; name: string; replyTo: string; replyToName: string; logoUrl: string } {
  return {
    address: env.NOTIFICATION_EMAIL_FROM || 'notification@maxcine.cn',
    name: env.NOTIFICATION_EMAIL_NAME || '【请勿回复】MaxCINE 服务中心',
    replyTo: env.SUPPORT_EMAIL_REPLY_TO || 'support@maxcine.cn',
    replyToName: env.SUPPORT_EMAIL_REPLY_TO_NAME || 'MaxCINE 客户支持',
    logoUrl: `${env.APP_ORIGIN || 'https://maxcine-web-staging.pages.dev'}/assets/quote-logo.png`
  };
}

function mailEnvironment(env: Env): 'local' | 'staging' | 'production' {
  if (env.APP_ORIGIN?.includes('staging') || env.APP_ORIGIN?.includes('pages.dev')) return 'staging';
  if (env.APP_ORIGIN?.includes('localhost') || env.APP_ORIGIN?.includes('127.0.0.1')) return 'local';
  return 'production';
}

function mailSampleData(env: Env, template: MailTemplateKey): MailTemplateData {
  const sender = notificationSender(env);
  const fields: Record<MailTemplateKey, Array<[string, string]>> = {
    system_test: [['当前 Provider', env.EMAIL_PROVIDER || 'mock'], ['发件人', `${sender.name} <${sender.address}>`], ['Reply-To', `${sender.replyToName} <${sender.replyTo}>`]],
    after_sales_quote: [['案例号', 'CAS-ABCDE-12345'], ['产品 SN', '6901649533304'], ['报价总额', '¥180.00']],
    service_report: [['服务单号', 'CAS-ABCDE-12345'], ['SN', '6901649533304'], ['产品', 'MaxCINE Mavic 4 Pro 增广镜'], ['检测日期', '2026-08-06'], ['保修状态', '保修中']],
    shipment_notice: [['订单号', 'MC-20260806-DEMO'], ['快递公司', '顺丰速运'], ['运单号', 'SF-DEMO-0001']],
    password_reset: [['账号', 'staff@example.test'], ['有效期', '30 分钟']]
  };
  const sections: Record<MailTemplateKey, MailTemplateData['sections']> = {
    system_test: [{ heading: '测试说明', body: '这是一封 MaxCINE Mail Center 系统测试邮件，用于验证模板、发件人、Reply-To 和邮件服务配置。' }],
    after_sales_quote: [{ heading: '检测结果', body: '经检测，产品需要更换部件并完成基础排查。' }, { heading: '最终处理方案', body: '管理员确认后按报价明细执行。' }],
    service_report: [{ heading: '检测结果', body: '外观与功能检测已完成。' }, { heading: '处理方式', body: '按管理员审批结果执行。' }, { heading: '工程师意见', body: '建议按标准流程维修。' }, { heading: '管理员审批', body: '同意按客户确认结果继续处理。' }, { heading: '免责声明', body: '本报告仅用于本次 MaxCINE 售后服务处理，不作为其他用途证明。' }],
    shipment_notice: [{ heading: '发货说明', body: '订单已完成发货确认，请留意物流状态。' }],
    password_reset: [{ heading: '密码重置说明', body: '请使用管理员提供的临时信息完成密码重置，并尽快修改为个人密码。' }]
  };
  return {
    title: mailTemplates[template].name,
    preheader: mailTemplates[template].description,
    logoUrl: sender.logoUrl,
    reference: template === 'service_report' ? '服务单号 CAS-ABCDE-12345' : undefined,
    fields: fields[template],
    sections: sections[template]
  };
}

async function resendDomainStatus(env: Env): Promise<{ status: string; detail: string }> {
  if (env.EMAIL_PROVIDER !== 'resend') return { status: '未启用', detail: '当前 Provider 不是 Resend。' };
  if (!env.RESEND_API_KEY) return { status: '未配置', detail: 'Cloudflare Secret 缺少 RESEND_API_KEY。' };
  try {
    const response = await fetch('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` } });
    const payload = await response.json().catch(() => ({})) as { data?: Array<{ name?: string; status?: string }> };
    const domain = payload.data?.find((item) => item.name?.toLowerCase() === 'maxcine.cn');
    return domain ? { status: domain.status || '未知', detail: `maxcine.cn：${domain.status || '未知'}` } : { status: '需在 Resend 后台确认', detail: '当前 Resend Key 可能仅有发送权限，无法读取域名列表；请以 Resend 后台域名验证状态和测试邮件发送结果为准。' };
  } catch {
    return { status: '检查失败', detail: '无法连接 Resend 域名接口。' };
  }
}

async function sendViaMailCenter(c: Context<App>, input: { template: MailTemplateKey; to: string; subject: string; html: string; text: string; idempotencyKey: string; actorId: string; relatedEntityType?: string; relatedEntityId?: string }): Promise<{ messageId: string; sent: boolean; provider: string; providerMessageId: string; failureReason: string }> {
  const sender = notificationSender(c.env);
  const existing = await one<{ id: string; status: string; providerMessageId: string; failureReason: string; provider: string }>(c.env.DB,
    'SELECT id, status, provider_message_id AS providerMessageId, failure_reason AS failureReason, provider FROM mail_center_messages WHERE idempotency_key = ?', input.idempotencyKey);
  if (existing) return { messageId: existing.id, sent: existing.status === 'sent', provider: existing.provider, providerMessageId: existing.providerMessageId, failureReason: existing.failureReason };
  const delivery = await sendEmail(c.env, { from: sender.address, fromName: sender.name, replyTo: sender.replyTo, replyToName: sender.replyToName, to: input.to, subject: input.subject, html: input.html, text: input.text }, input.idempotencyKey);
  const messageId = id();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO mail_center_messages (id, provider, template_key, subject, to_email, from_email, from_name, reply_to_email, reply_to_name,
      status, failure_reason, provider_message_id, related_entity_type, related_entity_id, idempotency_key, html_content, text_content, sent_by, sent_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'sent' THEN CURRENT_TIMESTAMP ELSE NULL END)`)
      .bind(messageId, delivery.provider, input.template, input.subject, input.to, sender.address, sender.name, sender.replyTo, sender.replyToName,
        delivery.sent ? 'sent' : 'failed', delivery.failureReason, delivery.providerMessageId, input.relatedEntityType ?? '', input.relatedEntityId ?? '',
        input.idempotencyKey, input.html, input.text, input.actorId, delivery.sent ? 'sent' : 'failed'),
    dbAudit(c.env.DB, { actorId: input.actorId, action: delivery.sent ? 'mail.send' : 'mail.send_failed', entityType: 'mail_center_message', entityId: messageId, requestId: c.get('requestId'), after: { template: input.template, provider: delivery.provider, providerMessageId: delivery.providerMessageId, relatedEntityType: input.relatedEntityType, relatedEntityId: input.relatedEntityId } })
  ]);
  return { messageId, sent: delivery.sent, provider: delivery.provider, providerMessageId: delivery.providerMessageId, failureReason: delivery.failureReason };
}

function quoteHtml(snapshot: QuoteSnapshot): string {
  const rows = snapshot.quoteItems.map((item) => `<tr>
    <td style="padding:11px 8px;border-bottom:1px solid #e5e7eb">${escapeHtml(item.materialCode || '—')}</td>
    <td style="padding:11px 8px;border-bottom:1px solid #e5e7eb">${escapeHtml(item.itemName)}</td>
    <td style="padding:11px 8px;border-bottom:1px solid #e5e7eb;text-align:center">${item.quantity}</td>
    <td style="padding:11px 8px;border-bottom:1px solid #e5e7eb;text-align:right">${moneyText(item.unitPriceCents)}</td>
    <td style="padding:11px 8px;border-bottom:1px solid #e5e7eb;text-align:right">${moneyText(item.serviceFeeCents)}</td>
    <td style="padding:11px 8px;border-bottom:1px solid #e5e7eb;text-align:right">${item.discountCents ? `-${moneyText(item.discountCents)}` : '—'}</td>
    <td style="padding:11px 8px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:600">${moneyText(item.subtotalCents)}</td>
    <td style="padding:11px 8px;border-bottom:1px solid #e5e7eb">${escapeHtml(item.customerNote || '—')}</td>
  </tr>`).join('');
  const detailRow = (label: string, value: string) => `<tr><td style="width:120px;padding:7px 0;color:#6b7280;vertical-align:top">${escapeHtml(label)}</td><td style="padding:7px 0;color:#111827">${escapeHtml(value || '暂无数据')}</td></tr>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>产品服务报告书 ${escapeHtml(snapshot.caseNumber)}</title></head>
  <body style="margin:0;background:#f3f4f6;color:#111827;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif">
  <main style="max-width:760px;margin:0 auto;padding:28px 14px"><section style="background:#fff;border:1px solid #e5e7eb;border-radius:18px;overflow:hidden">
  <header style="padding:30px 34px 24px;border-bottom:1px solid #e5e7eb"><img src="${escapeHtml(snapshot.logoUrl || 'https://maxcine-web-staging.pages.dev/assets/quote-logo.png')}" alt="MaxCINE" width="188" style="display:block;width:188px;max-width:54%;height:auto;margin-bottom:26px"><h1 style="margin:0 0 8px;font-size:26px;line-height:1.25">产品服务报告书</h1><p style="margin:0;color:#6b7280;font-size:14px">案例号 ${escapeHtml(snapshot.caseNumber)}</p></header>
  <section style="padding:24px 34px;border-bottom:1px solid #e5e7eb"><h2 style="margin:0 0 12px;font-size:17px">案例详情</h2><table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px">${detailRow('案例号', snapshot.caseNumber)}${detailRow('报告日期', snapshot.reportDate)}${detailRow('客户', snapshot.customerName)}${detailRow('产品', `${snapshot.productName} ${snapshot.productVersion}`.trim())}${detailRow('产品 SN', snapshot.serialNumber)}${detailRow('检测时间', snapshot.inspectedAt)}${detailRow('保障状态', snapshot.warrantyStatus)}${detailRow('服务站点', snapshot.serviceCenter)}${detailRow('检测工程师', snapshot.engineer)}</table></section>
  <section style="padding:24px 34px;border-bottom:1px solid #e5e7eb"><h2 style="margin:0 0 10px;font-size:17px">用户问题描述</h2><p style="margin:0;line-height:1.7;white-space:pre-wrap">${escapeHtml(snapshot.customerDescription || '暂无数据')}</p><h2 style="margin:24px 0 10px;font-size:17px">检测结果</h2><p style="margin:0;line-height:1.7;white-space:pre-wrap">${escapeHtml(snapshot.diagnosisSummary)}</p><h2 style="margin:24px 0 10px;font-size:17px">定责结果</h2><p style="margin:0;line-height:1.7;white-space:pre-wrap">${escapeHtml(snapshot.liabilityResult || '由 MaxCINE 管理员复核确认')}</p><h2 style="margin:24px 0 10px;font-size:17px">最终处理方案</h2><p style="margin:0;line-height:1.7;white-space:pre-wrap">${escapeHtml(snapshot.finalSolution)}</p></section>
  <section style="padding:24px 20px 28px"><h2 style="margin:0 14px 14px;font-size:17px">消耗物料和服务明细</h2><div style="overflow-x:auto"><table style="width:100%;min-width:680px;border-collapse:collapse;font-size:13px"><thead><tr style="background:#f9fafb;color:#4b5563"><th style="padding:10px 8px;text-align:left">料号</th><th style="padding:10px 8px;text-align:left">项目</th><th style="padding:10px 8px">数量</th><th style="padding:10px 8px;text-align:right">单价</th><th style="padding:10px 8px;text-align:right">服务费</th><th style="padding:10px 8px;text-align:right">折扣</th><th style="padding:10px 8px;text-align:right">小计</th><th style="padding:10px 8px;text-align:left">说明</th></tr></thead><tbody>${rows}</tbody></table></div>
  <table role="presentation" style="width:100%;max-width:360px;margin:22px 0 0 auto;border-collapse:collapse;font-size:14px">${detailRow('项目及服务合计', moneyText(snapshot.subtotalCents))}${detailRow('折扣', snapshot.discountCents ? `-${moneyText(snapshot.discountCents)}` : moneyText(0))}${detailRow('运费', moneyText(snapshot.shippingFeeCents))}<tr><td style="padding:12px 0;border-top:1px solid #111827;font-weight:700">总金额</td><td style="padding:12px 0;border-top:1px solid #111827;text-align:right;font-size:20px;font-weight:750">${moneyText(snapshot.grandTotalCents)}</td></tr></table></section>
  <footer style="padding:22px 34px 28px;background:#f9fafb;color:#4b5563;font-size:13px;line-height:1.7"><p style="margin:0 0 6px">报价有效期：${escapeHtml(snapshot.validUntil)}；预计处理周期：${escapeHtml(snapshot.estimatedCycle || '待确认')}</p><p style="margin:0 0 6px">${escapeHtml(snapshot.paymentInstructions || '如需确认本报告，请通过 MaxCINE 客户支持渠道联系我们。')}</p>${snapshot.customerNote ? `<p style="margin:0 0 6px">${escapeHtml(snapshot.customerNote)}</p>` : ''}<p style="margin:18px 0 0">此邮件由 MaxCINE 系统自动发送，请勿回复。如需咨询，请直接发送邮件至 support@maxcine.cn。</p></footer>
  </section></main></body></html>`;
}

function quoteText(snapshot: QuoteSnapshot): string {
  const items = snapshot.quoteItems.map((item) => `${item.materialCode || '—'} ${item.itemName} × ${item.quantity}：${moneyText(item.subtotalCents)}${item.customerNote ? `（${item.customerNote}）` : ''}`).join('\n');
  return `MaxCINE 产品服务报告书
案例号：${snapshot.caseNumber}
客户：${snapshot.customerName}
产品：${snapshot.productName} ${snapshot.productVersion}
产品 SN：${snapshot.serialNumber || '暂无数据'}
保障状态：${snapshot.warrantyStatus || '暂无数据'}
服务站点：${snapshot.serviceCenter || '暂无数据'}
检测工程师：${snapshot.engineer || '暂无数据'}

用户问题描述：
${snapshot.customerDescription || '暂无数据'}

检测结果：
${snapshot.diagnosisSummary}

定责结果：
${snapshot.liabilityResult || '由 MaxCINE 管理员复核确认'}

最终处理方案：
${snapshot.finalSolution}

消耗物料和服务明细：
${items}

项目及服务合计：${moneyText(snapshot.subtotalCents)}
折扣：-${moneyText(snapshot.discountCents)}
运费：${moneyText(snapshot.shippingFeeCents)}
总金额：${moneyText(snapshot.grandTotalCents)}
报价有效期：${snapshot.validUntil}
预计处理周期：${snapshot.estimatedCycle || '待确认'}

${snapshot.paymentInstructions || '如需确认本报告，请通过 MaxCINE 客户支持渠道联系我们。'}

此邮件由 MaxCINE 系统自动发送，请勿回复。如需咨询，请直接发送邮件至 support@maxcine.cn。`;
}

type QuoteCaseContext = {
  id: string;
  caseNo: string;
  caseType: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  customerAddress: string;
  customerDescription: string;
  caseCustomerNote: string;
  caseInternalNote: string;
  productName: string;
  productVersion: string;
  serialNumber: string;
  warrantyStartAt: string | null;
  warrantyEndAt: string | null;
  warrantyOverrideStatus: string | null;
  serviceCenter: string;
  engineer: string;
  inspectedAt: string;
  engineerNote: string;
  testResult: string;
  faultCause: string;
  suggestedAction: string;
};

async function quoteCaseContext(db: D1Database, caseId: string): Promise<QuoteCaseContext> {
  const value = await one<QuoteCaseContext>(db, `SELECT after_sales_cases.id, after_sales_cases.case_no AS caseNo, after_sales_cases.case_type AS caseType,
    COALESCE(after_sales_cases.contact_name, '') AS customerName, COALESCE(after_sales_cases.contact_phone, '') AS customerPhone,
    COALESCE(after_sales_cases.customer_email, '') AS customerEmail, COALESCE(after_sales_cases.customer_address, '') AS customerAddress, COALESCE(after_sales_cases.description, '') AS customerDescription,
    COALESCE(after_sales_cases.customer_note, '') AS caseCustomerNote, COALESCE(after_sales_cases.internal_note, '') AS caseInternalNote,
    COALESCE(products.name, assets.product_name_snapshot, '') AS productName, COALESCE(products.product_version, assets.version_snapshot, '') AS productVersion,
    COALESCE(after_sales_cases.serial_number, assets.current_sn, '') AS serialNumber, assets.warranty_start_at AS warrantyStartAt,
    assets.warranty_end_at AS warrantyEndAt, assets.warranty_override_status AS warrantyOverrideStatus, COALESCE(service_centers.name, '') AS serviceCenter,
    COALESCE(engineer.name, '') AS engineer, COALESCE(inspection.submitted_at, '') AS inspectedAt,
    COALESCE(inspection.engineer_note, '') AS engineerNote, COALESCE(inspection.test_result, '') AS testResult,
    COALESCE(inspection.fault_cause, '') AS faultCause, COALESCE(inspection.suggested_action, '') AS suggestedAction
    FROM after_sales_cases
    LEFT JOIN products ON products.id = after_sales_cases.product_id
    LEFT JOIN assets ON assets.id = after_sales_cases.asset_id
    LEFT JOIN after_sales_assignments assignment ON assignment.id = (
      SELECT latest_assignment.id FROM after_sales_assignments latest_assignment WHERE latest_assignment.case_id = after_sales_cases.id ORDER BY latest_assignment.assigned_at DESC LIMIT 1
    )
    LEFT JOIN service_centers ON service_centers.id = assignment.service_center_id
    LEFT JOIN after_sales_inspections_v2 inspection ON inspection.id = (
      SELECT latest_inspection.id FROM after_sales_inspections_v2 latest_inspection WHERE latest_inspection.case_id = after_sales_cases.id ORDER BY latest_inspection.version DESC LIMIT 1
    )
    LEFT JOIN users engineer ON engineer.id = inspection.submitted_by
    WHERE after_sales_cases.id = ?`, caseId);
  if (!value) throw notFound('未找到该售后工单');
  return value;
}

function quoteAmounts(items: QuoteSnapshotItem[]): { subtotalCents: number; discountCents: number; shippingFeeCents: number; grandTotalCents: number } {
  let subtotalCents = 0;
  let discountCents = 0;
  let shippingFeeCents = 0;
  for (const item of items) {
    const beforeDiscount = item.quantity * item.unitPriceCents + item.serviceFeeCents;
    if (item.itemType === '运费') {
      shippingFeeCents += beforeDiscount - item.discountCents;
    } else if (item.itemType === '折扣' && beforeDiscount < 0) {
      discountCents += Math.abs(beforeDiscount) + item.discountCents;
    } else {
      subtotalCents += beforeDiscount;
      discountCents += item.discountCents;
    }
  }
  return { subtotalCents, discountCents, shippingFeeCents, grandTotalCents: subtotalCents - discountCents + shippingFeeCents };
}

function quoteSnapshotFor(input: {
  quoteNumber: string;
  quoteVersion: number;
  context: QuoteCaseContext;
  inspectionSummary: string;
  finalDecision: string;
  items: QuoteSnapshotItem[];
  currency: string;
  validUntil: string;
  estimatedCycle: string;
  paymentInstructions: string;
  customerNote: string;
  sender: ReturnType<typeof notificationSender>;
}): QuoteSnapshot {
  const amounts = quoteAmounts(input.items);
  const reportDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return {
    quoteNumber: input.quoteNumber,
    quoteVersion: input.quoteVersion,
    caseNumber: input.context.caseNo,
    reportDate,
    customerName: input.context.customerName || '客户',
    customerPhone: input.context.customerPhone,
    customerEmail: input.context.customerEmail,
    customerAddress: input.context.customerAddress,
    caseCustomerNote: input.context.caseCustomerNote,
    caseInternalNote: input.context.caseInternalNote,
    productName: input.context.productName || 'MaxCINE 产品',
    productVersion: input.context.productVersion,
    serialNumber: input.context.serialNumber,
    warrantyStatus: warrantyDisplayStatus({
      warrantyStartAt: input.context.warrantyStartAt,
      warrantyEndAt: input.context.warrantyEndAt,
      warrantyOverrideStatus: input.context.warrantyOverrideStatus
    }),
    serviceCenter: input.context.serviceCenter,
    engineer: input.context.engineer,
    inspectedAt: input.context.inspectedAt,
    engineerNote: input.context.engineerNote,
    testResult: input.context.testResult,
    faultCause: input.context.faultCause,
    suggestedAction: input.context.suggestedAction,
    customerDescription: input.context.customerDescription,
    diagnosisSummary: input.inspectionSummary,
    liabilityResult: input.finalDecision,
    finalSolution: input.finalDecision,
    quoteItems: input.items,
    ...amounts,
    currency: input.currency,
    validUntil: input.validUntil,
    estimatedCycle: input.estimatedCycle,
    customerNote: input.customerNote,
    paymentInstructions: input.paymentInstructions,
    fromEmail: input.sender.address,
    replyToEmail: input.sender.replyTo,
    logoUrl: input.sender.logoUrl,
    pdfObjectKey: null
  };
}

type RepairMaterialRow = {
  id: string; materialCode: string | null; materialName: string; applicableModels: string; description: string;
  outOfWarrantyPriceCents: number | null; priceStatus: string; outOfWarrantyServiceFeeCents: number | null; serviceFeeStatus: string; serviceFeeRuleJson: string;
  retailCategory: string; canReplaceAsWholeSet: number; warrantyPolicy: string; warrantyDays: number | null; warrantyRuleJson: string; active: number; sourceNote: string; dataQualityStatus: string; issuesJson: string; updatedAt: string;
};
type RepairMaterialContext = { assetId: string | null; productId: string | null; productName: string; productVersion: string; materialCode: string; serialNumber: string };

function parseJsonValue<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function modelCandidates(context: RepairMaterialContext | null): string[] {
  if (!context) return [];
  const values = [context.productName, context.productVersion, context.materialCode, context.serialNumber]
    .flatMap((item) => item.split(/[\s/，,;；、]+/g)).map((item) => item.trim()).filter(Boolean);
  const codes = values.flatMap((value) => {
    const upper = value.toUpperCase();
    const match = upper.match(/(?:CG\.)?W(\d{3})/);
    return match ? [upper, `CG.W${match[1]}`, `W${match[1]}`] : [upper];
  });
  return [...new Set(codes)];
}

function codeNumber(value: string): number | null {
  const match = value.toUpperCase().match(/CG\.W(\d{3})/);
  return match ? Number(match[1]) : null;
}

function materialCompatibility(applicableModels: string, context: RepairMaterialContext | null): { status: 'matched' | 'all' | 'unknown' | 'not_applicable'; warning: string } {
  const applicable = applicableModels.trim();
  if (!applicable) return { status: 'unknown', warning: '该物料未标记适用型号，请确认后继续。' };
  if (applicable.toUpperCase() === 'ALL') return { status: 'all', warning: '' };
  if (!context) return { status: 'unknown', warning: '未关联资产型号，请人工确认适配性。' };
  const candidates = modelCandidates(context);
  const parts = applicable.split(/[\s/，,;；、]+/g).map((item) => item.trim().toUpperCase()).filter(Boolean);
  for (const part of parts) {
    const normalized = /^W\d{3}$/.test(part) ? `CG.${part}` : part;
    if (candidates.includes(normalized) || candidates.includes(normalized.replace(/^CG\./, ''))) return { status: 'matched', warning: '' };
    const range = normalized.match(/^CG\.W(\d{3})-CG\.W(\d{3})$/);
    const productCodes = candidates.map((item) => /^W\d{3}$/.test(item) ? `CG.${item}` : item).map(codeNumber).filter((item): item is number => item !== null);
    if (range && productCodes.some((value) => value >= Number(range[1]) && value <= Number(range[2]))) return { status: 'matched', warning: '' };
  }
  return { status: 'not_applicable', warning: '该物料未标记为适用于当前产品，请确认后继续。' };
}

function calculatedServiceFee(material: RepairMaterialRow, context: RepairMaterialContext | null): { cents: number | null; status: string } {
  if (material.serviceFeeStatus === 'fixed' || material.serviceFeeStatus === 'zero') return { cents: material.outOfWarrantyServiceFeeCents ?? 0, status: material.serviceFeeStatus };
  if (material.serviceFeeStatus === 'included') return { cents: 0, status: 'included' };
  if (material.serviceFeeStatus !== 'version_rule') return { cents: null, status: material.serviceFeeStatus || 'missing' };
  const rule = parseJsonValue<{ standard?: number; enhanced?: number; raw?: string }>(material.serviceFeeRuleJson, {});
  const textValue = `${context?.productName ?? ''} ${context?.productVersion ?? ''} ${context?.materialCode ?? ''}`;
  if (/增强|创作|创作者|W102|W103/i.test(textValue) && typeof rule.enhanced === 'number') return { cents: rule.enhanced, status: 'version_rule' };
  if (/标准|官翻|瑕疵|W101|W104|W105/i.test(textValue) && typeof rule.standard === 'number') return { cents: rule.standard, status: 'version_rule' };
  return { cents: null, status: 'manual_confirm' };
}

function materialForResponse(material: RepairMaterialRow, context: RepairMaterialContext | null): RepairMaterialRow & { compatibilityStatus: string; compatibilityWarning: string; calculatedServiceFeeCents: number | null; calculatedServiceFeeStatus: string } {
  const compatibility = materialCompatibility(material.applicableModels, context);
  const fee = calculatedServiceFee(material, context);
  return { ...material, compatibilityStatus: compatibility.status, compatibilityWarning: compatibility.warning, calculatedServiceFeeCents: fee.cents, calculatedServiceFeeStatus: fee.status };
}

async function repairMaterialContext(db: D1Database, assetId: string | null, caseId?: string): Promise<RepairMaterialContext | null> {
  if (!assetId && !caseId) return null;
  return one<RepairMaterialContext>(db, `SELECT assets.id AS assetId, assets.product_id AS productId,
      COALESCE(products.name, assets.product_name_snapshot, '') AS productName,
      COALESCE(products.product_version, assets.version_snapshot, '') AS productVersion,
      COALESCE(products.sku, '') AS materialCode,
      COALESCE(assets.current_sn, '') AS serialNumber
    FROM assets LEFT JOIN products ON products.id = assets.product_id
    ${caseId ? 'JOIN after_sales_cases ON after_sales_cases.asset_id = assets.id' : ''}
    WHERE ${caseId ? 'after_sales_cases.id = ?' : 'assets.id = ?'} LIMIT 1`, caseId ?? assetId);
}

app.use('*', async (c, next) => {
  const requestId = c.req.header('X-Request-ID') ?? crypto.randomUUID();
  c.set('requestId', requestId);
  c.header('X-Request-ID', requestId);
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  const origin = c.req.header('Origin');
  const allowedOrigin = isAllowedOrigin(origin, c.env.APP_ORIGIN);
  if (origin && allowedOrigin) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Access-Control-Allow-Credentials', 'true');
    c.header('Vary', 'Origin');
  }
  if (c.req.method === 'OPTIONS') return c.body(null, 204, { 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Authorization,Content-Type,X-Request-ID' });
  if (unsafeMethods.has(c.req.method) && origin && !allowedOrigin) throw forbidden('当前请求来源无权限提交数据');
  await next();
});

app.onError((error, c) => {
  if (error instanceof AppError) return errorResponse(c, error);
  if (error instanceof ZodError) return errorResponse(c, badRequest('请检查填写内容', zodDetails(error)));
  console.error(JSON.stringify({ requestId: c.get('requestId'), error: error instanceof Error ? error.message : 'Unknown error' }));
  return errorResponse(c, new AppError(500, 'INTERNAL_ERROR', '系统繁忙，请稍后再试'));
});

app.get('/health', (c) => c.json({ ok: true, service: 'maxcine-api', requestId: c.get('requestId') }));

app.get('/repair-materials', requireAuth, async (c) => {
  const user = c.get('user');
  if (!can(user, 'after-sales:damage-assess') && !can(user, 'after-sales:approve') && !can(user, 'data:read:all')) throw forbidden('你无权查看售后物料');
  const url = new URL(c.req.url);
  const q = normalizeLookup(url.searchParams.get('q') ?? '');
  const showAll = url.searchParams.get('showAll') === 'true';
  const assetId = url.searchParams.get('assetId');
  const context = await repairMaterialContext(c.env.DB, assetId);
  const where = showAll ? ['1 = 1'] : ['active = 1'];
  const params: unknown[] = [];
  if (q) {
    where.push(`(material_code LIKE ? ESCAPE '\\' OR material_name LIKE ? ESCAPE '\\' OR source_note LIKE ? ESCAPE '\\')`);
    const pattern = likePattern(q, 'contains');
    params.push(pattern, pattern, pattern);
  }
  const rows = await all<RepairMaterialRow>(c.env.DB, `SELECT id, material_code AS materialCode, material_name AS materialName, applicable_models AS applicableModels, description,
      out_of_warranty_price_cents AS outOfWarrantyPriceCents, price_status AS priceStatus, out_of_warranty_service_fee_cents AS outOfWarrantyServiceFeeCents,
      service_fee_status AS serviceFeeStatus, service_fee_rule_json AS serviceFeeRuleJson, retail_category AS retailCategory, can_replace_as_whole_set AS canReplaceAsWholeSet,
      warranty_policy AS warrantyPolicy, warranty_days AS warrantyDays, warranty_rule_json AS warrantyRuleJson, active, source_note AS sourceNote,
      data_quality_status AS dataQualityStatus, issues_json AS issuesJson, updated_at AS updatedAt
    FROM repair_materials WHERE ${where.join(' AND ')}
    ORDER BY CASE WHEN material_code LIKE 'CG.W1%' THEN 0 ELSE 1 END, material_code COLLATE NOCASE, source_row_number LIMIT 120`, ...params);
  const materials = rows.map((row) => materialForResponse(row, context));
  return c.json({ materials: showAll || !context ? materials : materials.sort((a, b) => {
    const rank = (status: string) => status === 'matched' ? 0 : status === 'all' ? 1 : status === 'unknown' ? 2 : 3;
    return rank(a.compatibilityStatus) - rank(b.compatibilityStatus) || (a.materialCode ?? '').localeCompare(b.materialCode ?? '', 'zh-CN');
  }) });
});

app.patch('/admin/repair-materials/:id', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'after-sales:approve');
  const input = await parseBody(c.req.raw, updateRepairMaterialSchema);
  const before = await one<RepairMaterialRow>(c.env.DB, `SELECT id, material_code AS materialCode, material_name AS materialName, applicable_models AS applicableModels, description,
      out_of_warranty_price_cents AS outOfWarrantyPriceCents, price_status AS priceStatus, out_of_warranty_service_fee_cents AS outOfWarrantyServiceFeeCents,
      service_fee_status AS serviceFeeStatus, service_fee_rule_json AS serviceFeeRuleJson, retail_category AS retailCategory, can_replace_as_whole_set AS canReplaceAsWholeSet,
      warranty_policy AS warrantyPolicy, warranty_days AS warrantyDays, warranty_rule_json AS warrantyRuleJson, active, source_note AS sourceNote,
      data_quality_status AS dataQualityStatus, issues_json AS issuesJson, updated_at AS updatedAt
    FROM repair_materials WHERE id = ?`, c.req.param('id'));
  if (!before) throw notFound('未找到该售后物料');
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE repair_materials SET material_name = ?, applicable_models = ?, description = ?, out_of_warranty_price_cents = ?, price_status = ?,
      out_of_warranty_service_fee_cents = ?, service_fee_status = ?, service_fee_rule_json = ?, retail_category = ?, can_replace_as_whole_set = ?,
      warranty_policy = ?, warranty_days = ?, warranty_rule_json = ?, active = ?, source_note = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?`)
      .bind(input.materialName, input.applicableModels, input.description, input.outOfWarrantyPriceCents, input.priceStatus, input.outOfWarrantyServiceFeeCents, input.serviceFeeStatus,
        input.serviceFeeRuleJson, input.retailCategory, Number(input.canReplaceAsWholeSet), input.warrantyPolicy, input.warrantyDays, input.warrantyRuleJson, Number(input.active), input.sourceNote, user.id, before.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'repair_material.update', entityType: 'repair_material', entityId: before.id, requestId: c.get('requestId'), before, after: input })
  ]);
  return c.json({ id: before.id });
});

app.post('/auth/login', async (c) => {
  const input = await parseBody(c.req.raw, loginSchema);
  const identifierHash = await hashIdentifier(input.email);
  const attempts = await one<{ count: number }>(c.env.DB,
    `SELECT COUNT(*) AS count FROM login_attempts WHERE identifier_hash = ? AND succeeded = 0 AND attempted_at > datetime('now', '-15 minutes')`, identifierHash);
  if ((attempts?.count ?? 0) >= 8) throw new AppError(429, 'RATE_LIMITED', '尝试次数过多，请 15 分钟后再试');
  const user = await one<DbUser>(c.env.DB, `SELECT id, email, password_hash AS passwordHash, name, is_active AS isActive FROM users WHERE email = ?`, input.email);
  const valid = Boolean(user?.isActive && user && await verifyPassword(input.password, user.passwordHash));
  await c.env.DB.prepare('INSERT INTO login_attempts (id, identifier_hash, succeeded) VALUES (?, ?, ?)').bind(id(), identifierHash, valid ? 1 : 0).run();
  if (!valid || !user) throw new AppError(401, 'INVALID_CREDENTIALS', '账号或密码不正确');
  const sessionUser = await loadSessionUser(c.env.DB, user.id);
  if (!sessionUser) throw new AppError(401, 'INVALID_CREDENTIALS', '账号或密码不正确');
  const token = await createSessionToken(sessionUser, c.env.SESSION_SECRET);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(user.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'auth.login', entityType: 'user', entityId: user.id, requestId: c.get('requestId') })
  ]);
  const isSecure = new URL(c.req.url).protocol === 'https:';
  const sameSite = c.env.COOKIE_SAMESITE === 'None' || c.env.COOKIE_SAMESITE === 'Strict' ? c.env.COOKIE_SAMESITE : 'Lax';
  const secure = isSecure || sameSite === 'None';
  c.header('Set-Cookie', `mc_session=${token}; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=28800${secure ? '; Secure' : ''}`);
  return c.json({ user: sessionUser });
});

app.post('/auth/logout', requireAuth, (c) => {
  const sameSite = c.env.COOKIE_SAMESITE === 'None' || c.env.COOKIE_SAMESITE === 'Strict' ? c.env.COOKIE_SAMESITE : 'Lax';
  const secure = new URL(c.req.url).protocol === 'https:' || sameSite === 'None';
  c.header('Set-Cookie', `mc_session=; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=0${secure ? '; Secure' : ''}`);
  return c.body(null, 204);
});

app.get('/me', requireAuth, (c) => c.json({ user: c.get('user') }));

app.get('/stores', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'order:read');
  const stores = can(user, 'data:read:all')
    ? await all<{ id: string; code: string; name: string; platform: string }>(c.env.DB, `SELECT id, code, name, platform FROM stores WHERE status = 'active' ORDER BY name`)
    : await all<{ id: string; code: string; name: string; platform: string }>(c.env.DB,
      `SELECT id, code, name, platform FROM stores WHERE status = 'active' AND id IN (${placeholders(user.storeIds)}) ORDER BY name`, ...user.storeIds);
  return c.json({ stores });
});

app.get('/inventory', requireAuth, async (c) => {
  const user = c.get('user');
  if (!can(user, 'inventory:read') && !can(user, 'catalog:read')) throw forbidden();
  const search = new URL(c.req.url).searchParams.get('search')?.trim() ?? '';
  const items = await all<{ id: string; productId: string; sku: string; name: string; description: string; productVersion: string; specification: string; unitPriceCents: number; availableQuantity: number; reservedQuantity: number; reorderLevel: number; updatedAt: string }>(c.env.DB,
    `SELECT inventory.id, products.id AS productId, products.sku, products.name, products.description, products.product_version AS productVersion, products.specification,
      products.unit_price_cents AS unitPriceCents, inventory.quantity AS availableQuantity, inventory.reserved_quantity AS reservedQuantity, inventory.reorder_level AS reorderLevel,
      inventory.updated_at AS updatedAt
     FROM inventory JOIN products ON products.id = inventory.product_id
     WHERE products.is_active = 1 AND (? = '' OR products.name LIKE '%' || ? || '%' OR products.sku LIKE '%' || ? || '%')
     ORDER BY products.sku`, search, search, search);
  return c.json({ items });
});

app.get('/inventory/:id', requireAuth, async (c) => {
  const user = c.get('user');
  if (!can(user, 'inventory:read') && !can(user, 'catalog:read')) throw forbidden();
  const item = await one<{ id: string; productId: string; sku: string; name: string; description: string; productVersion: string; specification: string; unitPriceCents: number; availableQuantity: number; reservedQuantity: number; reorderLevel: number; updatedAt: string }>(c.env.DB,
    `SELECT inventory.id, products.id AS productId, products.sku, products.name, products.description, products.product_version AS productVersion, products.specification,
      products.unit_price_cents AS unitPriceCents, inventory.quantity AS availableQuantity, inventory.reserved_quantity AS reservedQuantity, inventory.reorder_level AS reorderLevel,
      inventory.updated_at AS updatedAt
     FROM inventory JOIN products ON products.id = inventory.product_id WHERE inventory.id = ?`, c.req.param('id'));
  if (!item) throw notFound('未找到该产品库存');
  return c.json({ item });
});

app.get('/dealer/dashboard', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'order:read');
  const storeScope = can(user, 'data:read:all') ? '' : ` AND store_id IN (${placeholders(user.storeIds)})`;
  const storeParams = can(user, 'data:read:all') ? [] : user.storeIds;
  const [draft, submitted, inventoryAlert, notifications] = await Promise.all([
    one<{ count: number }>(c.env.DB, `SELECT COUNT(*) AS count FROM orders WHERE status = 'draft'${storeScope}`, ...storeParams),
    one<{ count: number }>(c.env.DB, `SELECT COUNT(*) AS count FROM orders WHERE status = 'submitted'${storeScope}`, ...storeParams),
    one<{ count: number }>(c.env.DB, `SELECT COUNT(*) AS count FROM inventory WHERE quantity <= reorder_level`),
    all<{ id: string; title: string; body: string; type: string; link: string | null; createdAt: string; readAt: string | null }>(c.env.DB,
      `SELECT id, title, body, type, link, created_at AS createdAt, read_at AS readAt FROM notifications
       WHERE ${notificationScope(user).sql} ORDER BY created_at DESC LIMIT 6`, ...notificationScope(user).params)
  ]);
  return c.json({
    summary: { draftOrders: draft?.count ?? 0, submittedOrders: submitted?.count ?? 0, inventoryAlerts: inventoryAlert?.count ?? 0 },
    notifications
  });
});

app.get('/customer-risk', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'customer-risk:read');
  const url = new URL(c.req.url);
  const rawQuery = (url.searchParams.get('q') ?? '').trim();
  const terms = [
    url.searchParams.get('phone'),
    url.searchParams.get('name'),
    url.searchParams.get('recipientName'),
    url.searchParams.get('wechatNickname'),
    url.searchParams.get('qqNickname'),
    url.searchParams.get('telegram'),
    url.searchParams.get('whatsapp'),
    url.searchParams.get('platformNickname'),
    url.searchParams.get('address'),
    url.searchParams.get('city'),
    url.searchParams.get('ipLocation'),
    url.searchParams.get('keyword')
  ].map((item) => item?.trim() ?? '').filter(Boolean).slice(0, 12);
  const status = url.searchParams.get('status')?.trim() ?? '';
  const riskLevel = url.searchParams.get('riskLevel')?.trim() ?? '';
  const limit = limitValue(url.searchParams.get('limit') ?? undefined, 20);
  const clauses: string[] = ["EXISTS (SELECT 1 FROM customer_risk_events scoped_events WHERE scoped_events.customer_id = customers.id AND scoped_events.product_scope = 'MAVIC_4_PRO_ANAMORPHIC')"];
  const params: unknown[] = [];
  let prioritySql = '9';
  const priorityParams: unknown[] = [];
  if (['normal', 'watchlist', 'risk', 'blacklist'].includes(status)) { clauses.push('customer_risk_profiles.status = ?'); params.push(status); }
  if (['low', 'medium', 'high'].includes(riskLevel)) { clauses.push('customer_risk_profiles.risk_level = ?'); params.push(riskLevel); }
  if (rawQuery) {
    const exact = rawQuery.toUpperCase();
    const compact = rawQuery.replace(/\s+/g, '').toUpperCase();
    const phone = rawQuery.replace(/\D/g, '');
    const prefix = riskPrefixPattern(rawQuery);
    const pattern = riskLikePattern(rawQuery);
    const compactPattern = riskLikePattern(rawQuery.replace(/\s+/g, ''));
    const platformExact = `(UPPER(customers.platform_nickname) = ? OR EXISTS (SELECT 1 FROM customer_contacts WHERE customer_contacts.customer_id = customers.id AND customer_contacts.contact_type = 'platform_nickname' AND customer_contacts.normalized_value = ?))`;
    const phoneExact = phone ? `(REPLACE(REPLACE(customers.phone, ' ', ''), '-', '') = ? OR EXISTS (SELECT 1 FROM customer_contacts WHERE customer_contacts.customer_id = customers.id AND customer_contacts.contact_type = 'phone' AND customer_contacts.normalized_value = ?))` : '0';
    const ipExact = `(UPPER(customers.ip_location) = ? OR EXISTS (SELECT 1 FROM customer_contacts WHERE customer_contacts.customer_id = customers.id AND customer_contacts.contact_type = 'ip_location' AND customer_contacts.normalized_value = ?))`;
    const otherExact = `(UPPER(customers.display_name) = ? OR UPPER(customers.recipient_name) = ? OR UPPER(customers.wechat_nickname) = ? OR UPPER(customers.qq_nickname) = ? OR UPPER(customers.telegram) = ? OR UPPER(customers.whatsapp) = ? OR UPPER(customers.shipping_address) = ? OR UPPER(customers.city) = ?)`;
    const platformPrefix = `(UPPER(customers.platform_nickname) LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM customer_contacts WHERE customer_contacts.customer_id = customers.id AND customer_contacts.contact_type = 'platform_nickname' AND UPPER(customer_contacts.contact_value) LIKE ? ESCAPE '\\'))`;
    const fuzzy = `(
      UPPER(customers.display_name) LIKE ? ESCAPE '\\'
      OR ${phone ? "REPLACE(REPLACE(customers.phone, ' ', ''), '-', '') LIKE ? ESCAPE '\\' OR" : ''}
      UPPER(customers.recipient_name) LIKE ? ESCAPE '\\'
      OR UPPER(customers.platform_nickname) LIKE ? ESCAPE '\\'
      OR UPPER(customers.wechat_nickname) LIKE ? ESCAPE '\\'
      OR UPPER(customers.qq_nickname) LIKE ? ESCAPE '\\'
      OR UPPER(customers.telegram) LIKE ? ESCAPE '\\'
      OR UPPER(customers.whatsapp) LIKE ? ESCAPE '\\'
      OR UPPER(customers.shipping_address) LIKE ? ESCAPE '\\'
      OR UPPER(customers.city) LIKE ? ESCAPE '\\'
      OR UPPER(customers.ip_location) LIKE ? ESCAPE '\\'
      OR UPPER(customers.note) LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM customer_contacts WHERE customer_contacts.customer_id = customers.id AND (customer_contacts.normalized_value LIKE ? ESCAPE '\\' OR UPPER(customer_contacts.contact_value) LIKE ? ESCAPE '\\'))
      OR EXISTS (SELECT 1 FROM customer_risk_events WHERE customer_risk_events.customer_id = customers.id AND (UPPER(customer_risk_events.note) LIKE ? ESCAPE '\\' OR UPPER(customer_risk_events.risk_reasons_json) LIKE ? ESCAPE '\\' OR UPPER(customer_risk_events.other_reason) LIKE ? ESCAPE '\\'))
    )`;
    clauses.push(`(${platformExact} OR ${phoneExact} OR ${ipExact} OR ${otherExact} OR ${platformPrefix} OR ${fuzzy})`);
    params.push(
      exact, compact,
      ...(phone ? [phone, phone] : []),
      exact, compact,
      exact, exact, exact, exact, exact, exact, exact, exact,
      prefix, prefix,
      pattern,
      ...(phone ? [riskLikePattern(phone)] : []),
      pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern,
      compactPattern, pattern, pattern, pattern, pattern
    );
    prioritySql = `CASE
      WHEN ${platformExact} THEN 1
      WHEN ${phoneExact} THEN 2
      WHEN ${ipExact} THEN 3
      WHEN ${otherExact} THEN 4
      WHEN ${platformPrefix} THEN 5
      ELSE 6
    END`;
    priorityParams.push(
      exact, compact,
      ...(phone ? [phone, phone] : []),
      exact, compact,
      exact, exact, exact, exact, exact, exact, exact, exact,
      prefix, prefix
    );
  }
  for (const term of terms) {
    const pattern = riskLikePattern(term);
    const compactPattern = riskLikePattern(term.replace(/\s+/g, ''));
    clauses.push(`(
      UPPER(customers.display_name) LIKE ? ESCAPE '\\'
      OR UPPER(customers.phone) LIKE ? ESCAPE '\\'
      OR UPPER(customers.recipient_name) LIKE ? ESCAPE '\\'
      OR UPPER(customers.platform_nickname) LIKE ? ESCAPE '\\'
      OR UPPER(customers.wechat_nickname) LIKE ? ESCAPE '\\'
      OR UPPER(customers.qq_nickname) LIKE ? ESCAPE '\\'
      OR UPPER(customers.telegram) LIKE ? ESCAPE '\\'
      OR UPPER(customers.whatsapp) LIKE ? ESCAPE '\\'
      OR UPPER(customers.shipping_address) LIKE ? ESCAPE '\\'
      OR UPPER(customers.city) LIKE ? ESCAPE '\\'
      OR UPPER(customers.ip_location) LIKE ? ESCAPE '\\'
      OR UPPER(customers.note) LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM customer_contacts WHERE customer_contacts.customer_id = customers.id AND (customer_contacts.normalized_value LIKE ? ESCAPE '\\' OR UPPER(customer_contacts.contact_value) LIKE ? ESCAPE '\\'))
      OR EXISTS (SELECT 1 FROM customer_risk_events WHERE customer_risk_events.customer_id = customers.id AND (UPPER(customer_risk_events.note) LIKE ? ESCAPE '\\' OR UPPER(customer_risk_events.risk_reasons_json) LIKE ? ESCAPE '\\' OR UPPER(customer_risk_events.other_reason) LIKE ? ESCAPE '\\'))
    )`);
    params.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, compactPattern, pattern, pattern, pattern, pattern);
  }
  const items = await all<{
    id: string; displayName: string; phone: string; recipientName: string; platformNickname: string; wechatNickname: string; shippingAddress: string; city: string; ipLocation: string; status: string; riskLevel: string; riskReasonsJson: string;
    registrationCount: number; involvedDealerCount: number; consultationCount: number; dealCount: number; noDealCount: number; lastConsultedAt: string | null; updatedAt: string; priority: number;
  }>(c.env.DB, `SELECT customers.id, customers.display_name AS displayName, customers.phone, customers.platform_nickname AS platformNickname,
      customers.recipient_name AS recipientName, customers.wechat_nickname AS wechatNickname, customers.shipping_address AS shippingAddress, customers.city, customers.ip_location AS ipLocation,
      customer_risk_profiles.status, customer_risk_profiles.risk_level AS riskLevel, customer_risk_profiles.risk_reasons_json AS riskReasonsJson,
      customer_risk_profiles.registration_count AS registrationCount, customer_risk_profiles.involved_dealer_count AS involvedDealerCount,
      customer_risk_profiles.consultation_count AS consultationCount, customer_risk_profiles.deal_count AS dealCount, customer_risk_profiles.no_deal_count AS noDealCount,
      customer_risk_profiles.last_consulted_at AS lastConsultedAt, customers.updated_at AS updatedAt, ${prioritySql} AS priority
    FROM customers JOIN customer_risk_profiles ON customer_risk_profiles.customer_id = customers.id
    WHERE ${clauses.join(' AND ')}
    ORDER BY priority,
      CASE customer_risk_profiles.status WHEN 'blacklist' THEN 0 WHEN 'risk' THEN 1 WHEN 'watchlist' THEN 2 ELSE 3 END,
      customer_risk_profiles.updated_at DESC, customers.display_name
    LIMIT ?`, ...priorityParams, ...params, limit);
  return c.json({ items: items.map((item) => ({ ...item, statusText: riskStatusText[item.status] ?? item.status, riskLevelText: riskLevelText[item.riskLevel] ?? item.riskLevel, riskReasons: parseJsonArray(item.riskReasonsJson) })) });
});

app.get('/customer-risk/:id', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'customer-risk:read');
  const customer = await one<{
    id: string; displayName: string; phone: string; recipientName: string; platformNickname: string; wechatNickname: string; qqNickname: string; telegram: string; whatsapp: string;
    shippingAddress: string; city: string; ipLocation: string; note: string; createdAt: string; updatedAt: string; createdByName: string | null; status: string; riskLevel: string; riskReasonsJson: string; otherReason: string;
    firstRegisteredAt: string; lastRegisteredAt: string; registrationCount: number; involvedDealerCount: number; consultationCount: number; dealCount: number; noDealCount: number; lastConsultedAt: string | null;
  }>(c.env.DB, `SELECT customers.id, customers.display_name AS displayName, customers.phone, customers.recipient_name AS recipientName,
      customers.platform_nickname AS platformNickname, customers.wechat_nickname AS wechatNickname, customers.qq_nickname AS qqNickname,
      customers.telegram, customers.whatsapp, customers.shipping_address AS shippingAddress, customers.city, customers.ip_location AS ipLocation, customers.note,
      customers.created_at AS createdAt, customers.updated_at AS updatedAt, creator.name AS createdByName,
      customer_risk_profiles.status, customer_risk_profiles.risk_level AS riskLevel, customer_risk_profiles.risk_reasons_json AS riskReasonsJson, customer_risk_profiles.other_reason AS otherReason,
      customer_risk_profiles.first_registered_at AS firstRegisteredAt, customer_risk_profiles.last_registered_at AS lastRegisteredAt,
      customer_risk_profiles.registration_count AS registrationCount, customer_risk_profiles.involved_dealer_count AS involvedDealerCount,
      customer_risk_profiles.consultation_count AS consultationCount, customer_risk_profiles.deal_count AS dealCount, customer_risk_profiles.no_deal_count AS noDealCount,
      customer_risk_profiles.last_consulted_at AS lastConsultedAt
    FROM customers
    JOIN customer_risk_profiles ON customer_risk_profiles.customer_id = customers.id
    LEFT JOIN users creator ON creator.id = customers.created_by
    WHERE customers.id = ?`, c.req.param('id'));
  if (!customer) throw notFound('未找到该客户风险档案');
  const [contacts, events] = await Promise.all([
    all<{ id: string; contactType: string; contactValue: string; firstSeenAt: string; lastSeenAt: string; createdAt: string }>(c.env.DB,
      'SELECT id, contact_type AS contactType, contact_value AS contactValue, first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt, created_at AS createdAt FROM customer_contacts WHERE customer_id = ? ORDER BY contact_type, created_at', customer.id),
    all<{ id: string; dealerName: string | null; storeName: string | null; productScope: string; consultationResult: string; status: string; riskLevel: string; riskReasonsJson: string; otherReason: string; note: string; happenedAt: string; createdAt: string; createdBy: string | null; createdByName: string | null; updatedAt: string }>(c.env.DB,
      `SELECT customer_risk_events.id, dealers.name AS dealerName, stores.name AS storeName, customer_risk_events.product_scope AS productScope,
        customer_risk_events.consultation_result AS consultationResult, customer_risk_events.status, customer_risk_events.risk_level AS riskLevel,
        customer_risk_events.risk_reasons_json AS riskReasonsJson, customer_risk_events.other_reason AS otherReason, customer_risk_events.note,
        customer_risk_events.happened_at AS happenedAt, customer_risk_events.created_at AS createdAt, customer_risk_events.created_by AS createdBy,
        users.name AS createdByName, customer_risk_events.updated_at AS updatedAt
      FROM customer_risk_events
      LEFT JOIN dealers ON dealers.id = customer_risk_events.dealer_id
      LEFT JOIN stores ON stores.id = customer_risk_events.store_id
      LEFT JOIN users ON users.id = customer_risk_events.created_by
      WHERE customer_risk_events.customer_id = ? AND customer_risk_events.product_scope = 'MAVIC_4_PRO_ANAMORPHIC'
      ORDER BY customer_risk_events.happened_at DESC, customer_risk_events.created_at DESC`, customer.id)
  ]);
  const manage = can(user, 'customer-risk:manage') || can(user, 'data:read:all');
  return c.json({
    customer: { ...customer, statusText: riskStatusText[customer.status] ?? customer.status, riskLevelText: riskLevelText[customer.riskLevel] ?? customer.riskLevel, riskReasons: parseJsonArray(customer.riskReasonsJson) },
    contacts,
    events: events.map((event) => ({ ...event, statusText: riskStatusText[event.status] ?? event.status, riskLevelText: riskLevelText[event.riskLevel] ?? event.riskLevel, riskReasons: parseJsonArray(event.riskReasonsJson), canEdit: manage }))
  });
});

app.patch('/customer-risk/:id', requireAuth, async (c) => {
  const user = c.get('user');
  if (!can(user, 'customer-risk:manage') && !can(user, 'data:read:all')) throw forbidden('只有管理员可以编辑客户风险档案');
  const input = await parseBody(c.req.raw, updateCustomerRiskProfileSchema);
  const current = await one<{
    id: string; displayName: string; phone: string; recipientName: string; platformNickname: string; wechatNickname: string; qqNickname: string; telegram: string; whatsapp: string;
    shippingAddress: string; city: string; ipLocation: string; note: string; status: string; riskLevel: string; riskReasonsJson: string; otherReason: string;
  }>(c.env.DB, `SELECT customers.id, customers.display_name AS displayName, customers.phone, customers.recipient_name AS recipientName,
      customers.platform_nickname AS platformNickname, customers.wechat_nickname AS wechatNickname, customers.qq_nickname AS qqNickname,
      customers.telegram, customers.whatsapp, customers.shipping_address AS shippingAddress, customers.city, customers.ip_location AS ipLocation, customers.note,
      customer_risk_profiles.status, customer_risk_profiles.risk_level AS riskLevel, customer_risk_profiles.risk_reasons_json AS riskReasonsJson, customer_risk_profiles.other_reason AS otherReason
    FROM customers JOIN customer_risk_profiles ON customer_risk_profiles.customer_id = customers.id WHERE customers.id = ?`, c.req.param('id'));
  if (!current) throw notFound('未找到该客户风险档案');
  const inputCustomer = input.customer ?? {};
  const nextCustomer: CustomerRiskInputCustomer = {
    name: inputCustomer.name ?? current.displayName,
    phone: inputCustomer.phone ?? current.phone,
    recipientName: inputCustomer.recipientName ?? current.recipientName,
    platformNickname: inputCustomer.platformNickname ?? current.platformNickname,
    wechatNickname: inputCustomer.wechatNickname ?? current.wechatNickname,
    qqNickname: inputCustomer.qqNickname ?? current.qqNickname,
    telegram: inputCustomer.telegram ?? current.telegram,
    whatsapp: inputCustomer.whatsapp ?? current.whatsapp,
    shippingAddress: inputCustomer.shippingAddress ?? current.shippingAddress,
    city: inputCustomer.city ?? current.city,
    ipLocation: inputCustomer.ipLocation ?? current.ipLocation,
    keyword: inputCustomer.keyword ?? '',
    note: inputCustomer.note ?? current.note
  };
  const nextStatus = input.status ?? current.status;
  const nextRiskLevel = input.riskLevel ?? current.riskLevel;
  const nextReasons = input.riskReasons ?? parseJsonArray(current.riskReasonsJson);
  const nextOtherReason = input.otherReason ?? current.otherReason;
  const contacts = customerRiskContacts(nextCustomer);
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(`UPDATE customers SET display_name = ?, phone = ?, recipient_name = ?, platform_nickname = ?, wechat_nickname = ?, qq_nickname = ?,
      telegram = ?, whatsapp = ?, shipping_address = ?, city = ?, ip_location = ?, note = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?`)
      .bind(nextCustomer.name, nextCustomer.phone, nextCustomer.recipientName, nextCustomer.platformNickname, nextCustomer.wechatNickname, nextCustomer.qqNickname,
        nextCustomer.telegram, nextCustomer.whatsapp, nextCustomer.shippingAddress, nextCustomer.city, nextCustomer.ipLocation, nextCustomer.note, user.id, current.id),
    c.env.DB.prepare(`UPDATE customer_risk_profiles SET status = ?, risk_level = ?, risk_reasons_json = ?, other_reason = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE customer_id = ?`)
      .bind(nextStatus, nextRiskLevel, JSON.stringify(nextReasons), nextOtherReason, user.id, current.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'customer_risk.profile_update', entityType: 'customer', entityId: current.id, requestId: c.get('requestId'), before: current, after: { customer: nextCustomer, status: nextStatus, riskLevel: nextRiskLevel, riskReasons: nextReasons, otherReason: nextOtherReason } })
  ];
  statements.push(...contacts.map((contact) => c.env.DB.prepare(`INSERT INTO customer_contacts (id, customer_id, contact_type, contact_value, normalized_value, created_by)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(customer_id, contact_type, normalized_value) DO UPDATE SET contact_value = excluded.contact_value, last_seen_at = CURRENT_TIMESTAMP`)
    .bind(id(), current.id, contact.type, contact.value, contact.normalized, user.id)));
  await c.env.DB.batch(statements);
  return c.json({ ok: true });
});

app.post('/customer-risk', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'customer-risk:create');
  const input = await parseBody(c.req.raw, createCustomerRiskRecordSchema);
  const riskCustomer: CustomerRiskInputCustomer = {
    name: input.customer.name ?? '',
    phone: input.customer.phone ?? '',
    recipientName: input.customer.recipientName ?? '',
    platformNickname: input.customer.platformNickname ?? '',
    wechatNickname: input.customer.wechatNickname ?? '',
    qqNickname: input.customer.qqNickname ?? '',
    telegram: input.customer.telegram ?? '',
    whatsapp: input.customer.whatsapp ?? '',
    shippingAddress: input.customer.shippingAddress ?? '',
    city: input.customer.city ?? '',
    ipLocation: input.customer.ipLocation ?? '',
    keyword: input.customer.keyword ?? '',
    note: input.customer.note ?? ''
  };
  const contacts = customerRiskContacts(riskCustomer);
  const existingCustomerId = await findExistingRiskCustomer(c.env.DB, input.customerId, contacts);
  const customerId = existingCustomerId ?? id();
  const eventScope = await dealerForRiskEvent(c.env.DB, user, input.storeId, input.dealerId);
  const eventId = id();
  const profileId = id();
  const happenedAt = input.happenedAt || new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  if (!existingCustomerId) {
    statements.push(c.env.DB.prepare(`INSERT INTO customers (id, display_name, phone, recipient_name, platform_nickname, wechat_nickname, qq_nickname, telegram, whatsapp,
      shipping_address, city, ip_location, note, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(customerId, riskCustomer.name, riskCustomer.phone, riskCustomer.recipientName, riskCustomer.platformNickname, riskCustomer.wechatNickname,
        riskCustomer.qqNickname, riskCustomer.telegram, riskCustomer.whatsapp, riskCustomer.shippingAddress, riskCustomer.city, riskCustomer.ipLocation, riskCustomer.note, user.id, user.id));
  } else {
    statements.push(c.env.DB.prepare(`UPDATE customers SET
      display_name = CASE WHEN display_name = '' AND ? != '' THEN ? ELSE display_name END,
      phone = CASE WHEN phone = '' AND ? != '' THEN ? ELSE phone END,
      recipient_name = CASE WHEN recipient_name = '' AND ? != '' THEN ? ELSE recipient_name END,
      platform_nickname = CASE WHEN platform_nickname = '' AND ? != '' THEN ? ELSE platform_nickname END,
      wechat_nickname = CASE WHEN wechat_nickname = '' AND ? != '' THEN ? ELSE wechat_nickname END,
      qq_nickname = CASE WHEN qq_nickname = '' AND ? != '' THEN ? ELSE qq_nickname END,
      telegram = CASE WHEN telegram = '' AND ? != '' THEN ? ELSE telegram END,
      whatsapp = CASE WHEN whatsapp = '' AND ? != '' THEN ? ELSE whatsapp END,
      shipping_address = CASE WHEN shipping_address = '' AND ? != '' THEN ? ELSE shipping_address END,
      city = CASE WHEN city = '' AND ? != '' THEN ? ELSE city END,
      ip_location = CASE WHEN ip_location = '' AND ? != '' THEN ? ELSE ip_location END,
      note = CASE WHEN note = '' AND ? != '' THEN ? ELSE note END,
      updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?`)
      .bind(riskCustomer.name, riskCustomer.name, riskCustomer.phone, riskCustomer.phone, riskCustomer.recipientName, riskCustomer.recipientName,
        riskCustomer.platformNickname, riskCustomer.platformNickname, riskCustomer.wechatNickname, riskCustomer.wechatNickname, riskCustomer.qqNickname, riskCustomer.qqNickname,
        riskCustomer.telegram, riskCustomer.telegram, riskCustomer.whatsapp, riskCustomer.whatsapp, riskCustomer.shippingAddress, riskCustomer.shippingAddress,
        riskCustomer.city, riskCustomer.city, riskCustomer.ipLocation, riskCustomer.ipLocation, riskCustomer.note, riskCustomer.note, user.id, customerId));
  }
  statements.push(c.env.DB.prepare(`INSERT OR IGNORE INTO customer_risk_profiles (id, customer_id, status, risk_level, risk_reasons_json, other_reason, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(profileId, customerId, input.status, input.riskLevel, JSON.stringify(input.riskReasons), input.otherReason, user.id, user.id));
  statements.push(...contacts.map((contact) => c.env.DB.prepare(`INSERT INTO customer_contacts (id, customer_id, contact_type, contact_value, normalized_value, created_by)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(customer_id, contact_type, normalized_value) DO UPDATE SET contact_value = excluded.contact_value, last_seen_at = CURRENT_TIMESTAMP`)
    .bind(id(), customerId, contact.type, contact.value, contact.normalized, user.id)));
  statements.push(c.env.DB.prepare(`INSERT INTO customer_risk_events (id, customer_id, dealer_id, store_id, product_scope, consultation_result, status, risk_level,
    risk_reasons_json, other_reason, note, happened_at, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(eventId, customerId, eventScope.dealerId, eventScope.storeId, input.productScope, input.consultationResult, input.status, input.riskLevel,
      JSON.stringify(input.riskReasons), input.otherReason, input.note, happenedAt, user.id, user.id));
  statements.push(dbAudit(c.env.DB, { actorId: user.id, action: 'customer_risk.record_create', entityType: 'customer', entityId: customerId, requestId: c.get('requestId'), after: { eventId, merged: Boolean(existingCustomerId), status: input.status, riskLevel: input.riskLevel } }));
  await c.env.DB.batch(statements);
  await recomputeCustomerRiskProfile(c.env.DB, customerId, user.id);
  return c.json({ customerId, eventId, merged: Boolean(existingCustomerId) }, 201);
});

app.patch('/customer-risk/events/:eventId', requireAuth, async (c) => {
  const user = c.get('user');
  if (!can(user, 'customer-risk:manage') && !can(user, 'data:read:all')) throw forbidden('只有管理员可以编辑已有咨询记录');
  const input = await parseBody(c.req.raw, updateCustomerRiskEventSchema);
  const event = await one<{ id: string; customerId: string; createdBy: string | null; beforeJson: string }>(c.env.DB,
    `SELECT id, customer_id AS customerId, created_by AS createdBy,
      json_object('status', status, 'riskLevel', risk_level, 'riskReasons', risk_reasons_json, 'consultationResult', consultation_result, 'note', note) AS beforeJson
    FROM customer_risk_events WHERE id = ?`, c.req.param('eventId'));
  if (!event) throw notFound('未找到该咨询记录');
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE customer_risk_events SET status = ?, risk_level = ?, risk_reasons_json = ?, other_reason = ?, consultation_result = ?,
      happened_at = COALESCE(NULLIF(?, ''), happened_at), note = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?`)
      .bind(input.status, input.riskLevel, JSON.stringify(input.riskReasons), input.otherReason, input.consultationResult, input.happenedAt, input.note, user.id, event.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'customer_risk.event_update', entityType: 'customer_risk_event', entityId: event.id, requestId: c.get('requestId'), before: JSON.parse(event.beforeJson), after: input })
  ]);
  await recomputeCustomerRiskProfile(c.env.DB, event.customerId, user.id);
  return c.json({ id: event.id, customerId: event.customerId });
});

app.delete('/customer-risk/events/:eventId', requireAuth, async (c) => {
  const user = c.get('user');
  if (!can(user, 'customer-risk:manage') && !can(user, 'data:read:all')) throw forbidden('只有管理员可以删除错误咨询记录');
  const event = await one<{ id: string; customerId: string; beforeJson: string }>(c.env.DB,
    `SELECT id, customer_id AS customerId,
      json_object('status', status, 'riskLevel', risk_level, 'riskReasons', risk_reasons_json, 'consultationResult', consultation_result, 'note', note) AS beforeJson
    FROM customer_risk_events WHERE id = ?`, c.req.param('eventId'));
  if (!event) throw notFound('未找到该咨询记录');
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM customer_risk_events WHERE id = ?').bind(event.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'customer_risk.event_delete', entityType: 'customer_risk_event', entityId: event.id, requestId: c.get('requestId'), before: JSON.parse(event.beforeJson) })
  ]);
  await recomputeCustomerRiskProfile(c.env.DB, event.customerId, user.id);
  return c.body(null, 204);
});

app.post('/orders', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'order:create');
  const input = await parseBody(c.req.raw, createOrderSchema);
  assertStoreAccess(user, input.storeId);
  const store = await one<{ id: string; dealerId: string }>(c.env.DB, `SELECT stores.id, stores.dealer_id AS dealerId FROM stores JOIN dealers ON dealers.id = stores.dealer_id WHERE stores.id = ? AND stores.status = 'active' AND dealers.status = 'active'`, input.storeId);
  if (!store) throw forbidden('该店铺不可用');
  if (new Set(input.items.map((item) => item.productId)).size !== input.items.length) throw badRequest('同一产品只能添加一次');
  const productIds = input.items.map((item) => item.productId);
  const placeholders = productIds.map(() => '?').join(',');
  const products = await all<{ id: string; sku: string; name: string; price: number; availableQuantity: number }>(c.env.DB,
    `SELECT products.id, products.sku, products.name, products.unit_price_cents AS price, inventory.quantity AS availableQuantity
     FROM products JOIN inventory ON inventory.product_id = products.id WHERE products.is_active = 1 AND products.id IN (${placeholders})`, ...productIds);
  if (products.length !== input.items.length) throw badRequest('部分产品暂不可订购');
  const productsById = new Map(products.map((product) => [product.id, product]));
  const orderId = id();
  const lines = input.items.map((item) => ({ ...item, product: productsById.get(item.productId)! }));
  if (lines.some((line) => line.quantity > line.product.availableQuantity)) throw conflict('订购数量不能超过当前可用库存');
  const total = lines.reduce((sum, line) => sum + line.quantity * line.product.price, 0);
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(`INSERT INTO orders (id, order_no, dealer_id, store_id, note, sale_price_cents, shipping_address, customer_profile, screenshot_data_url, total_cents, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(orderId, orderNo(), store.dealerId, input.storeId, input.note, input.salePriceCents, input.shippingAddress, input.customerProfile, input.screenshotDataUrl, total, user.id, user.id),
    ...lines.map((line) => c.env.DB.prepare(`INSERT INTO order_items (id, order_id, product_id, product_name_snapshot, sku_snapshot, unit_price_cents, quantity, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id(), orderId, line.productId, line.product.name, line.product.sku, line.product.price, line.quantity, user.id, user.id)),
    dbAudit(c.env.DB, { actorId: user.id, action: 'order.create', entityType: 'order', entityId: orderId, requestId: c.get('requestId'), after: { status: 'draft' } })
  ];
  await c.env.DB.batch(statements);
  return c.json({ id: orderId, status: 'draft' }, 201);
});

app.put('/orders/:id', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'order:create');
  const input = await parseBody(c.req.raw, updateOrderSchema);
  const order = await getOrder(c.env.DB, c.req.param('id'));
  assertOrderAccess(user, order);
  if (!['draft', 'rejected'].includes(order.status) || !canAccessStore(user, order.storeId)) throw conflict('只有授权范围内的草稿或已驳回订单可以编辑');
  assertStoreAccess(user, input.storeId);
  const store = await one<{ id: string }>(c.env.DB, 'SELECT id FROM stores WHERE id = ? AND status = \'active\'', input.storeId);
  if (!store) throw forbidden('该店铺不可用');
  if (new Set(input.items.map((item) => item.productId)).size !== input.items.length) throw badRequest('同一产品只能添加一次');
  const productIds = input.items.map((item) => item.productId);
  const products = await all<{ id: string; sku: string; name: string; price: number; availableQuantity: number }>(c.env.DB,
    `SELECT products.id, products.sku, products.name, products.unit_price_cents AS price, inventory.quantity AS availableQuantity
     FROM products JOIN inventory ON inventory.product_id = products.id WHERE products.is_active = 1 AND products.id IN (${productIds.map(() => '?').join(',')})`, ...productIds);
  if (products.length !== input.items.length) throw badRequest('部分产品暂不可订购');
  const productsById = new Map(products.map((product) => [product.id, product]));
  const lines = input.items.map((item) => ({ ...item, product: productsById.get(item.productId)! }));
  if (lines.some((line) => line.quantity > line.product.availableQuantity)) throw conflict('订购数量不能超过当前可用库存');
  const total = lines.reduce((sum, line) => sum + line.quantity * line.product.price, 0);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM order_items WHERE order_id = ?').bind(order.id),
    c.env.DB.prepare(`UPDATE orders SET store_id = ?, status = 'draft', note = ?, sale_price_cents = ?, shipping_address = ?, customer_profile = ?, screenshot_data_url = ?, total_cents = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ? AND status IN ('draft','rejected')`)
      .bind(input.storeId, input.note, input.salePriceCents, input.shippingAddress, input.customerProfile, input.screenshotDataUrl, total, user.id, order.id),
    ...lines.map((line) => c.env.DB.prepare(`INSERT INTO order_items (id, order_id, product_id, product_name_snapshot, sku_snapshot, unit_price_cents, quantity, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id(), order.id, line.productId, line.product.name, line.product.sku, line.product.price, line.quantity, user.id, user.id)),
    dbAudit(c.env.DB, { actorId: user.id, action: 'order.update', entityType: 'order', entityId: order.id, requestId: c.get('requestId'), before: { totalCents: order.totalCents }, after: { totalCents: total, status: 'draft' } })
  ]);
  return c.json({ id: order.id, status: 'draft' });
});

app.delete('/orders/:id', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'order:create');
  const order = await getOrder(c.env.DB, c.req.param('id'));
  assertOrderAccess(user, order);
  if (order.status !== 'draft' || !canAccessStore(user, order.storeId)) throw conflict('只有授权范围内的草稿订单可以删除');
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM orders WHERE id = ? AND status = \'draft\'').bind(order.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'order.delete_draft', entityType: 'order', entityId: order.id, requestId: c.get('requestId'), before: { status: 'draft', orderNo: order.orderNo } })
  ]);
  return c.body(null, 204);
});

app.post('/orders/:id/copy', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'order:create');
  const source = await getOrder(c.env.DB, c.req.param('id'));
  assertOrderAccess(user, source);
  if (source.status !== 'rejected' || !canAccessStore(user, source.storeId)) throw conflict('仅授权范围内审核未通过的订单可以复制');
  const items = await all<{ productId: string; quantity: number; sku: string; name: string; price: number; availableQuantity: number }>(c.env.DB,
    `SELECT order_items.product_id AS productId, order_items.quantity, products.sku, products.name, products.unit_price_cents AS price, inventory.quantity AS availableQuantity
      FROM order_items JOIN products ON products.id = order_items.product_id JOIN inventory ON inventory.product_id = products.id WHERE order_items.order_id = ? AND products.is_active = 1`, source.id);
  if (!items.length || items.some((item) => item.quantity > item.availableQuantity)) throw conflict('原订单中有产品暂时无法复制，请重新选择产品');
  const copiedId = id();
  const total = items.reduce((sum, item) => sum + item.quantity * item.price, 0);
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO orders (id, order_no, dealer_id, store_id, note, total_cents, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(copiedId, orderNo(), source.dealerId, source.storeId, '', total, user.id, user.id),
    ...items.map((item) => c.env.DB.prepare(`INSERT INTO order_items (id, order_id, product_id, product_name_snapshot, sku_snapshot, unit_price_cents, quantity, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id(), copiedId, item.productId, item.name, item.sku, item.price, item.quantity, user.id, user.id)),
    dbAudit(c.env.DB, { actorId: user.id, action: 'order.copy', entityType: 'order', entityId: copiedId, requestId: c.get('requestId'), after: { sourceOrderId: source.id, status: 'draft' } })
  ]);
  return c.json({ id: copiedId, status: 'draft' }, 201);
});

app.get('/orders', requireAuth, async (c) => {
  const user = c.get('user');
  const url = new URL(c.req.url);
  const status = url.searchParams.get('status')?.trim();
  const search = url.searchParams.get('search')?.trim() ?? '';
  const storeId = url.searchParams.get('storeId')?.trim();
  const from = url.searchParams.get('from')?.trim();
  const to = url.searchParams.get('to')?.trim();
  const page = pageValue(url.searchParams.get('page') ?? undefined);
  const limit = limitValue(url.searchParams.get('limit') ?? undefined);
  const where: string[] = [];
  const params: unknown[] = [];
  if (!can(user, 'data:read:all')) {
    if (can(user, 'order:warehouse-read')) {
      where.push(`orders.status IN ('approved','picking','packed','shipped','delivered')`);
    } else {
      assertPermission(user, 'order:read');
      where.push(`orders.store_id IN (${placeholders(user.storeIds)})`);
      params.push(...user.storeIds);
    }
  }
  if (status === 'pending_shipment') where.push(`orders.status IN ('approved','picking','packed')`);
  else if (status && ['draft', 'submitted', 'approved', 'rejected', 'picking', 'packed', 'shipped', 'delivered', 'cancelled'].includes(status)) { where.push('orders.status = ?'); params.push(status); }
  if (search) { where.push('orders.order_no LIKE ?'); params.push(`%${search}%`); }
  if (storeId) {
    if (!canAccessStore(user, storeId) && !can(user, 'order:warehouse-read')) throw forbidden('该店铺不在你的授权范围内');
    where.push('orders.store_id = ?'); params.push(storeId);
  }
  if (from) { where.push('orders.created_at >= ?'); params.push(`${from} 00:00:00`); }
  if (to) { where.push('orders.created_at <= ?'); params.push(`${to} 23:59:59`); }
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const count = await one<{ count: number }>(c.env.DB, `SELECT COUNT(*) AS count FROM orders${clause}`, ...params);
  const orders = await all<OrderRow & { storeName: string; dealerName: string; itemCount: number; itemSummary: string; serialSummary: string }>(c.env.DB,
    `SELECT orders.id, orders.order_no AS orderNo, orders.dealer_id AS dealerId, orders.store_id AS storeId, orders.status, orders.total_cents AS totalCents, orders.note,
      orders.review_note AS reviewNote,
      orders.sale_price_cents AS salePriceCents, orders.shipping_address AS shippingAddress, orders.customer_profile AS customerProfile, orders.screenshot_data_url AS screenshotDataUrl,
      orders.package_materials AS packageMaterials, orders.fulfillment_carrier AS fulfillmentCarrier, orders.fulfillment_tracking_number AS fulfillmentTrackingNumber, orders.fulfillment_updated_at AS fulfillmentUpdatedAt,
      orders.created_at AS createdAt, orders.updated_at AS updatedAt, orders.submitted_at AS submittedAt, orders.reviewed_at AS reviewedAt, stores.name AS storeName, dealers.name AS dealerName,
      COALESCE((SELECT SUM(quantity) FROM order_items WHERE order_id = orders.id), 0) AS itemCount,
      COALESCE((SELECT GROUP_CONCAT(product_name_snapshot || ' ×' || quantity, '、') FROM order_items WHERE order_id = orders.id), '') AS itemSummary,
      COALESCE((SELECT GROUP_CONCAT(serial_number, '、') FROM serial_numbers WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = orders.id) AND state IN ('allocated','shipped')), '') AS serialSummary
     FROM orders JOIN stores ON stores.id = orders.store_id JOIN dealers ON dealers.id = orders.dealer_id${clause} ORDER BY orders.created_at DESC LIMIT ? OFFSET ?`, ...params, limit, (page - 1) * limit);
  return c.json({ orders: orders.map((order) => ({ ...order, ...orderForViewer(user, order) })), pagination: { page, limit, total: count?.count ?? 0, totalPages: Math.max(1, Math.ceil((count?.count ?? 0) / limit)) } });
});

app.get('/orders/:id', requireAuth, async (c) => {
  const user = c.get('user');
  const order = await getOrder(c.env.DB, c.req.param('id'));
  assertOrderAccess(user, order);
  const [items, shipment, overview] = await Promise.all([
    all<OrderItemRow>(c.env.DB, `SELECT order_items.id, order_items.product_id AS productId, order_items.product_name_snapshot AS name, order_items.sku_snapshot AS sku,
      products.product_version AS productVersion, products.specification, order_items.quantity, order_items.unit_price_cents AS unitPriceCents
      FROM order_items LEFT JOIN products ON products.id = order_items.product_id WHERE order_items.order_id = ?`, order.id),
    one<{ id: string; trackingNumber: string; carrier: string; status: string; shippedAt: string }>(c.env.DB, `SELECT id, CASE WHEN tracking_number LIKE 'NO-TRACKING-%' THEN '' ELSE tracking_number END AS trackingNumber, carrier, status, shipped_at AS shippedAt FROM shipments WHERE order_id = ?`, order.id),
    one<{ storeName: string; createdByName: string; reviewedByName: string | null }>(c.env.DB, `SELECT stores.name AS storeName, creator.name AS createdByName, reviewer.name AS reviewedByName
      FROM orders JOIN stores ON stores.id = orders.store_id JOIN users AS creator ON creator.id = orders.created_by
      LEFT JOIN users AS reviewer ON reviewer.id = orders.reviewed_by WHERE orders.id = ?`, order.id)
  ]);
  const serials = await all<{ id: string; productId: string; serialNumber: string; state: string; orderItemId: string }>(c.env.DB,
    `SELECT id, product_id AS productId, serial_number AS serialNumber, state, order_item_id AS orderItemId FROM serial_numbers WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = ?)`, order.id);
  const timeline = [
    { label: '创建订单', at: order.createdAt },
    ...(order.submittedAt ? [{ label: '提交审核', at: order.submittedAt }] : []),
    ...(order.reviewedAt ? [{ label: statusLabel(order.status), at: order.reviewedAt }] : []),
    ...(shipment?.shippedAt ? [{ label: '订单已发货', at: shipment.shippedAt }] : [])
  ];
  return c.json({ order: { ...orderForViewer(user, order), ...overview }, items: items.map((item) => ({ ...item, materialCode: item.sku, warrantyDays: shipmentWarrantyRule(item.sku)?.durationDays ?? null })), serials, shipment, timeline });
});

app.get('/orders/:id/available-serials', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'order:review');
  const order = await getOrder(c.env.DB, c.req.param('id'));
  assertOrderAccess(user, order);
  const items = await orderItemsForFulfillment(c.env.DB, order.id);
  const groups = await Promise.all(items.map(async (item) => {
    const serials = await all<{
      assetId: string;
      serialNumber: string;
      originalSn: string | null;
      assetStatus: string;
      dataQualityStatus: string;
      sourceChannel: string;
      shippingWarehouse: string;
      productNote: string;
      assetNote: string | null;
      allocatedToThisOrder: number;
      updatedAt: string;
    }>(c.env.DB, `SELECT assets.id AS assetId, assets.current_sn AS serialNumber, assets.original_sn AS originalSn,
        assets.asset_status AS assetStatus, assets.data_quality_status AS dataQualityStatus, assets.source_channel AS sourceChannel,
        assets.shipping_warehouse AS shippingWarehouse, COALESCE(products.description, '') AS productNote,
        (SELECT GROUP_CONCAT(content, '；') FROM (SELECT content FROM asset_notes WHERE asset_id = assets.id ORDER BY created_at DESC LIMIT 3)) AS assetNote,
        CASE WHEN assigned_items.order_id = ? THEN 1 ELSE 0 END AS allocatedToThisOrder,
        assets.updated_at AS updatedAt
      FROM assets
      LEFT JOIN products ON products.id = assets.product_id
      LEFT JOIN serial_numbers ON serial_numbers.serial_number = assets.current_sn COLLATE NOCASE AND serial_numbers.state IN ('allocated','shipped')
      LEFT JOIN order_items AS assigned_items ON assigned_items.id = serial_numbers.order_item_id
      WHERE assets.current_sn IS NOT NULL AND (assets.product_id = ? OR (assets.product_id IS NULL AND (
          (? <> '' AND assets.version_snapshot = ?)
          OR (? <> '' AND assets.version_snapshot = ?)
          OR (? <> '' AND assets.product_name_snapshot = ?)
          OR assets.product_name_snapshot LIKE '%' || ? || '%'
        )))
        AND assets.asset_status IN ('active','returned_to_inventory','refurbished','unknown')
        AND (serial_numbers.id IS NULL OR assigned_items.order_id = ?)
      ORDER BY allocatedToThisOrder DESC, assets.updated_at DESC, assets.current_sn COLLATE NOCASE
      LIMIT 200`, order.id, item.productId, item.productVersion ?? '', item.productVersion ?? '', item.specification ?? '', item.specification ?? '', item.name, item.name, item.name, order.id);
    return {
      productId: item.productId,
      productName: item.name,
      sku: item.sku,
      productVersion: item.productVersion ?? '',
      quantity: item.quantity,
      serials
    };
  }));
  return c.json({ groups });
});

app.post('/orders/:id/submit', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'order:submit');
  const order = await getOrder(c.env.DB, c.req.param('id'));
  assertOrderAccess(user, order);
  const dealer = await one<{ id: string }>(c.env.DB, "SELECT id FROM dealers WHERE id = ? AND status = 'active'", order.dealerId);
  if (!dealer) throw forbidden('所属经销商已停用，无法提交订单');
  if ((!canTransitionOrder(user, order.status, 'submitted') && order.status !== 'rejected') || !canAccessStore(user, order.storeId)) throw conflict('该订单暂时不能提交审核');
  const unavailable = await one<{ count: number }>(c.env.DB, `SELECT COUNT(*) AS count FROM order_items
    JOIN inventory ON inventory.product_id = order_items.product_id WHERE order_items.order_id = ? AND order_items.quantity > inventory.quantity`, order.id);
  if ((unavailable?.count ?? 0) > 0) throw conflict('订单中有产品库存不足，请修改后再提交');
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE orders SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ? AND status IN ('draft','rejected')`).bind(user.id, order.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'order.submit', entityType: 'order', entityId: order.id, requestId: c.get('requestId'), before: { status: order.status }, after: { status: 'submitted' } })
  ]);
  return c.json({ id: order.id, status: 'submitted' });
});

app.post('/orders/:id/review', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'order:review');
  const input = await parseBody(c.req.raw, reviewOrderSchema);
  const order = await getOrder(c.env.DB, c.req.param('id'));
  if (!canTransitionOrder(user, order.status, input.approved ? 'approved' : 'rejected')) throw conflict('该订单暂时不能审核');
  const targetStatus: OrderStatus = input.approved ? 'approved' : 'rejected';
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(`UPDATE orders SET status = ?, review_note = ?, reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ? AND status = 'submitted'`)
      .bind(targetStatus, input.note ?? '', user.id, user.id, order.id)
  ];
  if (input.approved) {
    const items = await all<{ productId: string; quantity: number }>(c.env.DB, 'SELECT product_id AS productId, quantity FROM order_items WHERE order_id = ?', order.id);
    for (const item of items) {
      const inventory = await one<{ id: string; quantity: number }>(c.env.DB, 'SELECT id, quantity FROM inventory WHERE product_id = ?', item.productId);
      if (!inventory || inventory.quantity < item.quantity) throw conflict('共享库存不足，无法通过审核');
      statements.push(c.env.DB.prepare(`INSERT INTO inventory_transactions (id, inventory_id, product_id, order_id, transaction_type, quantity_delta, reserved_delta, note, created_by)
        VALUES (?, ?, ?, ?, 'order_reserved', ?, ?, ?, ?)`).bind(id(), inventory.id, item.productId, order.id, -item.quantity, item.quantity, `订单 ${order.orderNo} 审核通过，预留库存`, user.id));
    }
  }
  statements.push(
    c.env.DB.prepare('INSERT INTO notifications (id, dealer_id, store_id, type, title, body, link) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id(), order.dealerId, order.storeId, `order_${targetStatus}`, input.approved ? '订单审核通过' : '订单审核未通过', input.note ?? '', `/system/orders/${order.id}`),
    dbAudit(c.env.DB, { actorId: user.id, action: input.approved ? 'order.approve' : 'order.reject', entityType: 'order', entityId: order.id, requestId: c.get('requestId'), before: { status: 'submitted' }, after: { status: targetStatus } })
  );
  try {
    await c.env.DB.batch(statements);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Inventory cannot be negative')) throw conflict('共享库存不足，无法通过审核');
    throw error;
  }
  return c.json({ id: order.id, status: targetStatus });
});

app.post('/orders/:id/fulfillment', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'order:review');
  const input = await parseBody(c.req.raw, orderFulfillmentSchema);
  const order = await getOrder(c.env.DB, c.req.param('id'));
  if (!['approved', 'picking', 'packed'].includes(order.status)) throw conflict('该订单尚未审核通过，不能安排发货');
  const packageMaterials = input.packageMaterials ?? [];
  const trackingNumber = (input.trackingNumber ?? '').trim();
  const serialNumbers = input.allocationMode === 'random' ? await randomAvailableSerials(c.env.DB, order.id) : input.serialNumbers ?? [];
  const allocation = input.allocationMode === 'none'
    ? { statements: [] as D1PreparedStatement[], serials: await allocatedSerialsForOrder(c.env.DB, order.id) }
    : await allocationStatementsForSerials(c.env.DB, { orderId: order.id, serialNumbers, actorId: user.id });
  await c.env.DB.batch([
    ...allocation.statements,
    c.env.DB.prepare(`UPDATE orders SET package_materials = ?, fulfillment_carrier = ?, fulfillment_tracking_number = ?, fulfillment_updated_at = CURRENT_TIMESTAMP, fulfillment_updated_by = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ? AND status IN ('approved','picking','packed')`)
      .bind(packageMaterials.join('、'), input.carrier, trackingNumber, user.id, user.id, order.id),
    dbAudit(c.env.DB, {
      actorId: user.id,
      action: 'order.fulfillment_plan',
      entityType: 'order',
      entityId: order.id,
      requestId: c.get('requestId'),
      after: { packageMaterials, carrier: input.carrier, trackingNumber, allocationMode: input.allocationMode, serialCount: allocation.serials.length }
    })
  ]);
  return c.json({ id: order.id, status: order.status, serialNumbers: allocation.serials.map((serial) => serial.serialNumber), trackingNumber });
});

app.post('/orders/:id/cancel', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'order:review');
  const order = await getOrder(c.env.DB, c.req.param('id'));
  if (!canTransitionOrder(user, order.status, 'cancelled')) throw conflict('当前订单不能取消');
  const items = await all<{ productId: string; quantity: number }>(c.env.DB, 'SELECT product_id AS productId, quantity FROM order_items WHERE order_id = ?', order.id);
  const inventory = await all<{ id: string; productId: string }>(c.env.DB, `SELECT id, product_id AS productId FROM inventory WHERE product_id IN (${items.map(() => '?').join(',')})`, ...items.map((item) => item.productId));
  const inventoryByProduct = new Map(inventory.map((entry) => [entry.productId, entry]));
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE orders SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ? AND status = 'approved'`).bind(user.id, order.id),
    ...items.map((item) => { const entry = inventoryByProduct.get(item.productId); if (!entry) throw notFound('未找到对应库存'); return c.env.DB.prepare(`INSERT INTO inventory_transactions (id, inventory_id, product_id, order_id, transaction_type, quantity_delta, reserved_delta, note, created_by) VALUES (?, ?, ?, ?, 'order_released', ?, ?, ?, ?)`).bind(id(), entry.id, item.productId, order.id, item.quantity, -item.quantity, `订单 ${order.orderNo} 已取消，释放预留库存`, user.id); }),
    c.env.DB.prepare('INSERT INTO notifications (id, dealer_id, store_id, type, title, body, link) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id(), order.dealerId, order.storeId, 'order_cancelled', '订单已取消', '订单已取消，预留库存已释放。', `/system/orders/${order.id}`),
    dbAudit(c.env.DB, { actorId: user.id, action: 'order.cancel', entityType: 'order', entityId: order.id, requestId: c.get('requestId'), before: { status: 'approved' }, after: { status: 'cancelled' } })
  ]);
  return c.json({ id: order.id, status: 'cancelled' });
});

app.post('/orders/:id/picking', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'order:fulfill');
  const order = await getOrder(c.env.DB, c.req.param('id'));
  assertOrderAccess(user, order);
  if (!canTransitionOrder(user, order.status, 'picking')) throw conflict('该订单暂时不能开始配货');
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE orders SET status = 'picking', updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ? AND status = 'approved'`).bind(user.id, order.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'warehouse.start_picking', entityType: 'order', entityId: order.id, requestId: c.get('requestId'), before: { status: 'approved' }, after: { status: 'picking' } })
  ]);
  return c.json({ id: order.id, status: 'picking' });
});

app.post('/orders/:id/serials', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'order:fulfill');
  const input = await parseBody(c.req.raw, scanSerialSchema);
  const order = await getOrder(c.env.DB, c.req.param('id'));
  assertOrderAccess(user, order);
  if (order.status !== 'picking') throw conflict('仅配货中的订单可以录入 SN');
  const item = await one<OrderItemRow>(c.env.DB, `SELECT id, product_id AS productId, product_name_snapshot AS name, sku_snapshot AS sku, quantity, unit_price_cents AS unitPriceCents
    FROM order_items WHERE order_id = ? AND product_id = ?`, order.id, input.productId);
  if (!item) throw badRequest('该产品不在订单中');
  const count = await one<{ count: number }>(c.env.DB, `SELECT COUNT(*) AS count FROM serial_numbers WHERE order_item_id = ? AND state IN ('allocated','shipped')`, item.id);
  if ((count?.count ?? 0) >= item.quantity) throw conflict('该产品已完成 SN 录入');
  const existing = await one<{ id: string }>(c.env.DB, 'SELECT id FROM serial_numbers WHERE serial_number = ?', input.serialNumber);
  if (existing) throw conflict('该 SN 已被绑定，不能重复录入');
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO serial_numbers (id, product_id, serial_number, state, order_item_id, bound_at, created_by, updated_by)
      VALUES (?, ?, ?, 'allocated', ?, CURRENT_TIMESTAMP, ?, ?)`).bind(id(), input.productId, input.serialNumber, item.id, user.id, user.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'warehouse.bind_serial', entityType: 'order', entityId: order.id, requestId: c.get('requestId'), after: { serialNumber: input.serialNumber, productId: input.productId } })
  ]);
  return c.json({ serialNumber: input.serialNumber, state: 'allocated' }, 201);
});

app.delete('/orders/:id/serials/:serialId', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'order:fulfill');
  const order = await getOrder(c.env.DB, c.req.param('id'));
  assertOrderAccess(user, order);
  if (order.status !== 'picking') throw conflict('仅配货中的订单可以删除 SN');
  const serial = await one<{ id: string; serialNumber: string }>(c.env.DB, `SELECT id, serial_number AS serialNumber FROM serial_numbers WHERE id = ? AND state = 'allocated' AND order_item_id IN (SELECT id FROM order_items WHERE order_id = ?)`, c.req.param('serialId'), order.id);
  if (!serial) throw notFound('未找到可删除的 SN');
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM serial_numbers WHERE id = ?').bind(serial.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'warehouse.remove_serial', entityType: 'order', entityId: order.id, requestId: c.get('requestId'), before: { serialNumber: serial.serialNumber } })
  ]);
  return c.body(null, 204);
});

app.post('/orders/:id/pack', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'order:fulfill');
  const order = await getOrder(c.env.DB, c.req.param('id'));
  assertOrderAccess(user, order);
  if (!canTransitionOrder(user, order.status, 'packed')) throw conflict('该订单暂时不能完成配货');
  const [expected, scanned] = await Promise.all([
    one<{ count: number }>(c.env.DB, 'SELECT COALESCE(SUM(quantity), 0) AS count FROM order_items WHERE order_id = ?', order.id),
    one<{ count: number }>(c.env.DB, `SELECT COUNT(*) AS count FROM serial_numbers WHERE state = 'allocated' AND order_item_id IN (SELECT id FROM order_items WHERE order_id = ?)`, order.id)
  ]);
  if ((expected?.count ?? 0) !== (scanned?.count ?? 0)) throw conflict('请先完成全部产品的 SN 录入');
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE orders SET status = 'packed', updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ? AND status = 'picking'`).bind(user.id, order.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'warehouse.pack', entityType: 'order', entityId: order.id, requestId: c.get('requestId'), before: { status: 'picking' }, after: { status: 'packed' } })
  ]);
  return c.json({ id: order.id, status: 'packed' });
});

app.post('/orders/:id/ship', requireAuth, async (c) => {
  const user = c.get('user');
  if (!can(user, 'order:fulfill') && !can(user, 'order:review')) throw forbidden();
  const input = await parseBody(c.req.raw, shipmentSchema);
  const shipmentPhotos = input.photos ?? [];
  const order = await getOrder(c.env.DB, c.req.param('id'));
  assertOrderAccess(user, order);
  if (!['approved', 'picking', 'packed'].includes(order.status)) throw conflict('该订单暂时不能发货');
  const existingShipment = await one<{ id: string }>(c.env.DB, 'SELECT id FROM shipments WHERE order_id = ?', order.id);
  if (existingShipment) throw conflict('该订单已经确认发货，请刷新页面查看物流信息');
  const shipmentId = id();
  const trackingNumber = (input.trackingNumber ?? '').trim();
  const storedTrackingNumber = trackingNumber || `NO-TRACKING-${order.id}`;
  const existingTracking = trackingNumber ? await one<{ id: string }>(c.env.DB, 'SELECT id FROM shipments WHERE tracking_number = ?', trackingNumber) : null;
  if (existingTracking) throw conflict('该运单号已被使用');
  const items = await orderItemsForFulfillment(c.env.DB, order.id);
  const preallocated = await allocatedSerialsForOrder(c.env.DB, order.id);
  const allocation = await allocationStatementsForSerials(c.env.DB, { orderId: order.id, serialNumbers: input.serialNumbers, actorId: user.id, allowExistingOnly: preallocated.length > 0 });
  const itemById = new Map(items.map((item) => [item.id, item]));
  const serials = allocation.serials.map((serial) => {
    const item = itemById.get(serial.orderItemId);
    if (!item) throw conflict(`该 SN 不属于本订单产品：${serial.serialNumber}`);
    return { serialNumber: serial.serialNumber, productId: item.productId, sku: item.sku, productName: item.name, productVersion: item.productVersion ?? '' };
  });
  const shippedAt = new Date();
  const assetStatements: D1PreparedStatement[] = [];
  let createdAssets = 0;
  for (const serial of serials) {
    const existingAsset = await one<{ id: string }>(c.env.DB,
      `SELECT id FROM assets WHERE current_sn = ? COLLATE NOCASE ORDER BY created_at ASC LIMIT 1`, serial.serialNumber);
    const rule = shipmentWarrantyRule(serial.sku);
    const dates = rule ? shipmentWarrantyDates(shippedAt, rule.durationDays) : null;
    const assetId = existingAsset?.id ?? id();
    const warrantyPolicy = rule && rule.durationDays > 90 ? 'extended' : rule ? 'standard' : 'unknown';
    if (existingAsset) {
      assetStatements.push(c.env.DB.prepare(`UPDATE assets SET product_id = ?, product_name_snapshot = ?, version_snapshot = ?, asset_status = 'in_service',
        warranty_policy = ?, warranty_start_at = ?, warranty_end_at = ?, warranty_override_status = NULL, warranty_override_reason = '',
        dealer_id = ?, store_id = ?, latest_order_id = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?`)
        .bind(serial.productId, serial.productName, serial.productVersion ?? '', warrantyPolicy, dates?.startAt ?? null, dates?.endAt ?? null, order.dealerId, order.storeId, order.id, user.id, assetId));
    } else {
      createdAssets += 1;
      assetStatements.push(c.env.DB.prepare(`INSERT INTO assets (id, current_sn, original_sn, product_id, product_name_snapshot, version_snapshot, asset_status,
        warranty_policy, warranty_start_at, warranty_end_at, source_channel, dealer_id, store_id, latest_order_id, data_quality_status, created_by, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, 'in_service', ?, ?, ?, '订单发货自动建档', ?, ?, ?, 'normal', ?, ?)`)
        .bind(assetId, serial.serialNumber, serial.serialNumber, serial.productId, serial.productName, serial.productVersion ?? '', warrantyPolicy, dates?.startAt ?? null, dates?.endAt ?? null, order.dealerId, order.storeId, order.id, user.id, user.id));
      assetStatements.push(c.env.DB.prepare(`INSERT INTO asset_identifiers (id, asset_id, identifier_type, identifier_value, is_current, valid_from, reason, source, created_by)
        VALUES (?, ?, 'current_sn', ?, 1, CURRENT_TIMESTAMP, '订单发货绑定 SN', '订单发货自动建档', ?)`)
        .bind(id(), assetId, serial.serialNumber, user.id));
    }
    assetStatements.push(c.env.DB.prepare(`INSERT INTO asset_events (id, asset_id, event_type, occurred_at, title, description, related_order_id,
      operator_user_id, visibility, source) VALUES (?, ?, 'shipped', CURRENT_TIMESTAMP, '订单已发货', ?, ?, ?, 'dealer', '订单履约')`)
      .bind(id(), assetId, trackingNumber ? `${input.carrier}：${trackingNumber}` : `${input.carrier}：未填写运单号`, order.id, user.id));
    if (rule && dates) {
      assetStatements.push(c.env.DB.prepare(`INSERT INTO asset_events (id, asset_id, event_type, occurred_at, title, description, related_order_id,
        operator_user_id, visibility, source) VALUES (?, ?, 'warranty_started', CURRENT_TIMESTAMP, ?, ?, ?, ?, 'dealer', '订单履约')`)
        .bind(id(), assetId, rule.label, `保修有效期：${dates.startAt} 至 ${dates.endAt}`, order.id, user.id));
    } else {
      assetStatements.push(c.env.DB.prepare(`INSERT INTO asset_events (id, asset_id, event_type, occurred_at, title, description, related_order_id,
        operator_user_id, visibility, source) VALUES (?, ?, 'note_added', CURRENT_TIMESTAMP, '保修规则待确认', '该 SKU 尚未配置可自动套用的保修期限。', ?, ?, 'admin_private', '订单履约')`)
        .bind(id(), assetId, order.id, user.id));
    }
  }
  const inventoryShipStatements = items.map((item) => {
    const reservedToRelease = Math.min(item.reservedQuantity, item.quantity);
    const quantityDelta = reservedToRelease < item.quantity ? -(item.quantity - reservedToRelease) : 0;
    const reservedDelta = -reservedToRelease;
    return c.env.DB.prepare(`INSERT INTO inventory_transactions (id, inventory_id, product_id, order_id, transaction_type, quantity_delta, reserved_delta, note, created_by)
      VALUES (?, ?, ?, ?, 'order_shipped', ?, ?, ?, ?)`)
      .bind(id(), item.inventoryId, item.productId, order.id, quantityDelta, reservedDelta, `订单 ${order.orderNo} 已发货，库存正式出库`, user.id);
  });
  try {
    await c.env.DB.batch([
      ...allocation.statements,
      c.env.DB.prepare(`INSERT INTO shipments (id, order_id, carrier, tracking_number, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(shipmentId, order.id, input.carrier, storedTrackingNumber, user.id, user.id),
      ...shipmentPhotos.map((photo) => c.env.DB.prepare(`INSERT INTO shipment_photos (id, shipment_id, order_id, category, data_url, original_filename, content_type, uploaded_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(id(), shipmentId, order.id, photo.category, photo.dataUrl, photo.originalFilename, photo.contentType, user.id)),
      c.env.DB.prepare(`UPDATE serial_numbers SET state = 'shipped', shipment_id = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ?
        WHERE state = 'allocated' AND order_item_id IN (SELECT id FROM order_items WHERE order_id = ?)`)
        .bind(shipmentId, user.id, order.id),
      c.env.DB.prepare(`UPDATE orders SET status = 'shipped', fulfillment_carrier = ?, fulfillment_tracking_number = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ? AND status IN ('approved','picking','packed')`).bind(input.carrier, trackingNumber, user.id, order.id),
      ...inventoryShipStatements,
      c.env.DB.prepare('INSERT INTO notifications (id, dealer_id, store_id, type, title, body, link) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id(), order.dealerId, order.storeId, 'order_shipped', '订单已发货', trackingNumber ? `${input.carrier}运单号：${trackingNumber}` : '订单已确认发货，运单号暂未填写。', `/system/orders/${order.id}`),
      ...assetStatements,
      dbAudit(c.env.DB, { actorId: user.id, action: 'warehouse.ship', entityType: 'order', entityId: order.id, requestId: c.get('requestId'), before: { status: order.status }, after: { status: 'shipped', trackingNumber, serialNumbers: serials.map((serial) => serial.serialNumber), shipmentPhotoCategories: shipmentPhotos.map((photo) => photo.category), createdAssets } })
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Inventory cannot be negative')) throw conflict('库存不足，无法确认发货。请先核对库存或释放异常预留。');
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed: serial_numbers.serial_number')) throw conflict('该 SN 已存在，请刷新页面后重新选择或扫描。');
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed: shipments')) throw conflict('该订单已经存在物流记录，请刷新页面查看最新状态。');
    throw error;
  }
  return c.json({ id: order.id, status: 'shipped', trackingNumber });
});

app.get('/notifications', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'notifications:read');
  const url = new URL(c.req.url);
  const page = pageValue(url.searchParams.get('page') ?? undefined);
  const limit = limitValue(url.searchParams.get('limit') ?? undefined);
  const scope = notificationScope(user);
  const [notifications, unread] = await Promise.all([
    all(c.env.DB, `SELECT id, type, title, body, link, read_at AS readAt, created_at AS createdAt FROM notifications WHERE ${scope.sql} ORDER BY created_at DESC LIMIT ? OFFSET ?`, ...scope.params, limit, (page - 1) * limit),
    one<{ count: number }>(c.env.DB, `SELECT COUNT(*) AS count FROM notifications WHERE ${scope.sql} AND read_at IS NULL`, ...scope.params)
  ]);
  return c.json({ notifications, unreadCount: unread?.count ?? 0 });
});

app.patch('/notifications/:id/read', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'notifications:read');
  const scope = notificationScope(user);
  const notification = await one<{ id: string }>(c.env.DB,
    `SELECT id FROM notifications WHERE id = ? AND ${scope.sql}`, c.req.param('id'), ...scope.params);
  if (!notification) throw notFound('未找到该通知');
  await c.env.DB.prepare('UPDATE notifications SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP) WHERE id = ?').bind(notification.id).run();
  return c.json({ id: notification.id, read: true });
});

app.post('/notifications/read-all', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'notifications:read');
  const scope = notificationScope(user);
  await c.env.DB.prepare(`UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE read_at IS NULL AND ${scope.sql}`).bind(...scope.params).run();
  return c.json({ read: true });
});

app.get('/after-sales/assets/search', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'after-sales:create');
  const query = normalizeLookup(new URL(c.req.url).searchParams.get('q') ?? '');
  if (query.length < 4) throw badRequest('请输入至少 4 位 SN 或资产标识');
  const scope = afterSalesAssetScope(user);
  const exact = query;
  const prefix = likePattern(query, 'prefix');
  const contains = likePattern(query, 'contains');
  const rows = await all<{ id: string; currentSn: string | null; originalSn: string | null; productName: string; version: string; sku: string | null; materialCode: string | null; assetStatus: string; warrantyStartAt: string | null; warrantyEndAt: string | null; warrantyOverrideStatus: string | null; updatedAt: string; rank: number }>(c.env.DB,
    `SELECT DISTINCT assets.id, assets.current_sn AS currentSn, assets.original_sn AS originalSn, assets.product_name_snapshot AS productName, assets.version_snapshot AS version,
      products.sku, products.sku AS materialCode, assets.asset_status AS assetStatus, assets.warranty_start_at AS warrantyStartAt, assets.warranty_end_at AS warrantyEndAt,
      assets.warranty_override_status AS warrantyOverrideStatus, assets.updated_at AS updatedAt,
      CASE
        WHEN assets.current_sn = ? COLLATE NOCASE THEN 1
        WHEN assets.original_sn = ? COLLATE NOCASE THEN 2
        WHEN asset_identifiers.identifier_value = ? COLLATE NOCASE THEN 3
        WHEN assets.current_sn LIKE ? ESCAPE '\\' THEN 4
        WHEN assets.original_sn LIKE ? ESCAPE '\\' THEN 5
        WHEN asset_identifiers.identifier_value LIKE ? ESCAPE '\\' THEN 6
        WHEN assets.current_sn LIKE ? ESCAPE '\\' THEN 7
        WHEN assets.original_sn LIKE ? ESCAPE '\\' THEN 8
        ELSE 9
      END AS rank
     FROM assets LEFT JOIN asset_identifiers ON asset_identifiers.asset_id = assets.id LEFT JOIN products ON products.id = assets.product_id
     WHERE ${scope.sql} AND (
      assets.current_sn = ? COLLATE NOCASE OR assets.original_sn = ? COLLATE NOCASE OR asset_identifiers.identifier_value = ? COLLATE NOCASE
      OR assets.current_sn LIKE ? ESCAPE '\\' OR assets.original_sn LIKE ? ESCAPE '\\' OR asset_identifiers.identifier_value LIKE ? ESCAPE '\\'
      OR assets.current_sn LIKE ? ESCAPE '\\' OR assets.original_sn LIKE ? ESCAPE '\\' OR asset_identifiers.identifier_value LIKE ? ESCAPE '\\'
     )
     ORDER BY rank ASC, assets.updated_at DESC, assets.current_sn ASC LIMIT 20`,
    exact, exact, exact, prefix, prefix, prefix, contains, contains,
    ...scope.params,
    exact, exact, exact, prefix, prefix, prefix, contains, contains, contains);
  const uniqueRows = Array.from(rows.reduce<Map<string, typeof rows[number]>>((map, row) => {
    const existing = map.get(row.id);
    if (!existing || row.rank < existing.rank) map.set(row.id, row);
    return map;
  }, new Map()).values()).sort((left, right) => left.rank - right.rank || right.updatedAt.localeCompare(left.updatedAt) || (left.currentSn ?? '').localeCompare(right.currentSn ?? ''));
  return c.json({ items: uniqueRows.slice(0, 20) });
});

app.get('/after-sales/assets/:id/context', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'after-sales:create');
  const scope = afterSalesAssetScope(user);
  const asset = await one(c.env.DB,
    `SELECT assets.id, assets.current_sn AS currentSn, assets.original_sn AS originalSn, assets.product_id AS productId, assets.product_name_snapshot AS productName,
      assets.version_snapshot AS version, products.sku, products.sku AS materialCode, assets.asset_status AS assetStatus, assets.warranty_start_at AS warrantyStartAt,
      assets.warranty_end_at AS warrantyEndAt, assets.warranty_override_status AS warrantyOverrideStatus, assets.warranty_override_reason AS warrantyOverrideReason,
      assets.source_channel AS sourceChannel, assets.shipping_warehouse AS shippingWarehouse, assets.dealer_id AS dealerId, dealers.name AS dealerName,
      assets.store_id AS storeId, stores.name AS storeName, assets.latest_order_id AS latestOrderId, orders.order_no AS latestOrderNo, orders.sale_price_cents AS salePriceCents,
      orders.screenshot_data_url AS screenshotDataUrl, orders.shipping_address AS shippingAddress, orders.customer_profile AS customerProfile, shipments.carrier AS carrier,
      shipments.tracking_number AS trackingNumber, shipments.shipped_at AS shippedAt
     FROM assets LEFT JOIN products ON products.id = assets.product_id LEFT JOIN dealers ON dealers.id = assets.dealer_id LEFT JOIN stores ON stores.id = assets.store_id
     LEFT JOIN orders ON orders.id = assets.latest_order_id LEFT JOIN shipments ON shipments.order_id = orders.id
     WHERE assets.id = ? AND ${scope.sql}`, c.req.param('id'), ...scope.params);
  if (!asset) throw notFound('未找到该资产');
  const [identifiers, history, openCase] = await Promise.all([
    all(c.env.DB, 'SELECT identifier_type AS identifierType, identifier_value AS identifierValue, is_current AS isCurrent FROM asset_identifiers WHERE asset_id = ? ORDER BY created_at DESC', c.req.param('id')),
    all(c.env.DB, 'SELECT id, case_no AS caseNo, service_stage AS serviceStage, status, created_at AS createdAt FROM after_sales_cases WHERE asset_id = ? ORDER BY created_at DESC LIMIT 20', c.req.param('id')),
    one(c.env.DB, "SELECT id, case_no AS caseNo FROM after_sales_cases WHERE asset_id = ? AND service_stage NOT IN ('CLOSED','WAITING_CUSTOMER_CONFIRMATION') AND status <> 'closed' ORDER BY created_at DESC LIMIT 1", c.req.param('id'))
  ]);
  return c.json({ asset: { ...(asset as object), warrantyStatus: warrantyDisplayStatus(asset as { warrantyStartAt: string | null; warrantyEndAt: string | null; warrantyOverrideStatus: string | null }) }, identifiers, history, openCase });
});

app.post('/after-sales', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'after-sales:create');
  const input = await parseBody(c.req.raw, createAfterSalesSchema);
  const scope = afterSalesAssetScope(user);
  const asset = await one<{ id: string; dealerId: string | null; storeId: string | null; productId: string | null; currentSn: string | null; latestOrderId: string | null }>(c.env.DB,
    `SELECT id, dealer_id AS dealerId, store_id AS storeId, product_id AS productId, current_sn AS currentSn, latest_order_id AS latestOrderId FROM assets WHERE id = ? AND ${scope.sql}`, input.assetId, ...scope.params);
  if (!asset) throw forbidden('你无权基于该 SN 创建售后工单');
  const storeId = input.storeId ?? asset.storeId;
  let dealerId = input.dealerId ?? asset.dealerId;
  if (storeId) {
    if (!can(user, 'data:read:all') && !user.roles.includes('authorized_service_center')) assertStoreAccess(user, storeId);
    const store = await one<{ id: string; dealerId: string }>(c.env.DB, "SELECT id, dealer_id AS dealerId FROM stores WHERE id = ? AND status = 'active'", storeId);
    if (!store) throw forbidden('该店铺不可用');
    dealerId = store.dealerId;
  }
  if (!dealerId) {
    const official = await one<{ dealerId: string; storeId: string | null }>(c.env.DB, "SELECT dealers.id AS dealerId, stores.id AS storeId FROM dealers LEFT JOIN stores ON stores.dealer_id = dealers.id AND stores.status = 'active' WHERE dealers.status = 'active' ORDER BY CASE WHEN dealers.name LIKE '%官方%' THEN 0 ELSE 1 END, dealers.created_at LIMIT 1");
    if (!official) throw badRequest('缺少可用于官方受理的经销商资料');
    dealerId = official.dealerId;
  }
  const effectiveOrderId = input.orderId ?? asset.latestOrderId;
  const effectiveProductId = input.productId ?? asset.productId;
  const existing = await one<{ id: string; caseNo: string }>(c.env.DB, `SELECT id, case_no AS caseNo FROM after_sales_cases WHERE asset_id = ? AND service_stage NOT IN ('CLOSED','WAITING_CUSTOMER_CONFIRMATION') AND status <> 'closed' ORDER BY created_at DESC LIMIT 1`, asset.id);
  if (existing) throw conflict(`该 SN 已有未关闭工单：${existing.caseNo}`);
  const caseId = id();
  const reference = caseNo();
  const sourceServiceCenterId = input.serviceCenterId ?? user.serviceCenterIds[0] ?? null;
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO after_sales_cases (id, case_no, dealer_id, store_id, order_id, product_id, serial_number, asset_id, case_type, subject, description, contact_name, contact_phone,
      customer_email, customer_address, customer_note, internal_note, service_stage, source_role, source_service_center_id, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_ADMIN_REVIEW', ?, ?, ?, ?)`)
      .bind(caseId, reference, dealerId, storeId ?? null, effectiveOrderId ?? null, effectiveProductId ?? null, input.serialNumber ?? asset.currentSn ?? null, asset.id, input.caseType, input.subject || (afterSalesCaseTypeLabel[input.caseType] ?? '售后申请'), input.description, input.contactName, input.contactPhone, input.contactEmail, input.contactAddress, input.customerNote, input.internalNote, user.roles.join(','), sourceServiceCenterId, user.id, user.id),
    c.env.DB.prepare(`INSERT INTO after_sales_timeline (id, case_id, event_type, title, description, actor_id) VALUES (?, ?, 'submitted', '提交售后工单', ?, ?)`).bind(id(), caseId, input.description, user.id),
    c.env.DB.prepare(`INSERT INTO asset_events (id, asset_id, event_type, occurred_at, title, description, related_service_case_id, operator_user_id, visibility, source)
      VALUES (?, ?, 'service_received', CURRENT_TIMESTAMP, '创建售后工单', ?, ?, ?, 'dealer', '售后闭环')`).bind(id(), asset.id, input.subject, caseId, user.id),
    c.env.DB.prepare(`INSERT INTO notifications (id, type, title, body, link, user_id)
      SELECT ?, ?, ?, ?, ?, users.id
      FROM users JOIN user_roles ON user_roles.user_id = users.id JOIN role_permissions ON role_permissions.role_id = user_roles.role_id
      WHERE users.is_active = 1 AND role_permissions.permission_code = 'after-sales:assign' LIMIT 20`)
      .bind(id(), 'after_sales_submitted', '新的售后工单待审核', `${reference} 等待管理员审核。`, `/system/admin/after-sales?caseId=${caseId}`),
    dbAudit(c.env.DB, { actorId: user.id, action: 'after_sales.create', entityType: 'after_sales_case', entityId: caseId, requestId: c.get('requestId'), after: { caseNo: reference, assetId: asset.id } })
  ]);
  return c.json({ id: caseId, caseNo: reference, serviceStage: 'PENDING_ADMIN_REVIEW' }, 201);
});

app.get('/after-sales', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'after-sales:read');
  const page = pageValue(new URL(c.req.url).searchParams.get('page') ?? undefined);
  const limit = limitValue(new URL(c.req.url).searchParams.get('limit') ?? undefined);
  const scope = afterSalesScope(user);
  const cases = await all(c.env.DB, `SELECT after_sales_cases.id, case_no AS caseNo, dealer_id AS dealerId, order_id AS orderId, products.name AS productName, serial_number AS serialNumber, case_type AS caseType, subject, status, workflow_stage AS workflowStage, service_stage AS serviceStage, after_sales_cases.created_at AS createdAt, after_sales_cases.updated_at AS updatedAt
    FROM after_sales_cases LEFT JOIN products ON products.id = after_sales_cases.product_id WHERE ${scope.sql}
    ORDER BY after_sales_cases.created_at DESC LIMIT ? OFFSET ?`, ...scope.params, limit, (page - 1) * limit);
  return c.json({ cases });
});

app.get('/after-sales/:id', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'after-sales:read');
  const serviceCase = await one<{ id: string; caseNo: string; dealerId: string; dealerName: string; storeId: string | null; storeName: string | null; orderId: string | null; orderNo: string | null; productId: string | null; productName: string | null; productVersion: string | null; materialCode: string | null; serialNumber: string | null; assetId: string | null; caseType: string; subject: string; description: string; customerNote: string; internalNote: string; contactName: string | null; contactPhone: string | null; contactEmail: string; contactAddress: string; inboundCarrier: string; inboundTrackingNumber: string; inboundNote: string; inboundRecordedAt: string | null; status: string; workflowStage: string; serviceStage: string; sourceRole: string; sourceServiceCenterId: string | null; serviceCenterId: string | null; serviceCenterName: string | null; assignedAt: string | null; adminReviewNote: string; finalDecision: string; createdAt: string; updatedAt: string }>(c.env.DB,
    `SELECT after_sales_cases.id, case_no AS caseNo, after_sales_cases.dealer_id AS dealerId, dealers.name AS dealerName, after_sales_cases.store_id AS storeId, stores.name AS storeName,
      after_sales_cases.order_id AS orderId, orders.order_no AS orderNo, after_sales_cases.product_id AS productId, products.name AS productName, products.product_version AS productVersion, products.sku AS materialCode,
      after_sales_cases.serial_number AS serialNumber, after_sales_cases.asset_id AS assetId, after_sales_cases.case_type AS caseType, after_sales_cases.subject AS subject, after_sales_cases.description AS description,
      after_sales_cases.customer_note AS customerNote, after_sales_cases.internal_note AS internalNote, after_sales_cases.contact_name AS contactName, after_sales_cases.contact_phone AS contactPhone, after_sales_cases.customer_email AS contactEmail,
      after_sales_cases.customer_address AS contactAddress, after_sales_cases.inbound_carrier AS inboundCarrier, after_sales_cases.inbound_tracking_number AS inboundTrackingNumber, after_sales_cases.inbound_note AS inboundNote,
      after_sales_cases.inbound_recorded_at AS inboundRecordedAt, after_sales_cases.status, after_sales_cases.workflow_stage AS workflowStage, after_sales_cases.service_stage AS serviceStage,
      after_sales_cases.source_role AS sourceRole, after_sales_cases.source_service_center_id AS sourceServiceCenterId, asa.service_center_id AS serviceCenterId, service_centers.name AS serviceCenterName, asa.assigned_at AS assignedAt,
      after_sales_cases.admin_review_note AS adminReviewNote, after_sales_cases.final_decision AS finalDecision, after_sales_cases.created_at AS createdAt, after_sales_cases.updated_at AS updatedAt
     FROM after_sales_cases JOIN dealers ON dealers.id = after_sales_cases.dealer_id LEFT JOIN stores ON stores.id = after_sales_cases.store_id LEFT JOIN products ON products.id = after_sales_cases.product_id
     LEFT JOIN orders ON orders.id = after_sales_cases.order_id LEFT JOIN after_sales_assignments AS asa ON asa.case_id = after_sales_cases.id LEFT JOIN service_centers ON service_centers.id = asa.service_center_id WHERE after_sales_cases.id = ?`, c.req.param('id'));
  if (!serviceCase) throw notFound('未找到该售后工单');
  const scope = afterSalesScope(user);
  const allowed = await one<{ id: string }>(c.env.DB, `SELECT id FROM after_sales_cases WHERE id = ? AND ${scope.sql}`, serviceCase.id, ...scope.params);
  if (!allowed) throw forbidden('你无权查看该售后工单');
  const [assessments, recommendations, approvals, attachments, timeline, receipts, inspections, faultChains, inspectionMaterials, adminDamageReviews, quotes] = await Promise.all([
    all(c.env.DB, 'SELECT result, details, assessed_at AS assessedAt, users.name AS actorName FROM after_sales_assessments JOIN users ON users.id = after_sales_assessments.assessed_by WHERE case_id = ? ORDER BY assessed_at DESC', serviceCase.id),
    all(c.env.DB, 'SELECT recommendation, details, recommended_at AS recommendedAt, users.name AS actorName FROM after_sales_recommendations JOIN users ON users.id = after_sales_recommendations.recommended_by WHERE case_id = ? ORDER BY recommended_at DESC', serviceCase.id),
    all(c.env.DB, 'SELECT outcome, resolution, note, approved_at AS approvedAt, users.name AS actorName FROM after_sales_approvals JOIN users ON users.id = after_sales_approvals.approved_by WHERE case_id = ? ORDER BY approved_at DESC', serviceCase.id),
    all(c.env.DB, `SELECT after_sales_attachments.id, category, photo_slot AS photoSlot, object_key AS objectKey, original_filename AS originalFilename, content_type AS contentType, file_size AS fileSize, users.name AS uploadedByName, after_sales_attachments.created_at AS createdAt FROM after_sales_attachments JOIN users ON users.id = after_sales_attachments.uploaded_by WHERE case_id = ? ORDER BY after_sales_attachments.created_at DESC`, serviceCase.id),
    all(c.env.DB, `SELECT event_type AS eventType, title, description, metadata_json AS metadataJson, users.name AS actorName, after_sales_timeline.created_at AS createdAt FROM after_sales_timeline LEFT JOIN users ON users.id = after_sales_timeline.actor_id WHERE case_id = ? ORDER BY after_sales_timeline.created_at ASC`, serviceCase.id),
    all(c.env.DB, `SELECT received_items_json AS receivedItemsJson, packaging_intact AS packagingIntact, packaging_note AS packagingNote, items_match AS itemsMatch, missing_items_note AS missingItemsNote, receipt_note AS receiptNote, users.name AS receivedByName, received_at AS receivedAt FROM after_sales_receipts JOIN users ON users.id = after_sales_receipts.received_by WHERE case_id = ? ORDER BY received_at DESC`, serviceCase.id),
    all(c.env.DB, `SELECT after_sales_inspections_v2.id, version, fault_reproduced AS faultReproduced, reproduction_status AS reproductionStatus, reproduction_condition AS reproductionCondition,
      reproduction_process AS reproductionProcess, test_result AS testResult, fault_parts_json AS faultPartsJson, damage_types_json AS damageTypesJson, derived_symptoms_json AS derivedSymptomsJson,
      conclusion, fault_cause AS faultCause, affected_parts AS affectedParts, suggested_action AS suggestedAction, suggested_parts AS suggestedParts,
      recommend_warranty AS recommendWarranty, recommend_charge AS recommendCharge, engineer_note AS engineerNote, difficulty, estimated_days AS estimatedDays,
      accidental_damage AS accidentalDamage, accidental_damage_type AS accidentalDamageType, accidental_damage_note AS accidentalDamageNote, material_suggested_total_cents AS materialSuggestedTotalCents,
      status, users.name AS submittedByName, submitted_at AS submittedAt, review_note AS reviewNote
      FROM after_sales_inspections_v2 JOIN users ON users.id = after_sales_inspections_v2.submitted_by WHERE case_id = ? ORDER BY version DESC`, serviceCase.id),
    all(c.env.DB, `SELECT after_sales_fault_chains.id, inspection_id AS inspectionId, chain_index AS chainIndex, fault_part AS faultPart, damage_type AS damageType, cause_type AS causeType,
      derived_symptoms_json AS derivedSymptomsJson, evidence, related_photo_ids_json AS relatedPhotoIdsJson, severity, repairability, recommended_action AS recommendedAction, engineer_note AS engineerNote
      FROM after_sales_fault_chains WHERE case_id = ? ORDER BY inspection_id, chain_index`, serviceCase.id),
    all(c.env.DB, `SELECT after_sales_inspection_materials.id, inspection_id AS inspectionId, material_id AS materialId, material_code_snapshot AS materialCode, material_name_snapshot AS materialName,
      quantity, handling_method AS handlingMethod, use_new AS useNew, reuse_existing AS reuseExisting, repair_only AS repairOnly, recommend_charge AS recommendCharge,
      unit_price_cents AS unitPriceCents, service_fee_cents AS serviceFeeCents, material_subtotal_cents AS materialSubtotalCents, service_fee_subtotal_cents AS serviceFeeSubtotalCents,
      suggested_total_cents AS suggestedTotalCents, price_status AS priceStatus, service_fee_status AS serviceFeeStatus, compatibility_status AS compatibilityStatus,
      compatibility_warning AS compatibilityWarning, compatibility_override_reason AS compatibilityOverrideReason, engineer_note AS engineerNote
      FROM after_sales_inspection_materials WHERE case_id = ? ORDER BY created_at, material_code_snapshot`, serviceCase.id),
    all(c.env.DB, `SELECT id, inspection_id AS inspectionId, source_fault_chains_json AS sourceFaultChainsJson, final_fault_chains_json AS finalFaultChainsJson,
      source_materials_json AS sourceMaterialsJson, final_materials_json AS finalMaterialsJson, final_decision AS finalDecision, customer_visible_conclusion AS customerVisibleConclusion,
      internal_note AS internalNote, final_total_cents AS finalTotalCents, created_at AS createdAt FROM after_sales_admin_damage_reviews WHERE case_id = ? ORDER BY created_at DESC`, serviceCase.id),
    all(c.env.DB, `SELECT after_sales_quotes.id, quote_no AS quoteNo, version, final_decision AS finalDecision, total_cents AS totalCents, currency, status,
      workflow_status AS workflowStatus, customer_name AS customerName, customer_email AS customerEmail, from_email AS fromEmail, reply_to_email AS replyToEmail,
      valid_until AS validUntil, created_at AS createdAt, confirmed_at AS confirmedAt, sent_at AS sentAt,
      (SELECT status FROM after_sales_quote_emails WHERE quote_id = after_sales_quotes.id ORDER BY created_at DESC LIMIT 1) AS emailStatus,
      (SELECT failure_reason FROM after_sales_quote_emails WHERE quote_id = after_sales_quotes.id ORDER BY created_at DESC LIMIT 1) AS emailFailureReason
      FROM after_sales_quotes WHERE case_id = ? ORDER BY version DESC`, serviceCase.id)
  ]);
  return c.json({ case: serviceCase, assessments, recommendations, approvals, attachments, timeline, receipts, inspections, faultChains, inspectionMaterials, adminDamageReviews, quotes });
});

app.post('/after-sales/:id/attachments', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'after-sales:read');
  const serviceCase = await getCaseForAccess(c.env.DB, user, c.req.param('id'));
  const form = await c.req.raw.formData();
  const category = String(form.get('category') ?? '');
  const photoSlot = String(form.get('photoSlot') ?? '');
  const file = form.get('file');
  const validCategories = new Set(['customer_problem_photo', 'package_label', 'received_items_front', 'received_items_back', 'product_front', 'product_back', 'product_left', 'product_right', 'product_top', 'product_bottom', 'accidental_damage', 'inspection_other']);
  if (!validCategories.has(category)) throw badRequest('图片类别不正确');
  if (!(file instanceof File)) throw badRequest('请选择要上传的图片');
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw badRequest('图片仅支持 JPG、PNG 或 WEBP');
  if (file.size > 8 * 1024 * 1024) throw badRequest('单张图片不能超过 8MB');
  if (category === 'customer_problem_photo' && await countAttachments(c.env.DB, serviceCase.id, category) >= 5) throw conflict('问题照片最多上传 5 张');
  if (category === 'accidental_damage' && await countAttachments(c.env.DB, serviceCase.id, category) >= 10) throw conflict('意外损坏照片最多上传 10 张');
  if (category !== 'customer_problem_photo' && category !== 'accidental_damage' && !canOperateAssignedCase(user, serviceCase.serviceCenterId) && !can(user, 'data:read:all')) throw forbidden('只有管理员或被分配服务中心可以上传该阶段照片');
  const key = attachmentObjectKey(serviceCase.id, category, file.name || 'photo');
  await c.env.ASSETS.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type }, customMetadata: { caseId: serviceCase.id, uploadedBy: user.id, originalFilename: file.name || 'photo' } });
  const attachmentId = id();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO after_sales_attachments (id, case_id, category, photo_slot, object_key, original_filename, content_type, file_size, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(attachmentId, serviceCase.id, category, photoSlot, key, file.name || 'photo', file.type, file.size, user.id),
    c.env.DB.prepare(`INSERT INTO after_sales_timeline (id, case_id, event_type, title, description, actor_id) VALUES (?, ?, 'attachment_uploaded', '上传售后图片', ?, ?)`).bind(id(), serviceCase.id, `${category}${photoSlot ? ` / ${photoSlot}` : ''}`, user.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'after_sales.attachment_upload', entityType: 'after_sales_case', entityId: serviceCase.id, requestId: c.get('requestId'), after: { category, photoSlot, key } })
  ]);
  return c.json({ id: attachmentId, objectKey: key, category, photoSlot }, 201);
});

app.post('/after-sales/:id/admin-review', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'after-sales:assign');
  const input = await parseBody(c.req.raw, adminReviewAfterSalesSchema);
  const serviceCase = await getCaseForAccess(c.env.DB, user, c.req.param('id'));
  if (!['PENDING_ADMIN_REVIEW', 'NEEDS_MORE_INFO'].includes(serviceCase.serviceStage)) throw conflict('该工单当前不能进行初审');
  const statements: D1PreparedStatement[] = [];
  const contactUpdates: string[] = [];
  const contactParams: unknown[] = [];
  if (input.contactName !== undefined) { contactUpdates.push('contact_name = ?'); contactParams.push(input.contactName); }
  if (input.contactPhone !== undefined) { contactUpdates.push('contact_phone = ?'); contactParams.push(input.contactPhone); }
  if (input.contactEmail !== undefined) { contactUpdates.push('customer_email = ?'); contactParams.push(input.contactEmail); }
  if (input.contactAddress !== undefined) { contactUpdates.push('customer_address = ?'); contactParams.push(input.contactAddress); }
  const contactSql = contactUpdates.length ? `${contactUpdates.join(', ')}, ` : '';
  if (!input.accepted) {
    statements.push(
      c.env.DB.prepare(`UPDATE after_sales_cases SET ${contactSql}service_stage = 'NEEDS_MORE_INFO', admin_review_note = ?, admin_reviewed_at = CURRENT_TIMESTAMP, admin_reviewed_by = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?`).bind(...contactParams, input.reason, user.id, user.id, serviceCase.id),
      c.env.DB.prepare(`INSERT INTO after_sales_timeline (id, case_id, event_type, title, description, actor_id) VALUES (?, ?, 'admin_rejected', '管理员退回售后工单', ?, ?)`).bind(id(), serviceCase.id, input.reason, user.id)
    );
  } else {
    const nextStage = input.requiresShipment ? 'WAITING_CUSTOMER_SHIPMENT' : 'PENDING_QUOTE';
    if (input.serviceCenterId) {
      const center = await one<{ id: string }>(c.env.DB, `SELECT id FROM service_centers WHERE id = ? AND status = 'active'`, input.serviceCenterId);
      if (!center) throw badRequest('所选授权服务中心不可用');
      statements.push(c.env.DB.prepare(`INSERT INTO after_sales_assignments (id, case_id, service_center_id, assigned_by) VALUES (?, ?, ?, ?)
        ON CONFLICT(case_id) DO UPDATE SET service_center_id = excluded.service_center_id, assigned_by = excluded.assigned_by, assigned_at = CURRENT_TIMESTAMP`).bind(id(), serviceCase.id, center.id, user.id));
    }
    statements.push(
      c.env.DB.prepare(`UPDATE after_sales_cases SET ${contactSql}status = 'in_progress', service_stage = ?, requires_customer_shipment = ?, admin_review_note = ?, admin_reviewed_at = CURRENT_TIMESTAMP, admin_reviewed_by = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?`).bind(...contactParams, nextStage, Number(input.requiresShipment), input.internalNote, user.id, user.id, serviceCase.id),
      c.env.DB.prepare(`INSERT INTO after_sales_timeline (id, case_id, event_type, title, description, actor_id) VALUES (?, ?, 'admin_accepted', '管理员受理售后工单', ?, ?)`).bind(id(), serviceCase.id, input.requiresShipment ? '等待客户寄修' : '无需寄修，进入报价流程', user.id)
    );
  }
  statements.push(dbAudit(c.env.DB, { actorId: user.id, action: 'after_sales.admin_review', entityType: 'after_sales_case', entityId: serviceCase.id, requestId: c.get('requestId'), after: input }));
  await c.env.DB.batch(statements);
  return c.json({ id: serviceCase.id, accepted: input.accepted });
});

app.post('/after-sales/:id/inbound-shipment', requireAuth, async (c) => {
  const user = c.get('user');
  const input = await parseBody(c.req.raw, inboundShipmentSchema);
  const serviceCase = await getCaseForAccess(c.env.DB, user, c.req.param('id'));
  const canRecord = can(user, 'data:read:all') || can(user, 'after-sales:assign') || canOperateAssignedCase(user, serviceCase.serviceCenterId) || Boolean(serviceCase.storeId && user.storeIds.includes(serviceCase.storeId));
  if (!canRecord) throw forbidden('你无权录入该工单的寄修单号');
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE after_sales_cases SET inbound_carrier = ?, inbound_tracking_number = ?, inbound_note = ?, inbound_recorded_at = CURRENT_TIMESTAMP, inbound_recorded_by = ?, service_stage = 'WAITING_SERVICE_CENTER_RECEIPT', updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?`).bind(input.carrier, input.trackingNumber, input.note, user.id, user.id, serviceCase.id),
    c.env.DB.prepare(`INSERT INTO after_sales_timeline (id, case_id, event_type, title, description, actor_id) VALUES (?, ?, 'inbound_tracking_recorded', '录入寄修单号', ?, ?)`).bind(id(), serviceCase.id, `${input.carrier} ${input.trackingNumber}`, user.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'after_sales.inbound_tracking', entityType: 'after_sales_case', entityId: serviceCase.id, requestId: c.get('requestId'), after: input })
  ]);
  return c.json({ id: serviceCase.id, serviceStage: 'WAITING_SERVICE_CENTER_RECEIPT' });
});

app.post('/after-sales/:id/receipt', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'after-sales:receive');
  const input = await parseBody(c.req.raw, receiptSchema);
  const serviceCase = await getCaseForAccess(c.env.DB, user, c.req.param('id'));
  if (!canOperateAssignedCase(user, serviceCase.serviceCenterId)) throw forbidden('该工单未分配给你的授权服务中心');
  if (!['WAITING_SERVICE_CENTER_RECEIPT', 'IN_TRANSIT', 'WAITING_CUSTOMER_SHIPMENT'].includes(serviceCase.serviceStage)) throw conflict('该工单当前不能确认收货');
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO after_sales_receipts (id, case_id, received_items_json, packaging_intact, packaging_note, items_match, missing_items_note, receipt_note, received_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id(), serviceCase.id, JSON.stringify(input.receivedItems), Number(input.packagingIntact), input.packagingNote, Number(input.itemsMatch), input.missingItemsNote, input.receiptNote, user.id),
    c.env.DB.prepare(`UPDATE after_sales_cases SET workflow_stage = 'received', service_stage = 'WAITING_INSPECTION', updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?`).bind(user.id, serviceCase.id),
    c.env.DB.prepare(`INSERT INTO after_sales_timeline (id, case_id, event_type, title, description, actor_id) VALUES (?, ?, 'received', '服务中心确认收货', ?, ?)`).bind(id(), serviceCase.id, input.receiptNote || '已确认收货', user.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'after_sales.receipt_confirm', entityType: 'after_sales_case', entityId: serviceCase.id, requestId: c.get('requestId'), after: input })
  ]);
  return c.json({ id: serviceCase.id, serviceStage: 'WAITING_INSPECTION' });
});

app.post('/after-sales/:id/inspection/start', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'after-sales:damage-assess');
  const serviceCase = await getCaseForAccess(c.env.DB, user, c.req.param('id'));
  if (!canOperateAssignedCase(user, serviceCase.serviceCenterId)) throw forbidden('该工单未分配给你的授权服务中心');
  if (!['WAITING_INSPECTION', 'INSPECTION_RETURNED', 'INSPECTION_IN_PROGRESS'].includes(serviceCase.serviceStage)) throw conflict('请先确认收货后再开始检测');
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE after_sales_cases SET service_stage = 'INSPECTION_IN_PROGRESS', updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?`).bind(user.id, serviceCase.id),
    c.env.DB.prepare(`INSERT INTO after_sales_timeline (id, case_id, event_type, title, description, actor_id) VALUES (?, ?, 'inspection_started', '开始检测', '工程师已开始检测', ?)`).bind(id(), serviceCase.id, user.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'after_sales.inspection_start', entityType: 'after_sales_case', entityId: serviceCase.id, requestId: c.get('requestId') })
  ]);
  return c.json({ id: serviceCase.id, serviceStage: 'INSPECTION_IN_PROGRESS' });
});

app.post('/after-sales/:id/inspections', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'after-sales:damage-assess');
  const input = await parseBody(c.req.raw, inspectionSchema);
  const serviceCase = await getCaseForAccess(c.env.DB, user, c.req.param('id'));
  if (!canOperateAssignedCase(user, serviceCase.serviceCenterId)) throw forbidden('该工单未分配给你的授权服务中心');
  if (!['INSPECTION_IN_PROGRESS', 'INSPECTION_RETURNED', 'WAITING_INSPECTION'].includes(serviceCase.serviceStage)) throw conflict('该工单当前不能提交检测结果');
  const latest = await one<{ version: number }>(c.env.DB, 'SELECT COALESCE(MAX(version), 0) AS version FROM after_sales_inspections_v2 WHERE case_id = ?', serviceCase.id);
  const version = (latest?.version ?? 0) + 1;
  const inspectionId = id();
  const context = await repairMaterialContext(c.env.DB, serviceCase.assetId, serviceCase.id);
  const repairMaterials = input.repairMaterials ?? [];
  const faultChains = input.faultChains ?? [];
  const materialIds = [...new Set(repairMaterials.map((item) => item.materialId))];
  const materialRows = materialIds.length ? await all<RepairMaterialRow>(c.env.DB, `SELECT id, material_code AS materialCode, material_name AS materialName, applicable_models AS applicableModels, description,
      out_of_warranty_price_cents AS outOfWarrantyPriceCents, price_status AS priceStatus, out_of_warranty_service_fee_cents AS outOfWarrantyServiceFeeCents,
      service_fee_status AS serviceFeeStatus, service_fee_rule_json AS serviceFeeRuleJson, retail_category AS retailCategory, can_replace_as_whole_set AS canReplaceAsWholeSet,
      warranty_policy AS warrantyPolicy, warranty_days AS warrantyDays, warranty_rule_json AS warrantyRuleJson, active, source_note AS sourceNote,
      data_quality_status AS dataQualityStatus, issues_json AS issuesJson, updated_at AS updatedAt
    FROM repair_materials WHERE id IN (${placeholders(materialIds)}) AND active = 1`, ...materialIds) : [];
  const materialMap = new Map(materialRows.map((row) => [row.id, row]));
  if (materialRows.length !== materialIds.length) throw badRequest('所选维修物料不存在或已停用，请重新选择');
  let totalKnown = true;
  let totalCents = 0;
  const materialStatements: D1PreparedStatement[] = [];
  for (const item of repairMaterials) {
    const material = materialMap.get(item.materialId);
    if (!material) throw badRequest('所选维修物料不存在或已停用，请重新选择');
    const compatibility = materialCompatibility(material.applicableModels, context);
    const overrideReason = item.compatibilityOverrideReason ?? '';
    if (compatibility.status === 'not_applicable' && !overrideReason.trim()) throw badRequest(`${material.materialCode ?? material.materialName} 未标记为适用于当前产品，请填写选择原因`);
    const fee = calculatedServiceFee(material, context);
    const unitPrice = ['available', 'zero'].includes(material.priceStatus) ? material.outOfWarrantyPriceCents ?? 0 : null;
    const materialSubtotal = unitPrice === null ? null : unitPrice * item.quantity;
    const serviceSubtotal = fee.cents === null ? null : fee.cents;
    const suggestedTotal = materialSubtotal === null || serviceSubtotal === null ? null : materialSubtotal + serviceSubtotal;
    if (suggestedTotal === null) totalKnown = false;
    else totalCents += suggestedTotal;
    materialStatements.push(c.env.DB.prepare(`INSERT INTO after_sales_inspection_materials (id, inspection_id, case_id, material_id, material_code_snapshot, material_name_snapshot, quantity,
      handling_method, use_new, reuse_existing, repair_only, recommend_charge, unit_price_cents, service_fee_cents, material_subtotal_cents, service_fee_subtotal_cents,
      suggested_total_cents, price_status, service_fee_status, compatibility_status, compatibility_warning, compatibility_override_reason, engineer_note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id(), inspectionId, serviceCase.id, material.id, material.materialCode ?? '', material.materialName, item.quantity, item.handlingMethod, Number(item.useNew), Number(item.reuseExisting),
        Number(item.repairOnly), Number(item.recommendCharge), unitPrice, fee.cents, materialSubtotal, serviceSubtotal, suggestedTotal, material.priceStatus, fee.status,
        compatibility.status, compatibility.warning, overrideReason, item.engineerNote));
  }
  const materialSuggestedTotal = repairMaterials.length && totalKnown ? totalCents : null;
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO after_sales_inspections_v2 (id, case_id, version, fault_reproduced, reproduction_status, reproduction_condition, reproduction_process, test_result,
      fault_parts_json, damage_types_json, derived_symptoms_json, conclusion, fault_cause, affected_parts, suggested_action, suggested_parts, recommend_warranty, recommend_charge,
      engineer_note, difficulty, estimated_days, accidental_damage, accidental_damage_type, accidental_damage_note, material_suggested_total_cents, status, submitted_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?)`)
      .bind(inspectionId, serviceCase.id, version, input.faultReproduced, input.reproductionStatus, input.reproductionCondition, input.reproductionProcess, input.testResult,
        JSON.stringify(input.faultParts), JSON.stringify(input.damageTypes), JSON.stringify(input.derivedSymptoms), input.conclusion, input.faultCause, input.affectedParts,
        input.suggestedAction, input.suggestedParts, Number(input.recommendWarranty), Number(input.recommendCharge), input.engineerNote, input.difficulty, input.estimatedDays,
        Number(input.accidentalDamage), input.accidentalDamageType ?? '', input.accidentalDamageNote, materialSuggestedTotal, user.id),
    ...faultChains.map((chain, index) => c.env.DB.prepare(`INSERT INTO after_sales_fault_chains (id, inspection_id, case_id, chain_index, fault_part, damage_type, cause_type,
      derived_symptoms_json, evidence, related_photo_ids_json, severity, repairability, recommended_action, engineer_note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id(), inspectionId, serviceCase.id, index, chain.faultPart, chain.damageType, chain.causeType, JSON.stringify(chain.derivedSymptoms), chain.evidence,
        JSON.stringify(chain.relatedPhotoIds), chain.severity, chain.repairability, chain.recommendedAction, chain.engineerNote)),
    ...materialStatements,
    c.env.DB.prepare('INSERT INTO after_sales_assessments (id, case_id, result, details, assessed_by) VALUES (?, ?, ?, ?, ?)').bind(id(), serviceCase.id, input.conclusion, input.engineerNote || input.faultCause || input.suggestedAction, user.id),
    c.env.DB.prepare(`UPDATE after_sales_cases SET workflow_stage = 'assessed', service_stage = 'PENDING_ADMIN_INSPECTION_REVIEW', updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?`).bind(user.id, serviceCase.id),
    c.env.DB.prepare(`INSERT INTO after_sales_timeline (id, case_id, event_type, title, description, actor_id) VALUES (?, ?, 'inspection_submitted', '提交检测结果', ?, ?)`).bind(id(), serviceCase.id, `检测版本 ${version}：${input.conclusion}`, user.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'after_sales.inspection_submit', entityType: 'after_sales_case', entityId: serviceCase.id, requestId: c.get('requestId'), after: { ...input, version, materialSuggestedTotal } })
  ]);
  return c.json({ id: serviceCase.id, version, serviceStage: 'PENDING_ADMIN_INSPECTION_REVIEW' }, 201);
});

app.post('/after-sales/:id/inspection-review', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'after-sales:approve');
  const input = await parseBody(c.req.raw, inspectionReviewSchema);
  const serviceCase = await getCaseForAccess(c.env.DB, user, c.req.param('id'));
  const latest = await one<{ id: string; version: number }>(c.env.DB, `SELECT id, version FROM after_sales_inspections_v2 WHERE case_id = ? ORDER BY version DESC LIMIT 1`, serviceCase.id);
  if (!latest) throw conflict('服务中心尚未提交检测结果');
  const statements: D1PreparedStatement[] = [];
  if (input.approved) {
    statements.push(
      c.env.DB.prepare(`UPDATE after_sales_inspections_v2 SET status = 'approved', review_note = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(input.note, user.id, latest.id),
      c.env.DB.prepare(`UPDATE after_sales_cases SET service_stage = 'PENDING_QUOTE', final_decision = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?`).bind(input.finalDecision, user.id, serviceCase.id),
      c.env.DB.prepare('INSERT INTO after_sales_approvals (id, case_id, outcome, resolution, note, approved_by) VALUES (?, ?, ?, ?, ?, ?)').bind(id(), serviceCase.id, 'approved', input.finalDecision, input.note, user.id),
      c.env.DB.prepare(`INSERT INTO after_sales_timeline (id, case_id, event_type, title, description, actor_id) VALUES (?, ?, 'inspection_approved', '管理员审核通过检测结果', ?, ?)`).bind(id(), serviceCase.id, input.finalDecision, user.id)
    );
  } else {
    statements.push(
      c.env.DB.prepare(`UPDATE after_sales_inspections_v2 SET status = 'returned', review_note = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(input.note, user.id, latest.id),
      c.env.DB.prepare(`UPDATE after_sales_cases SET service_stage = 'INSPECTION_RETURNED', updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?`).bind(user.id, serviceCase.id),
      c.env.DB.prepare('INSERT INTO after_sales_approvals (id, case_id, outcome, resolution, note, approved_by) VALUES (?, ?, ?, ?, ?, ?)').bind(id(), serviceCase.id, 'rejected', '退回补充检测资料', input.note, user.id),
      c.env.DB.prepare(`INSERT INTO after_sales_timeline (id, case_id, event_type, title, description, actor_id) VALUES (?, ?, 'inspection_returned', '管理员退回检测结果', ?, ?)`).bind(id(), serviceCase.id, input.note, user.id)
    );
  }
  statements.push(dbAudit(c.env.DB, { actorId: user.id, action: 'after_sales.inspection_review', entityType: 'after_sales_case', entityId: serviceCase.id, requestId: c.get('requestId'), after: input }));
  await c.env.DB.batch(statements);
  return c.json({ id: serviceCase.id, approved: input.approved, serviceStage: input.approved ? 'PENDING_QUOTE' : 'INSPECTION_RETURNED' });
});

app.post('/after-sales/:id/admin-damage-review', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'after-sales:approve');
  const input = await parseBody(c.req.raw, adminDamageReviewSchema);
  const serviceCase = await getCaseForAccess(c.env.DB, user, c.req.param('id'));
  const inspection = await one<{ id: string }>(c.env.DB, 'SELECT id FROM after_sales_inspections_v2 WHERE id = ? AND case_id = ?', input.inspectionId, serviceCase.id);
  if (!inspection) throw badRequest('所选检测版本不属于该工单');
  const [sourceChains, sourceMaterials] = await Promise.all([
    all(c.env.DB, `SELECT fault_part AS faultPart, damage_type AS damageType, cause_type AS causeType, derived_symptoms_json AS derivedSymptomsJson, evidence, severity, repairability, recommended_action AS recommendedAction, engineer_note AS engineerNote FROM after_sales_fault_chains WHERE inspection_id = ? ORDER BY chain_index`, inspection.id),
    all(c.env.DB, `SELECT material_id AS materialId, material_code_snapshot AS materialCode, material_name_snapshot AS materialName, quantity, handling_method AS handlingMethod, unit_price_cents AS unitPriceCents, service_fee_cents AS serviceFeeCents, suggested_total_cents AS suggestedTotalCents, engineer_note AS engineerNote FROM after_sales_inspection_materials WHERE inspection_id = ? ORDER BY created_at`, inspection.id)
  ]);
  const finalMaterials = input.finalMaterials ?? [];
  const finalFaultChains = input.finalFaultChains ?? [];
  const finalTotal = finalMaterials.reduce((sum, item) => {
    if (item.unitPriceCents === null || item.serviceFeeCents === null) return sum;
    return sum + item.quantity * item.unitPriceCents + item.serviceFeeCents - (item.discountCents ?? 0);
  }, 0);
  const reviewId = id();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO after_sales_admin_damage_reviews (id, case_id, inspection_id, source_fault_chains_json, final_fault_chains_json, source_materials_json,
      final_materials_json, final_decision, customer_visible_conclusion, internal_note, final_total_cents, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(reviewId, serviceCase.id, inspection.id, JSON.stringify(sourceChains), JSON.stringify(finalFaultChains), JSON.stringify(sourceMaterials), JSON.stringify(finalMaterials),
        input.finalDecision, input.customerVisibleConclusion, input.internalNote, finalTotal, user.id),
    c.env.DB.prepare(`INSERT INTO after_sales_timeline (id, case_id, event_type, title, description, actor_id) VALUES (?, ?, 'admin_damage_review', '管理员确认定损建议', ?, ?)`)
      .bind(id(), serviceCase.id, input.customerVisibleConclusion, user.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'after_sales.admin_damage_review', entityType: 'after_sales_case', entityId: serviceCase.id, requestId: c.get('requestId'), after: { reviewId, finalDecision: input.finalDecision, finalTotal } })
  ]);
  return c.json({ id: reviewId, finalTotalCents: finalTotal }, 201);
});

app.post('/after-sales/:id/quotes', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'after-sales:approve');
  const input = await parseBody(c.req.raw, quoteDraftSchema);
  const serviceCase = await getCaseForAccess(c.env.DB, user, c.req.param('id'));
  const workflowStatus = input.workflowStatus ?? 'READY_FOR_REVIEW';
  const context = await quoteCaseContext(c.env.DB, serviceCase.id);
  const quoteItems: QuoteSnapshotItem[] = input.items.map((item) => {
    const serviceFeeCents = item.serviceFeeCents ?? 0;
    const discountCents = item.discountCents ?? 0;
    return { materialId: item.materialId, materialCode: item.materialCode ?? '', itemName: item.itemName, itemType: item.itemType, quantity: item.quantity, unitPriceCents: item.unitPriceCents, serviceFeeCents, discountCents, subtotalCents: item.quantity * item.unitPriceCents + serviceFeeCents - discountCents, customerNote: item.customerNote ?? '' };
  });
  const latest = await one<{ version: number }>(c.env.DB, 'SELECT COALESCE(MAX(version), 0) AS version FROM after_sales_quotes WHERE case_id = ?', serviceCase.id);
  const version = (latest?.version ?? 0) + 1;
  const quoteId = id();
  const reference = quoteNo();
  const sender = notificationSender(c.env);
  const snapshot = quoteSnapshotFor({
    quoteNumber: reference,
    quoteVersion: version,
    context,
    inspectionSummary: input.inspectionSummary,
    finalDecision: input.finalDecision,
    items: quoteItems,
    currency: input.currency ?? 'CNY',
    validUntil: input.validUntil,
    estimatedCycle: input.estimatedCycle ?? '',
    paymentInstructions: input.paymentInstructions ?? '',
    customerNote: input.note ?? '',
    sender
  });
  if (snapshot.grandTotalCents < 0) throw badRequest('报价总金额不能小于 0');
  const html = quoteHtml(snapshot);
  const text = quoteText(snapshot);
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO after_sales_quotes (id, quote_no, case_id, version, customer_name, customer_email, product_name, product_version, serial_number, case_type,
      inspection_summary, final_decision, currency, valid_until, estimated_cycle, payment_instructions, note, total_cents, html_content, status, created_by, workflow_status,
      case_number, customer_phone, customer_address, report_date, warranty_status, service_center, engineer, customer_description, liability_result, subtotal_cents,
      discount_total_cents, shipping_fee_cents, snapshot_json, email_text, from_email, reply_to_email)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(quoteId, reference, serviceCase.id, version, snapshot.customerName, snapshot.customerEmail, snapshot.productName, snapshot.productVersion, snapshot.serialNumber, context.caseType,
        snapshot.diagnosisSummary, snapshot.finalSolution, snapshot.currency, snapshot.validUntil, snapshot.estimatedCycle, snapshot.paymentInstructions, snapshot.customerNote,
        snapshot.grandTotalCents, html, user.id, workflowStatus, snapshot.caseNumber, snapshot.customerPhone, snapshot.customerAddress, snapshot.reportDate,
        snapshot.warrantyStatus, snapshot.serviceCenter, snapshot.engineer, snapshot.customerDescription, snapshot.liabilityResult, snapshot.subtotalCents,
        snapshot.discountCents, snapshot.shippingFeeCents, JSON.stringify(snapshot), text, snapshot.fromEmail, snapshot.replyToEmail),
    ...quoteItems.map((item) => c.env.DB.prepare(`INSERT INTO after_sales_quote_items (id, quote_id, item_name, item_type, quantity, unit_price_cents, subtotal_cents, note, material_id, material_code, service_fee_cents, discount_cents, customer_note)
      VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?)`).bind(id(), quoteId, item.itemName, item.itemType, item.quantity, item.unitPriceCents, item.subtotalCents, item.materialId ?? null, item.materialCode, item.serviceFeeCents, item.discountCents, item.customerNote)),
    c.env.DB.prepare(`UPDATE after_sales_cases SET final_decision = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?`).bind(input.finalDecision, user.id, serviceCase.id),
    c.env.DB.prepare(`INSERT INTO after_sales_timeline (id, case_id, event_type, title, description, actor_id) VALUES (?, ?, 'quote_draft_created', '生成报价草稿', ?, ?)`).bind(id(), serviceCase.id, `${reference} · 等待管理员预览确认`, user.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'after_sales.quote_draft_create', entityType: 'after_sales_quote', entityId: quoteId, requestId: c.get('requestId'), after: { quoteNo: reference, version, totalCents: snapshot.grandTotalCents, workflowStatus } })
  ]);
  return c.json({ id: quoteId, quoteNo: reference, version, totalCents: snapshot.grandTotalCents, workflowStatus }, 201);
});

app.get('/after-sales-quotes/:quoteId', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'after-sales:read');
  const scope = afterSalesScope(user);
  const quote = await one<Record<string, unknown>>(c.env.DB, `SELECT after_sales_quotes.id, after_sales_quotes.quote_no AS quoteNo, after_sales_quotes.case_id AS caseId,
    after_sales_quotes.version, after_sales_quotes.workflow_status AS workflowStatus, after_sales_quotes.customer_name AS customerName,
    after_sales_quotes.customer_email AS customerEmail, after_sales_quotes.total_cents AS totalCents, after_sales_quotes.currency,
    after_sales_quotes.valid_until AS validUntil, after_sales_quotes.created_at AS createdAt, after_sales_quotes.updated_at AS updatedAt,
    after_sales_quotes.confirmed_at AS confirmedAt, after_sales_quotes.sent_at AS sentAt, after_sales_quotes.from_email AS fromEmail,
    after_sales_quotes.reply_to_email AS replyToEmail, after_sales_quotes.html_content AS htmlContent, after_sales_quotes.email_text AS emailText,
    after_sales_quotes.pdf_object_key AS pdfObjectKey, after_sales_quotes.snapshot_json AS snapshotJson, after_sales_cases.case_no AS caseNo
    FROM after_sales_quotes JOIN after_sales_cases ON after_sales_cases.id = after_sales_quotes.case_id
    WHERE after_sales_quotes.id = ? AND ${scope.sql}`, c.req.param('quoteId'), ...scope.params);
  if (!quote) throw notFound('未找到该报价或你无权查看');
  const [items, emails] = await Promise.all([
    all(c.env.DB, `SELECT id, item_name AS itemName, item_type AS itemType, quantity, unit_price_cents AS unitPriceCents, service_fee_cents AS serviceFeeCents,
      discount_cents AS discountCents, subtotal_cents AS subtotalCents, material_id AS materialId, material_code AS materialCode, customer_note AS customerNote
      FROM after_sales_quote_items WHERE quote_id = ? ORDER BY rowid`, c.req.param('quoteId')),
    all(c.env.DB, `SELECT id, to_email AS toEmail, from_email AS fromEmail, reply_to_email AS replyToEmail, subject, status, failure_reason AS failureReason,
      provider, provider_message_id AS providerMessageId, attempt_no AS attemptNo, sent_at AS sentAt, created_at AS createdAt
      FROM after_sales_quote_emails WHERE quote_id = ? ORDER BY attempt_no DESC, created_at DESC`, c.req.param('quoteId'))
  ]);
  const storedSnapshot = JSON.parse(String(quote.snapshotJson || '{}')) as QuoteSnapshot;
  const previewSnapshot = { ...storedSnapshot, caseNumber: String(quote.caseNo || storedSnapshot.caseNumber) };
  const isEditablePreview = ['DRAFT', 'READY_FOR_REVIEW'].includes(String(quote.workflowStatus));
  return c.json({
    quote: {
      ...quote,
      htmlContent: isEditablePreview ? quoteHtml(previewSnapshot) : quote.htmlContent,
      emailText: isEditablePreview ? quoteText(previewSnapshot) : quote.emailText,
      snapshot: isEditablePreview ? previewSnapshot : storedSnapshot
    },
    items,
    emails
  });
});

app.patch('/after-sales-quotes/:quoteId', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'after-sales:approve');
  const input = await parseBody(c.req.raw, quoteDraftSchema);
  const quote = await one<{ id: string; quoteNo: string; caseId: string; version: number; workflowStatus: string }>(c.env.DB,
    `SELECT id, quote_no AS quoteNo, case_id AS caseId, version, workflow_status AS workflowStatus FROM after_sales_quotes WHERE id = ?`, c.req.param('quoteId'));
  if (!quote) throw notFound('未找到该报价');
  if (!['DRAFT', 'READY_FOR_REVIEW'].includes(quote.workflowStatus)) throw conflict('该报价版本已锁定，修改时请创建新版本');
  const workflowStatus = input.workflowStatus ?? 'READY_FOR_REVIEW';
  await getCaseForAccess(c.env.DB, user, quote.caseId);
  const context = await quoteCaseContext(c.env.DB, quote.caseId);
  const quoteItems: QuoteSnapshotItem[] = input.items.map((item) => {
    const serviceFeeCents = item.serviceFeeCents ?? 0;
    const discountCents = item.discountCents ?? 0;
    return { materialId: item.materialId, materialCode: item.materialCode ?? '', itemName: item.itemName, itemType: item.itemType, quantity: item.quantity, unitPriceCents: item.unitPriceCents, serviceFeeCents, discountCents, subtotalCents: item.quantity * item.unitPriceCents + serviceFeeCents - discountCents, customerNote: item.customerNote ?? '' };
  });
  const snapshot = quoteSnapshotFor({ quoteNumber: quote.quoteNo, quoteVersion: quote.version, context, inspectionSummary: input.inspectionSummary, finalDecision: input.finalDecision, items: quoteItems, currency: input.currency ?? 'CNY', validUntil: input.validUntil, estimatedCycle: input.estimatedCycle ?? '', paymentInstructions: input.paymentInstructions ?? '', customerNote: input.note ?? '', sender: notificationSender(c.env) });
  if (snapshot.grandTotalCents < 0) throw badRequest('报价总金额不能小于 0');
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(`UPDATE after_sales_quotes SET customer_name = ?, customer_email = ?, product_name = ?, product_version = ?, serial_number = ?, case_type = ?,
      inspection_summary = ?, final_decision = ?, currency = ?, valid_until = ?, estimated_cycle = ?, payment_instructions = ?, note = ?, total_cents = ?,
      html_content = ?, workflow_status = ?, case_number = ?, customer_phone = ?, customer_address = ?, report_date = ?, warranty_status = ?, service_center = ?,
      engineer = ?, customer_description = ?, liability_result = ?, subtotal_cents = ?, discount_total_cents = ?, shipping_fee_cents = ?, snapshot_json = ?,
      email_text = ?, from_email = ?, reply_to_email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(snapshot.customerName, snapshot.customerEmail, snapshot.productName, snapshot.productVersion, snapshot.serialNumber, context.caseType, snapshot.diagnosisSummary,
        snapshot.finalSolution, snapshot.currency, snapshot.validUntil, snapshot.estimatedCycle, snapshot.paymentInstructions, snapshot.customerNote, snapshot.grandTotalCents,
        quoteHtml(snapshot), workflowStatus, snapshot.caseNumber, snapshot.customerPhone, snapshot.customerAddress, snapshot.reportDate, snapshot.warrantyStatus,
        snapshot.serviceCenter, snapshot.engineer, snapshot.customerDescription, snapshot.liabilityResult, snapshot.subtotalCents, snapshot.discountCents,
        snapshot.shippingFeeCents, JSON.stringify(snapshot), quoteText(snapshot), snapshot.fromEmail, snapshot.replyToEmail, quote.id),
    c.env.DB.prepare('DELETE FROM after_sales_quote_items WHERE quote_id = ?').bind(quote.id),
    ...quoteItems.map((item) => c.env.DB.prepare(`INSERT INTO after_sales_quote_items (id, quote_id, item_name, item_type, quantity, unit_price_cents, subtotal_cents, note, material_id, material_code, service_fee_cents, discount_cents, customer_note)
      VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?)`).bind(id(), quote.id, item.itemName, item.itemType, item.quantity, item.unitPriceCents, item.subtotalCents, item.materialId ?? null, item.materialCode, item.serviceFeeCents, item.discountCents, item.customerNote)),
    dbAudit(c.env.DB, { actorId: user.id, action: 'after_sales.quote_draft_update', entityType: 'after_sales_quote', entityId: quote.id, requestId: c.get('requestId'), after: { workflowStatus, totalCents: snapshot.grandTotalCents } })
  ];
  await c.env.DB.batch(statements);
  return c.json({ id: quote.id, quoteNo: quote.quoteNo, version: quote.version, totalCents: snapshot.grandTotalCents, workflowStatus });
});

app.post('/after-sales-quotes/:quoteId/confirm-send', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'after-sales:approve');
  const input = await parseBody(c.req.raw, confirmQuoteSendSchema);
  const previousAttempt = await one<{ status: string; providerMessageId: string; failureReason: string }>(c.env.DB,
    `SELECT status, provider_message_id AS providerMessageId, failure_reason AS failureReason FROM after_sales_quote_emails WHERE idempotency_key = ?`, input.idempotencyKey);
  if (previousAttempt) return c.json({ workflowStatus: previousAttempt.status === 'sent' ? 'SENT' : 'SEND_FAILED', emailStatus: previousAttempt.status, providerMessageId: previousAttempt.providerMessageId, failureReason: previousAttempt.failureReason, idempotentReplay: true });
  const quote = await one<{ id: string; quoteNo: string; caseId: string; version: number; workflowStatus: string; customerName: string; customerEmail: string; totalCents: number; htmlContent: string; emailText: string; fromEmail: string; replyToEmail: string; snapshotJson: string; supersedesQuoteId: string | null }>(c.env.DB,
    `SELECT id, quote_no AS quoteNo, case_id AS caseId, version, workflow_status AS workflowStatus, customer_name AS customerName, customer_email AS customerEmail,
      total_cents AS totalCents, html_content AS htmlContent, email_text AS emailText, from_email AS fromEmail, reply_to_email AS replyToEmail,
      snapshot_json AS snapshotJson, supersedes_quote_id AS supersedesQuoteId FROM after_sales_quotes WHERE id = ?`, c.req.param('quoteId'));
  if (!quote) throw notFound('未找到该报价');
  const serviceCase = await getCaseForAccess(c.env.DB, user, quote.caseId);
  if (!['READY_FOR_REVIEW', 'SEND_FAILED'].includes(quote.workflowStatus)) throw conflict(quote.workflowStatus === 'SENT' || quote.workflowStatus === 'SUPERSEDED' ? '该报价版本已发送并锁定' : '该报价当前不能发送');
  const recipientEmail = input.recipientEmail ?? quote.customerEmail;
  if (!recipientEmail) throw conflict('请先填写本次收件邮箱，再发送产品服务报告书');
  const locked = await c.env.DB.prepare(`UPDATE after_sales_quotes SET workflow_status = 'SENDING', status = 'created', confirmed_by = COALESCE(confirmed_by, ?),
    confirmed_at = COALESCE(confirmed_at, CURRENT_TIMESTAMP), locked_at = COALESCE(locked_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND workflow_status IN ('READY_FOR_REVIEW','SEND_FAILED')`).bind(user.id, quote.id).run();
  if ((locked.meta.changes ?? 0) !== 1) throw conflict('报价正在发送，请勿重复提交');
  const sender = notificationSender(c.env);
  const deliverySnapshot = { ...(JSON.parse(quote.snapshotJson) as QuoteSnapshot), caseNumber: serviceCase.caseNo, customerEmail: recipientEmail };
  const deliveryHtml = quoteHtml(deliverySnapshot);
  const deliveryText = quoteText(deliverySnapshot);
  const subject = mailSubject('after_sales_quote', mailEnvironment(c.env), serviceCase.caseNo);
  const delivery = await sendViaMailCenter(c, { template: 'after_sales_quote', to: recipientEmail, subject, html: deliveryHtml, text: deliveryText, idempotencyKey: input.idempotencyKey, actorId: user.id, relatedEntityType: 'after_sales_quote', relatedEntityId: quote.id });
  const nextWorkflowStatus = delivery.sent ? 'SENT' : 'SEND_FAILED';
  const attempt = await one<{ count: number }>(c.env.DB, 'SELECT COUNT(*) AS count FROM after_sales_quote_emails WHERE quote_id = ?', quote.id);
  const emailId = id();
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(`INSERT INTO after_sales_quote_emails (id, quote_id, to_email, from_email, reply_to_email, subject, status, failure_reason, provider,
      provider_message_id, attempt_no, idempotency_key, email_html, email_text, sent_by, sent_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'sent' THEN CURRENT_TIMESTAMP ELSE NULL END)`)
      .bind(emailId, quote.id, recipientEmail, sender.address, sender.replyTo, subject, delivery.sent ? 'sent' : 'failed', delivery.failureReason,
        delivery.provider, delivery.providerMessageId, (attempt?.count ?? 0) + 1, input.idempotencyKey, deliveryHtml, deliveryText, user.id, delivery.sent ? 'sent' : 'failed'),
    c.env.DB.prepare(`UPDATE after_sales_quotes SET workflow_status = ?, status = ?, sent_at = CASE WHEN ? = 'SENT' THEN CURRENT_TIMESTAMP ELSE sent_at END,
      customer_email = ?, html_content = ?, email_text = ?, case_number = ?, snapshot_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(nextWorkflowStatus, delivery.sent ? 'sent' : 'send_failed', nextWorkflowStatus, recipientEmail, deliveryHtml, deliveryText, serviceCase.caseNo, JSON.stringify(deliverySnapshot), quote.id),
    c.env.DB.prepare(`UPDATE after_sales_cases SET service_stage = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?`)
      .bind(delivery.sent ? 'WAITING_CUSTOMER_CONFIRMATION' : 'PENDING_QUOTE', user.id, quote.caseId),
    c.env.DB.prepare(`INSERT INTO after_sales_timeline (id, case_id, event_type, title, description, actor_id) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(id(), quote.caseId, delivery.sent ? 'quote_sent' : 'quote_send_failed', delivery.sent ? '产品服务报告书已发送' : '产品服务报告书发送失败', delivery.sent ? `${serviceCase.caseNo} 产品服务报告书已发送至客户邮箱` : delivery.failureReason, user.id),
    dbAudit(c.env.DB, { actorId: user.id, action: delivery.sent ? 'after_sales.quote_send' : 'after_sales.quote_send_failed', entityType: 'after_sales_quote', entityId: quote.id, requestId: c.get('requestId'), after: { workflowStatus: nextWorkflowStatus, recipientEmail, provider: delivery.provider, providerMessageId: delivery.providerMessageId, attemptNo: (attempt?.count ?? 0) + 1 } })
  ];
  if (delivery.sent && quote.supersedesQuoteId) statements.push(c.env.DB.prepare(`UPDATE after_sales_quotes SET workflow_status = 'SUPERSEDED', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND workflow_status = 'SENT'`).bind(quote.supersedesQuoteId));
  await c.env.DB.batch(statements);
  return c.json({ id: quote.id, quoteNo: quote.quoteNo, version: quote.version, workflowStatus: nextWorkflowStatus, emailStatus: delivery.sent ? 'sent' : 'failed', providerMessageId: delivery.providerMessageId, failureReason: delivery.failureReason });
});

app.post('/after-sales-quotes/:quoteId/new-version', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'after-sales:approve');
  const source = await one<{ id: string; caseId: string; workflowStatus: string; snapshotJson: string }>(c.env.DB,
    `SELECT id, case_id AS caseId, workflow_status AS workflowStatus, snapshot_json AS snapshotJson FROM after_sales_quotes WHERE id = ?`, c.req.param('quoteId'));
  if (!source) throw notFound('未找到该报价');
  const serviceCase = await getCaseForAccess(c.env.DB, user, source.caseId);
  if (!['SENT', 'SEND_FAILED', 'SUPERSEDED'].includes(source.workflowStatus)) throw conflict('当前报价仍可直接修改，无需创建新版本');
  const sourceSnapshot = JSON.parse(source.snapshotJson) as QuoteSnapshot;
  const latest = await one<{ version: number }>(c.env.DB, 'SELECT COALESCE(MAX(version), 0) AS version FROM after_sales_quotes WHERE case_id = ?', source.caseId);
  const version = (latest?.version ?? 0) + 1;
  const quoteId = id();
  const reference = quoteNo();
  const snapshot: QuoteSnapshot = { ...sourceSnapshot, quoteNumber: reference, quoteVersion: version, caseNumber: serviceCase.caseNo, reportDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()), pdfObjectKey: null };
  const html = quoteHtml(snapshot);
  const text = quoteText(snapshot);
  const sourceItems = await all<QuoteSnapshotItem>(c.env.DB, `SELECT material_id AS materialId, material_code AS materialCode, item_name AS itemName, item_type AS itemType,
    quantity, unit_price_cents AS unitPriceCents, service_fee_cents AS serviceFeeCents, discount_cents AS discountCents, subtotal_cents AS subtotalCents,
    customer_note AS customerNote FROM after_sales_quote_items WHERE quote_id = ? ORDER BY rowid`, source.id);
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO after_sales_quotes (id, quote_no, case_id, version, customer_name, customer_email, product_name, product_version, serial_number, case_type,
      inspection_summary, final_decision, currency, valid_until, estimated_cycle, payment_instructions, note, total_cents, html_content, status, created_by, workflow_status,
      case_number, customer_phone, customer_address, report_date, warranty_status, service_center, engineer, customer_description, liability_result, subtotal_cents,
      discount_total_cents, shipping_fee_cents, snapshot_json, email_text, from_email, reply_to_email, supersedes_quote_id)
      SELECT ?, ?, case_id, ?, customer_name, customer_email, product_name, product_version, serial_number, case_type, inspection_summary, final_decision, currency,
        valid_until, estimated_cycle, payment_instructions, note, total_cents, ?, 'created', ?, 'DRAFT', case_number, customer_phone, customer_address, ?, warranty_status,
        service_center, engineer, customer_description, liability_result, subtotal_cents, discount_total_cents, shipping_fee_cents, ?, ?, from_email, reply_to_email, id
      FROM after_sales_quotes WHERE id = ?`).bind(quoteId, reference, version, html, user.id, snapshot.reportDate, JSON.stringify(snapshot), text, source.id),
    ...sourceItems.map((item) => c.env.DB.prepare(`INSERT INTO after_sales_quote_items (id, quote_id, item_name, item_type, quantity, unit_price_cents, subtotal_cents, note, material_id, material_code, service_fee_cents, discount_cents, customer_note)
      VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?)`).bind(id(), quoteId, item.itemName, item.itemType, item.quantity, item.unitPriceCents, item.subtotalCents, item.materialId ?? null, item.materialCode, item.serviceFeeCents, item.discountCents, item.customerNote)),
    dbAudit(c.env.DB, { actorId: user.id, action: 'after_sales.quote_new_version', entityType: 'after_sales_quote', entityId: quoteId, requestId: c.get('requestId'), after: { sourceQuoteId: source.id, quoteNo: reference, version } })
  ]);
  return c.json({ id: quoteId, quoteNo: reference, version, workflowStatus: 'DRAFT' }, 201);
});

app.post('/after-sales/:id/assign', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'after-sales:assign');
  const input = await parseBody(c.req.raw, assignAfterSalesSchema);
  const serviceCase = await one<{ id: string }>(c.env.DB, 'SELECT id FROM after_sales_cases WHERE id = ?', c.req.param('id'));
  if (!serviceCase) throw notFound('未找到该售后工单');
  const center = await one<{ id: string }>(c.env.DB, `SELECT id FROM service_centers WHERE id = ? AND status = 'active'`, input.serviceCenterId);
  if (!center) throw badRequest('所选授权服务中心不可用');
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO after_sales_assignments (id, case_id, service_center_id, assigned_by) VALUES (?, ?, ?, ?)').bind(id(), serviceCase.id, center.id, user.id),
    c.env.DB.prepare(`UPDATE after_sales_cases SET status = 'in_progress', workflow_stage = 'open', updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?`).bind(user.id, serviceCase.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'after_sales.assign', entityType: 'after_sales_case', entityId: serviceCase.id, requestId: c.get('requestId'), after: { serviceCenterId: center.id } })
  ]);
  return c.json({ id: serviceCase.id, serviceCenterId: center.id, workflowStage: 'open' });
});

app.post('/after-sales/:id/receive', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'after-sales:receive');
  const serviceCase = await one<{ id: string; serviceCenterId: string | null; workflowStage: string }>(c.env.DB, `SELECT after_sales_cases.id, after_sales_cases.workflow_stage AS workflowStage, asa.service_center_id AS serviceCenterId
    FROM after_sales_cases LEFT JOIN after_sales_assignments AS asa ON asa.case_id = after_sales_cases.id WHERE after_sales_cases.id = ?`, c.req.param('id'));
  if (!serviceCase) throw notFound('未找到该售后工单');
  if (!canOperateAssignedCase(user, serviceCase.serviceCenterId)) throw forbidden('该工单未分配给你的授权服务中心');
  if (serviceCase.workflowStage !== 'open') throw conflict('该售后工单当前不能受理');
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE after_sales_cases SET workflow_stage = 'received', updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ? AND workflow_stage = 'open'`).bind(user.id, serviceCase.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'after_sales.receive', entityType: 'after_sales_case', entityId: serviceCase.id, requestId: c.get('requestId'), after: { workflowStage: 'received' } })
  ]);
  return c.json({ id: serviceCase.id, workflowStage: 'received' });
});

app.post('/after-sales/:id/assessments', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'after-sales:damage-assess');
  const input = await parseBody(c.req.raw, afterSalesAssessmentSchema);
  const serviceCase = await one<{ id: string; serviceCenterId: string | null; workflowStage: string }>(c.env.DB, `SELECT after_sales_cases.id, after_sales_cases.workflow_stage AS workflowStage, asa.service_center_id AS serviceCenterId FROM after_sales_cases LEFT JOIN after_sales_assignments AS asa ON asa.case_id = after_sales_cases.id WHERE after_sales_cases.id = ?`, c.req.param('id'));
  if (!serviceCase) throw notFound('未找到该售后工单');
  if (!canOperateAssignedCase(user, serviceCase.serviceCenterId)) throw forbidden('该工单未分配给你的授权服务中心');
  if (!['received', 'assessed'].includes(serviceCase.workflowStage)) throw conflict('请先受理该售后工单');
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO after_sales_assessments (id, case_id, result, details, assessed_by) VALUES (?, ?, ?, ?, ?)').bind(id(), serviceCase.id, input.result, input.details, user.id),
    c.env.DB.prepare(`UPDATE after_sales_cases SET workflow_stage = 'assessed', updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?`).bind(user.id, serviceCase.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'after_sales.assess', entityType: 'after_sales_case', entityId: serviceCase.id, requestId: c.get('requestId') })
  ]);
  return c.json({ id: serviceCase.id, workflowStage: 'assessed' }, 201);
});

app.post('/after-sales/:id/recommendations', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'after-sales:recommend');
  const input = await parseBody(c.req.raw, afterSalesRecommendationSchema);
  const serviceCase = await one<{ id: string; serviceCenterId: string | null; workflowStage: string }>(c.env.DB, `SELECT after_sales_cases.id, after_sales_cases.workflow_stage AS workflowStage, asa.service_center_id AS serviceCenterId FROM after_sales_cases LEFT JOIN after_sales_assignments AS asa ON asa.case_id = after_sales_cases.id WHERE after_sales_cases.id = ?`, c.req.param('id'));
  if (!serviceCase) throw notFound('未找到该售后工单');
  if (!canOperateAssignedCase(user, serviceCase.serviceCenterId)) throw forbidden('该工单未分配给你的授权服务中心');
  if (!['assessed', 'recommended'].includes(serviceCase.workflowStage)) throw conflict('请先提交定损结果');
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO after_sales_recommendations (id, case_id, recommendation, details, recommended_by) VALUES (?, ?, ?, ?, ?)').bind(id(), serviceCase.id, input.recommendation, input.details, user.id),
    c.env.DB.prepare(`UPDATE after_sales_cases SET workflow_stage = 'recommended', updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?`).bind(user.id, serviceCase.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'after_sales.recommend', entityType: 'after_sales_case', entityId: serviceCase.id, requestId: c.get('requestId') })
  ]);
  return c.json({ id: serviceCase.id, workflowStage: 'recommended' }, 201);
});

app.patch('/after-sales/:id', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'after-sales:approve');
  const input = await parseBody(c.req.raw, updateAfterSalesSchema);
  const serviceCase = await one<{ id: string; dealerId: string; storeId: string }>(c.env.DB, 'SELECT id, dealer_id AS dealerId, store_id AS storeId FROM after_sales_cases WHERE id = ?', c.req.param('id'));
  if (!serviceCase) throw notFound('未找到该售后工单');
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO after_sales_approvals (id, case_id, outcome, resolution, note, approved_by) VALUES (?, ?, ?, ?, ?, ?)').bind(id(), serviceCase.id, input.outcome, input.resolution ?? '', input.note, user.id),
    c.env.DB.prepare(`UPDATE after_sales_cases SET status = ?, workflow_stage = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?`).bind(input.outcome === 'approved' ? 'resolved' : 'closed', input.outcome, user.id, serviceCase.id),
    c.env.DB.prepare('INSERT INTO notifications (id, dealer_id, store_id, type, title, body, link) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id(), serviceCase.dealerId, serviceCase.storeId, 'after_sales_approved', '售后工单最终处理结果', input.note, `/system/after-sales/${serviceCase.id}`),
    dbAudit(c.env.DB, { actorId: user.id, action: 'after_sales.approve', entityType: 'after_sales_case', entityId: serviceCase.id, requestId: c.get('requestId'), after: { outcome: input.outcome } })
  ]);
  return c.json({ id: serviceCase.id, outcome: input.outcome });
});

app.post('/admin/gsx/imports/precheck', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'asset:import');
  const input = await parseBody(c.req.raw, historicalWarrantyPrecheckSchema);
  const missingColumns = HISTORICAL_WARRANTY_COLUMNS.filter((column) => !input.headers.includes(column));
  if (missingColumns.length) throw badRequest(`导入文件缺少必要列：${missingColumns.join('、')}`);
  const duplicateRows = new Set<number>();
  for (const record of input.records) {
    if (duplicateRows.has(record.rowNumber)) throw badRequest('导入文件存在重复的行号，请重新选择原始文件');
    duplicateRows.add(record.rowNumber);
  }
  const existing = await one<{ id: string }>(c.env.DB, 'SELECT id FROM asset_import_batches WHERE source_file_fingerprint = ?', input.sourceFileFingerprint);
  if (existing) return c.json({ ...(await importBatchPreview(c.env.DB, existing.id)), alreadyPrepared: true });
  const normalized = normalizeHistoricalWarrantyRecords(input.records);
  const normalRows = normalized.filter((row) => !row.issues.length).length;
  const warningRows = normalized.filter((row) => row.issues.some((issue) => issue.severity === 'warning')).length;
  const errorRows = normalized.filter((row) => row.issues.some((issue) => issue.severity === 'error')).length;
  const batchId = id();
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(`INSERT INTO asset_import_batches (id, source_filename, source_file_fingerprint, source_sheet, status, total_rows, normal_rows, warning_rows, error_rows, created_by)
      VALUES (?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?)`)
      .bind(batchId, input.sourceFilename, input.sourceFileFingerprint, input.sourceSheet, normalized.length, normalRows, warningRows, errorRows, user.id)
  ];
  for (const record of normalized) statements.push(c.env.DB.prepare(`INSERT INTO asset_import_rows (id, import_batch_id, source_row_number, raw_json, normalized_json, issues_json)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id(), batchId, record.sourceRowNumber, JSON.stringify(input.records.find((item) => item.rowNumber === record.sourceRowNumber)?.values ?? {}), JSON.stringify(record), JSON.stringify(record.issues)));
  statements.push(dbAudit(c.env.DB, { actorId: user.id, action: 'asset_import.precheck', entityType: 'asset_import_batch', entityId: batchId, requestId: c.get('requestId'), after: { sourceFilename: input.sourceFilename, totalRows: normalized.length, normalRows, warningRows, errorRows } }));
  await runStatementsInChunks(c.env.DB, statements);
  return c.json(await importBatchPreview(c.env.DB, batchId), 201);
});

app.get('/admin/gsx/imports/:id', requireAuth, async (c) => {
  assertPermission(c.get('user'), 'asset:import');
  return c.json(await importBatchPreview(c.env.DB, c.req.param('id')));
});

app.post('/admin/gsx/imports/:id/confirm', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'asset:import');
  const input = await parseBody(c.req.raw, confirmHistoricalWarrantyImportSchema);
  const batch = await one<{ id: string; status: string }>(c.env.DB, 'SELECT id, status FROM asset_import_batches WHERE id = ?', c.req.param('id'));
  if (!batch) throw notFound('未找到该历史保修导入批次');
  if (batch.status !== 'prepared') return c.json({ ...(await importBatchPreview(c.env.DB, batch.id)), alreadyCompleted: true });
  const rows = await all<{ id: string; sourceRowNumber: number; rawJson: string; normalizedJson: string; issuesJson: string; disposition: string }>(c.env.DB,
    `SELECT id, source_row_number AS sourceRowNumber, raw_json AS rawJson, normalized_json AS normalizedJson, issues_json AS issuesJson, disposition FROM asset_import_rows WHERE import_batch_id = ? ORDER BY source_row_number`, batch.id);
  const skipped = new Set(input.skipRowNumbers);
  const blocked = rows.filter((row) => JSON.parse(row.issuesJson).some((issue: { severity: string }) => issue.severity === 'error') && !skipped.has(row.sourceRowNumber));
  if (blocked.length) throw badRequest('存在需要跳过的严重错误行，请确认后再导入', Object.fromEntries(blocked.map((row) => [`第 ${row.sourceRowNumber} 行`, ['该行日期或关键字段无法解析，请跳过或修正后重新预检查']])));

  const normalSns = rows.map((row) => JSON.parse(row.normalizedJson) as NormalizedWarrantyRecord)
    .filter((record) => record.currentSn && record.dataQualityStatus === 'normal').map((record) => record.currentSn!);
  const existingAssets = new Map<string, string>();
  for (let offset = 0; offset < normalSns.length; offset += 90) {
    const serials = [...new Set(normalSns.slice(offset, offset + 90))];
    if (!serials.length) continue;
    const assets = await all<{ id: string; currentSn: string }>(c.env.DB, `SELECT id, current_sn AS currentSn FROM assets WHERE data_quality_status = 'normal' AND current_sn IN (${placeholders(serials)})`, ...serials);
    for (const asset of assets) existingAssets.set(asset.currentSn.toUpperCase(), asset.id);
  }
  const scopeByChannel = new Map<string, { storeId: string; dealerId: string }>();
  const channels = [...new Set(rows.map((row) => (JSON.parse(row.normalizedJson) as NormalizedWarrantyRecord).sourceChannel).filter(Boolean))];
  for (const channel of channels) {
    const preferredCode = channel === '官方店' ? 'MAXCINE-DIRECT' : channel === '官方智选店' ? 'MAXCINE-SELECT' : null;
    const store = preferredCode
      ? await one<{ storeId: string; dealerId: string }>(c.env.DB, `SELECT id AS storeId, dealer_id AS dealerId FROM stores WHERE code = ? AND status = 'active'`, preferredCode)
      : await one<{ storeId: string; dealerId: string }>(c.env.DB, `SELECT id AS storeId, dealer_id AS dealerId FROM stores WHERE status = 'active' AND (name = ? OR name LIKE ?) ORDER BY CASE WHEN name = ? THEN 0 ELSE 1 END, name LIMIT 1`, channel, `%${channel}%`, channel);
    if (store) scopeByChannel.set(channel, store);
  }
  const statements: D1PreparedStatement[] = [];
  let importedRows = 0;
  let skippedRows = 0;
  for (const row of rows) {
    if (row.disposition === 'imported') continue;
    if (skipped.has(row.sourceRowNumber)) {
      skippedRows += 1;
      statements.push(c.env.DB.prepare(`UPDATE asset_import_rows SET disposition = 'skipped', imported_at = CURRENT_TIMESTAMP WHERE id = ? AND disposition = 'pending'`).bind(row.id));
      continue;
    }
    const record = JSON.parse(row.normalizedJson) as NormalizedWarrantyRecord;
    const existingAssetId = record.currentSn && record.dataQualityStatus === 'normal' ? existingAssets.get(record.currentSn.toUpperCase()) : undefined;
    const assetId = existingAssetId ?? id();
    const saleId = id();
    const sourceScope = scopeByChannel.get(record.sourceChannel);
    if (!existingAssetId) {
      statements.push(c.env.DB.prepare(`INSERT INTO assets (id, current_sn, original_sn, product_name_snapshot, version_snapshot, asset_status, warranty_policy, warranty_start_at, warranty_end_at, warranty_override_status, warranty_override_reason, source_channel, shipping_warehouse, dealer_id, store_id, data_quality_status, created_by, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(assetId, record.currentSn, record.originalSn, productNameSnapshot(record.version), record.version, record.assetStatus, record.warrantyPolicy, record.warrantyStartAt, record.warrantyEndAt, record.warrantyOverrideStatus, record.warrantyOverrideReason, record.sourceChannel, record.shippingWarehouse, sourceScope?.dealerId ?? null, sourceScope?.storeId ?? null, record.dataQualityStatus, user.id, user.id));
      for (const identifier of record.identifiers) statements.push(c.env.DB.prepare(`INSERT INTO asset_identifiers (id, asset_id, identifier_type, identifier_value, is_current, reason, source, created_by)
        VALUES (?, ?, ?, ?, ?, ?, '历史保修表', ?)`)
        .bind(id(), assetId, identifier.type, identifier.value, Number(identifier.isCurrent), identifier.reason, user.id));
    }
    statements.push(
      c.env.DB.prepare(`INSERT INTO asset_sales (id, import_batch_id, source_row_number, source_channel, purchase_date, purchase_date_annotation, purchase_price_raw, unit_price_cents, quantity, total_price_cents, payment_status, payment_amount_cents, payment_raw, tracking_number, shipping_warehouse, raw_json, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(saleId, batch.id, row.sourceRowNumber, record.sourceChannel, record.purchaseDate, record.purchaseDateAnnotation, record.purchasePriceRaw, record.unitPriceCents, record.quantity, record.totalPriceCents, record.paymentStatus, record.paymentAmountCents, record.paymentRaw, record.trackingNumber, record.shippingWarehouse, row.rawJson, user.id),
      c.env.DB.prepare('INSERT INTO asset_sale_assets (sale_id, asset_id) VALUES (?, ?)').bind(saleId, assetId),
      c.env.DB.prepare(`INSERT INTO asset_events (id, asset_id, event_type, occurred_at, title, description, sale_id, operator_user_id, visibility, source)
        VALUES (?, ?, 'imported', CURRENT_TIMESTAMP, '导入历史保修记录', ?, ?, ?, 'admin_private', '历史保修表')`).bind(id(), assetId, `第 ${row.sourceRowNumber} 行历史记录已导入`, saleId, user.id),
      c.env.DB.prepare(`INSERT INTO asset_events (id, asset_id, event_type, occurred_at, title, description, sale_id, operator_user_id, visibility, source)
        VALUES (?, ?, 'sold', ?, '历史销售记录', ?, ?, ?, 'dealer', '历史保修表')`).bind(id(), assetId, record.purchaseDate, `${record.sourceChannel || '未标注渠道'} · ${record.version || '未标注版本'}`, saleId, user.id)
    );
    if (record.warrantyStartAt) statements.push(c.env.DB.prepare(`INSERT INTO asset_events (id, asset_id, event_type, occurred_at, title, description, sale_id, operator_user_id, visibility, source)
      VALUES (?, ?, 'warranty_started', ?, '保修开始', '', ?, ?, 'dealer', '历史保修表')`).bind(id(), assetId, record.warrantyStartAt, saleId, user.id));
    for (const event of record.events) statements.push(c.env.DB.prepare(`INSERT INTO asset_events (id, asset_id, event_type, occurred_at, title, description, sale_id, new_value_json, operator_user_id, visibility, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '历史保修表')`).bind(id(), assetId, event.eventType, event.occurredAt, event.title, event.description, saleId, event.newValue ? JSON.stringify(event.newValue) : null, user.id, event.visibility));
    for (const note of record.notes) statements.push(c.env.DB.prepare(`INSERT INTO asset_notes (id, asset_id, category, content, visibility, source, created_by)
      VALUES (?, ?, ?, ?, ?, '历史保修表', ?)`).bind(id(), assetId, note.category, note.content, note.visibility, user.id));
    statements.push(c.env.DB.prepare(`UPDATE asset_import_rows SET disposition = 'imported', imported_asset_id = ?, imported_at = CURRENT_TIMESTAMP WHERE id = ? AND disposition = 'pending'`).bind(assetId, row.id));
    importedRows += 1;
  }
  statements.push(
    c.env.DB.prepare(`UPDATE asset_import_batches SET status = ?, confirmed_at = CURRENT_TIMESTAMP, confirmed_by = ? WHERE id = ?`).bind(skippedRows ? 'completed_with_skips' : 'completed', user.id, batch.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'asset_import.confirm', entityType: 'asset_import_batch', entityId: batch.id, requestId: c.get('requestId'), after: { importedRows, skippedRows } })
  );
  await runStatementsInChunks(c.env.DB, statements);
  return c.json({ ...(await importBatchPreview(c.env.DB, batch.id)), importedRows, skippedRows });
});

app.get('/gsx/search', requireAuth, async (c) => {
  const user = c.get('user');
  assertAssetReadAccess(user);
  const query = normalizeLookup(c.req.query('q') ?? '');
  if (query.length < 4) throw badRequest('请输入至少 4 位 SN 或资产标识');
  const scope = assetScope(user);
  const prefix = likePattern(query, 'prefix');
  const contains = likePattern(query, 'contains');
  const rankParams = [query, query, query, prefix, prefix, prefix, contains, contains, contains];
  const matchParams = [query, query, query, prefix, prefix, prefix, contains, contains, contains];
  const items = await all<{ id: string; currentSn: string | null; originalSn: string | null; productName: string; version: string; sourceChannel: string; warrantyEndAt: string | null; warrantyStartAt: string | null; warrantyOverrideStatus: string | null; assetStatus: string; dataQualityStatus: string; rank: number }>(c.env.DB,
    `SELECT assets.id, assets.current_sn AS currentSn, assets.original_sn AS originalSn, assets.product_name_snapshot AS productName, assets.version_snapshot AS version,
      assets.source_channel AS sourceChannel, assets.warranty_end_at AS warrantyEndAt, assets.warranty_start_at AS warrantyStartAt, assets.warranty_override_status AS warrantyOverrideStatus, assets.asset_status AS assetStatus, assets.data_quality_status AS dataQualityStatus
      , MIN(CASE
        WHEN assets.current_sn = ? COLLATE NOCASE THEN 1
        WHEN assets.original_sn = ? COLLATE NOCASE THEN 2
        WHEN asset_identifiers.identifier_value = ? COLLATE NOCASE THEN 3
        WHEN assets.current_sn LIKE ? ESCAPE '\\' THEN 4
        WHEN assets.original_sn LIKE ? ESCAPE '\\' THEN 5
        WHEN asset_identifiers.identifier_value LIKE ? ESCAPE '\\' THEN 6
        WHEN assets.current_sn LIKE ? ESCAPE '\\' THEN 7
        WHEN assets.original_sn LIKE ? ESCAPE '\\' THEN 8
        WHEN asset_identifiers.identifier_value LIKE ? ESCAPE '\\' THEN 9
        ELSE 99 END) AS rank
     FROM assets LEFT JOIN asset_identifiers ON asset_identifiers.asset_id = assets.id LEFT JOIN asset_sales ON asset_sales.id IN (SELECT sale_id FROM asset_sale_assets WHERE asset_id = assets.id)
     LEFT JOIN orders ON orders.id = assets.latest_order_id LEFT JOIN after_sales_cases ON after_sales_cases.asset_id = assets.id
     WHERE ${scope.sql} AND (
      assets.current_sn = ? COLLATE NOCASE OR assets.original_sn = ? COLLATE NOCASE OR asset_identifiers.identifier_value = ? COLLATE NOCASE
      OR assets.current_sn LIKE ? ESCAPE '\\' OR assets.original_sn LIKE ? ESCAPE '\\' OR asset_identifiers.identifier_value LIKE ? ESCAPE '\\'
      OR assets.current_sn LIKE ? ESCAPE '\\' OR assets.original_sn LIKE ? ESCAPE '\\' OR asset_identifiers.identifier_value LIKE ? ESCAPE '\\'
      OR asset_sales.tracking_number = ? COLLATE NOCASE OR orders.order_no = ? COLLATE NOCASE OR after_sales_cases.case_no = ? COLLATE NOCASE)
     GROUP BY assets.id
     ORDER BY rank ASC, assets.updated_at DESC, COALESCE(assets.current_sn, assets.original_sn, '') ASC LIMIT 20`, ...rankParams, ...scope.params, ...matchParams, query, query, query);
  return c.json({ items: items.map((item) => ({ ...item, warrantyStatus: warrantyDisplayStatus(item) })) });
});

app.get('/assets', requireAuth, async (c) => {
  const user = c.get('user');
  assertAssetReadAccess(user);
  const scope = assetScope(user);
  const filters: string[] = [scope.sql];
  const params: unknown[] = [...scope.params];
  const search = (c.req.query('search') ?? '').trim();
  const version = (c.req.query('version') ?? '').trim();
  const assetStatus = (c.req.query('assetStatus') ?? '').trim();
  const channel = (c.req.query('channel') ?? '').trim();
  const warehouse = (c.req.query('warehouse') ?? '').trim();
  const quality = (c.req.query('quality') ?? '').trim();
  const warrantyStatus = (c.req.query('warrantyStatus') ?? '').trim();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  if (search) { const like = `%${search.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`; filters.push(`(assets.current_sn LIKE ? ESCAPE '\\' OR assets.original_sn LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM asset_identifiers WHERE asset_id = assets.id AND identifier_value LIKE ? ESCAPE '\\'))`); params.push(like, like, like); }
  if (version) { filters.push('assets.version_snapshot = ?'); params.push(version); }
  if (assetStatus) { filters.push('assets.asset_status = ?'); params.push(assetStatus); }
  if (channel) { filters.push('assets.source_channel = ?'); params.push(channel); }
  if (warehouse) { filters.push('assets.shipping_warehouse = ?'); params.push(warehouse); }
  if (quality === 'exception') filters.push(`(assets.data_quality_status <> 'normal' OR assets.warranty_override_status IN ('exception','denied','cancelled','scrapped'))`);
  else if (quality) { filters.push('assets.data_quality_status = ?'); params.push(quality); }
  if (warrantyStatus === '保修中' || warrantyStatus === '在保') { filters.push(`assets.warranty_override_status IS NULL AND assets.warranty_start_at IS NOT NULL AND assets.warranty_end_at IS NOT NULL AND assets.warranty_start_at <= ? AND assets.warranty_end_at >= ?`); params.push(today, today); }
  if (warrantyStatus === '待生效') { filters.push(`assets.warranty_override_status IS NULL AND assets.warranty_start_at IS NOT NULL AND assets.warranty_start_at > ?`); params.push(today); }
  if (warrantyStatus === '已过保') { filters.push(`assets.warranty_override_status IS NULL AND assets.warranty_end_at IS NOT NULL AND assets.warranty_end_at < ?`); params.push(today); }
  if (warrantyStatus === '无有效日期') filters.push(`assets.warranty_override_status IS NULL AND (assets.warranty_start_at IS NULL OR assets.warranty_end_at IS NULL)`);
  const overrideMap: Record<string, string> = { '无保修': 'no_warranty', '拒保': 'denied', '异常': 'exception', '注销': 'cancelled', '报废': 'scrapped' };
  if (overrideMap[warrantyStatus]) { filters.push('assets.warranty_override_status = ?'); params.push(overrideMap[warrantyStatus]); }
  const where = filters.join(' AND ');
  const page = pageValue(c.req.query('page'));
  const limit = limitValue(c.req.query('limit'), 30);
  const [count, items, versions, channels, warehouses] = await Promise.all([
    one<{ count: number }>(c.env.DB, `SELECT COUNT(*) AS count FROM assets WHERE ${where}`, ...params),
    all<{ id: string; currentSn: string | null; originalSn: string | null; productName: string; version: string; sourceChannel: string; shippingWarehouse: string; warrantyEndAt: string | null; warrantyStartAt: string | null; warrantyOverrideStatus: string | null; assetStatus: string; dataQualityStatus: string; latestEvent: string | null; updatedAt: string }>(c.env.DB,
      `SELECT assets.id, assets.current_sn AS currentSn, assets.original_sn AS originalSn, assets.product_name_snapshot AS productName, assets.version_snapshot AS version, assets.source_channel AS sourceChannel, assets.shipping_warehouse AS shippingWarehouse,
       assets.warranty_end_at AS warrantyEndAt, assets.warranty_start_at AS warrantyStartAt, assets.warranty_override_status AS warrantyOverrideStatus, assets.asset_status AS assetStatus, assets.data_quality_status AS dataQualityStatus,
       (SELECT title FROM asset_events WHERE asset_id = assets.id ORDER BY COALESCE(occurred_at, created_at) DESC, created_at DESC LIMIT 1) AS latestEvent, assets.updated_at AS updatedAt
       FROM assets WHERE ${where} ORDER BY assets.updated_at DESC LIMIT ? OFFSET ?`, ...params, limit, (page - 1) * limit),
    all<{ value: string }>(c.env.DB, `SELECT DISTINCT version_snapshot AS value FROM assets WHERE ${scope.sql} AND version_snapshot <> '' ORDER BY value`, ...scope.params),
    all<{ value: string }>(c.env.DB, `SELECT DISTINCT source_channel AS value FROM assets WHERE ${scope.sql} AND source_channel <> '' ORDER BY value`, ...scope.params),
    all<{ value: string }>(c.env.DB, `SELECT DISTINCT shipping_warehouse AS value FROM assets WHERE ${scope.sql} AND shipping_warehouse <> '' ORDER BY value`, ...scope.params)
  ]);
  return c.json({ items: items.map((item) => ({ ...item, warrantyStatus: warrantyDisplayStatus(item) })), filters: { versions: versions.map((row) => row.value), channels: channels.map((row) => row.value), warehouses: warehouses.map((row) => row.value) }, pagination: { page, total: count?.count ?? 0, totalPages: Math.max(1, Math.ceil((count?.count ?? 0) / limit)) } });
});

app.get('/assets/:id', requireAuth, async (c) => {
  const user = c.get('user');
  assertAssetReadAccess(user);
  const scope = assetScope(user);
  const asset = await one<{ id: string; currentSn: string | null; originalSn: string | null; productId: string | null; productName: string; version: string; sku: string | null; materialCode: string | null; assetStatus: string; warrantyPolicy: string; warrantyStartAt: string | null; warrantyEndAt: string | null; warrantyOverrideStatus: string | null; warrantyOverrideReason: string; sourceChannel: string; shippingWarehouse: string; dealerId: string | null; dealerName: string | null; storeId: string | null; storeName: string | null; latestOrderId: string | null; latestOrderNo: string | null; orderStatus: string | null; salePriceCents: number | null; shippingAddress: string | null; customerProfile: string | null; screenshotDataUrl: string | null; dataQualityStatus: string; updatedByName: string | null; createdAt: string; updatedAt: string }>(c.env.DB,
    `SELECT assets.id, assets.current_sn AS currentSn, assets.original_sn AS originalSn, assets.product_id AS productId, assets.product_name_snapshot AS productName, assets.version_snapshot AS version, products.sku, products.sku AS materialCode, assets.asset_status AS assetStatus, assets.warranty_policy AS warrantyPolicy,
      assets.warranty_start_at AS warrantyStartAt, assets.warranty_end_at AS warrantyEndAt, assets.warranty_override_status AS warrantyOverrideStatus, assets.warranty_override_reason AS warrantyOverrideReason,
      assets.source_channel AS sourceChannel, assets.shipping_warehouse AS shippingWarehouse, assets.dealer_id AS dealerId, dealers.name AS dealerName, assets.store_id AS storeId, stores.name AS storeName, assets.latest_order_id AS latestOrderId, orders.order_no AS latestOrderNo,
      orders.status AS orderStatus, orders.sale_price_cents AS salePriceCents, orders.shipping_address AS shippingAddress, orders.customer_profile AS customerProfile, orders.screenshot_data_url AS screenshotDataUrl,
      assets.data_quality_status AS dataQualityStatus, updater.name AS updatedByName, assets.created_at AS createdAt, assets.updated_at AS updatedAt
      FROM assets LEFT JOIN products ON products.id = assets.product_id LEFT JOIN dealers ON dealers.id = assets.dealer_id LEFT JOIN stores ON stores.id = assets.store_id LEFT JOIN orders ON orders.id = assets.latest_order_id LEFT JOIN users AS updater ON updater.id = assets.updated_by WHERE assets.id = ? AND ${scope.sql}`, c.req.param('id'), ...scope.params);
  if (!asset) {
    if (hasGlobalAssetAccess(user)) throw notFound('未找到该资产');
    throw forbidden('未找到该资产或你无权查看');
  }
  const visibility = eventVisibilityScope(user);
  const [identifiers, events, serviceCases, notes, sales, audit] = await Promise.all([
    all(c.env.DB, `SELECT identifier_type AS identifierType, identifier_value AS identifierValue, is_current AS isCurrent, valid_from AS validFrom, valid_to AS validTo, reason, source, created_at AS createdAt FROM asset_identifiers WHERE asset_id = ? ORDER BY is_current DESC, created_at DESC`, asset.id),
    all(c.env.DB, `SELECT asset_events.id, event_type AS eventType, occurred_at AS occurredAt, title, description, related_order_id AS relatedOrderId, related_service_case_id AS relatedServiceCaseId, users.name AS operatorName, visibility, source, asset_events.created_at AS createdAt FROM asset_events LEFT JOIN users ON users.id = asset_events.operator_user_id WHERE asset_id = ? AND ${visibility.sql} ORDER BY COALESCE(occurred_at, asset_events.created_at) DESC, asset_events.created_at DESC`, asset.id, ...visibility.params),
    all(c.env.DB, `SELECT after_sales_cases.id, after_sales_cases.case_no AS caseNo, after_sales_cases.status, after_sales_cases.workflow_stage AS workflowStage, after_sales_cases.subject, after_sales_cases.description, service_centers.name AS serviceCenterName, after_sales_cases.created_at AS createdAt, after_sales_cases.updated_at AS updatedAt,
      (SELECT details FROM after_sales_assessments WHERE case_id = after_sales_cases.id ORDER BY assessed_at DESC LIMIT 1) AS inspectionResult,
      (SELECT details FROM after_sales_recommendations WHERE case_id = after_sales_cases.id ORDER BY recommended_at DESC LIMIT 1) AS recommendation,
      (SELECT note FROM after_sales_approvals WHERE case_id = after_sales_cases.id ORDER BY approved_at DESC LIMIT 1) AS finalResult
      FROM after_sales_cases LEFT JOIN after_sales_assignments ON after_sales_assignments.case_id = after_sales_cases.id
      LEFT JOIN service_centers ON service_centers.id = after_sales_assignments.service_center_id
      WHERE after_sales_cases.asset_id = ? ORDER BY after_sales_cases.updated_at DESC`, asset.id),
    hasGlobalAssetAccess(user) ? all(c.env.DB, `SELECT category, content, visibility, source, created_at AS createdAt, created_at AS updatedAt FROM asset_notes WHERE asset_id = ? ORDER BY created_at DESC`, asset.id) : all(c.env.DB, `SELECT category, content, visibility, source, created_at AS createdAt, created_at AS updatedAt FROM asset_notes WHERE asset_id = ? AND visibility <> 'admin_private' ORDER BY created_at DESC`, asset.id),
    hasGlobalAssetAccess(user) ? all(c.env.DB, `SELECT source_channel AS sourceChannel, purchase_date AS purchaseDate, purchase_date_annotation AS purchaseDateAnnotation, purchase_price_raw AS purchasePriceRaw, unit_price_cents AS unitPriceCents, quantity, total_price_cents AS totalPriceCents, payment_status AS paymentStatus, payment_amount_cents AS paymentAmountCents, payment_raw AS paymentRaw, tracking_number AS trackingNumber, shipping_warehouse AS shippingWarehouse FROM asset_sales JOIN asset_sale_assets ON asset_sale_assets.sale_id = asset_sales.id WHERE asset_sale_assets.asset_id = ? ORDER BY purchase_date DESC`, asset.id) : all(c.env.DB, `SELECT source_channel AS sourceChannel, purchase_date AS purchaseDate, tracking_number AS trackingNumber, shipping_warehouse AS shippingWarehouse FROM asset_sales JOIN asset_sale_assets ON asset_sale_assets.sale_id = asset_sales.id WHERE asset_sale_assets.asset_id = ? ORDER BY purchase_date DESC`, asset.id),
    hasGlobalAssetAccess(user) || user.roles.includes('authorized_service_center') ? all(c.env.DB, `SELECT audit_logs.action, audit_logs.created_at AS createdAt, users.name AS actorName FROM audit_logs LEFT JOIN users ON users.id = audit_logs.actor_id WHERE entity_type = 'asset' AND entity_id = ? ORDER BY audit_logs.created_at DESC LIMIT 100`, asset.id) : Promise.resolve([])
  ]);
  return c.json({ asset: { ...asset, warrantyStatus: warrantyDisplayStatus(asset), warrantyDays: asset.sku ? shipmentWarrantyRule(asset.sku)?.durationDays ?? null : null, ...(hasGlobalAssetAccess(user) || user.roles.includes('authorized_service_center') ? {} : { warrantyOverrideReason: '' }) }, identifiers, events, serviceCases, notes, sales, audit });
});

app.patch('/admin/assets/:id/warranty', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'asset:manage');
  const input = await parseBody(c.req.raw, updateAssetWarrantySchema);
  const asset = await one<{ id: string; warrantyOverrideStatus: string | null; warrantyOverrideReason: string }>(c.env.DB, 'SELECT id, warranty_override_status AS warrantyOverrideStatus, warranty_override_reason AS warrantyOverrideReason FROM assets WHERE id = ?', c.req.param('id'));
  if (!asset) throw notFound('未找到该资产');
  const eventType = input.warrantyOverrideStatus === 'denied' ? 'warranty_denied' : input.warrantyOverrideStatus === 'cancelled' ? 'warranty_cancelled' : input.warrantyOverrideStatus === 'scrapped' ? 'scrapped' : 'note_added';
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE assets SET warranty_override_status = ?, warranty_override_reason = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?`).bind(input.warrantyOverrideStatus, input.warrantyOverrideReason, user.id, asset.id),
    c.env.DB.prepare(`INSERT INTO asset_events (id, asset_id, event_type, occurred_at, title, description, old_value_json, new_value_json, operator_user_id, visibility, source)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP, '更新人工保修状态', ?, ?, ?, ?, 'admin_private', 'GSX')`).bind(id(), asset.id, eventType, input.warrantyOverrideReason || '已恢复按日期计算保修状态', JSON.stringify({ status: asset.warrantyOverrideStatus, reason: asset.warrantyOverrideReason }), JSON.stringify(input), user.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'asset.warranty_override', entityType: 'asset', entityId: asset.id, requestId: c.get('requestId'), before: asset, after: input })
  ]);
  return c.json({ id: asset.id });
});

app.patch('/admin/assets/:id', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'asset:manage');
  const input = await parseBody(c.req.raw, updateAssetSchema);
  const assetId = c.req.param('id');
  const asset = await one<Record<string, unknown> & { id: string; currentSn: string | null; warrantyStartAt: string | null; warrantyEndAt: string | null; warrantyOverrideReason: string }>(c.env.DB,
    `SELECT id, current_sn AS currentSn, original_sn AS originalSn, product_id AS productId, product_name_snapshot AS productName, version_snapshot AS version,
      asset_status AS assetStatus, warranty_policy AS warrantyPolicy, warranty_start_at AS warrantyStartAt, warranty_end_at AS warrantyEndAt,
      warranty_override_status AS warrantyOverrideStatus, warranty_override_reason AS warrantyOverrideReason, source_channel AS sourceChannel,
      shipping_warehouse AS shippingWarehouse, dealer_id AS dealerId, store_id AS storeId, latest_order_id AS latestOrderId FROM assets WHERE id = ?`, assetId);
  if (!asset) throw notFound('未找到该资产');
  if (input.currentSn && input.currentSn !== asset.currentSn) {
    const duplicate = await one<{ id: string }>(c.env.DB, `SELECT id FROM assets WHERE current_sn = ? COLLATE NOCASE AND id <> ? LIMIT 1`, input.currentSn, assetId);
    if (duplicate) throw conflict('当前 SN 已被其他资产使用');
  }
  if (input.productId) {
    const product = await one<{ id: string }>(c.env.DB, 'SELECT id FROM products WHERE id = ?', input.productId);
    if (!product) throw badRequest('所选产品不存在');
  }
  if (input.dealerId) {
    const dealer = await one<{ id: string }>(c.env.DB, 'SELECT id FROM dealers WHERE id = ?', input.dealerId);
    if (!dealer) throw badRequest('所选经销商不存在');
  }
  if (input.storeId) {
    const store = await one<{ id: string; dealerId: string }>(c.env.DB, 'SELECT id, dealer_id AS dealerId FROM stores WHERE id = ?', input.storeId);
    if (!store) throw badRequest('所选店铺不存在');
    if (input.dealerId && store.dealerId !== input.dealerId) throw badRequest('店铺不属于所选经销商');
  }
  if (input.latestOrderId) {
    const order = await one<{ id: string }>(c.env.DB, 'SELECT id FROM orders WHERE id = ?', input.latestOrderId);
    if (!order) throw badRequest('所选订单不存在');
  }
  const columnMap: Record<string, string> = {
    currentSn: 'current_sn',
    originalSn: 'original_sn',
    productId: 'product_id',
    productName: 'product_name_snapshot',
    version: 'version_snapshot',
    assetStatus: 'asset_status',
    warrantyPolicy: 'warranty_policy',
    warrantyStartAt: 'warranty_start_at',
    warrantyEndAt: 'warranty_end_at',
    warrantyOverrideStatus: 'warranty_override_status',
    warrantyOverrideReason: 'warranty_override_reason',
    sourceChannel: 'source_channel',
    shippingWarehouse: 'shipping_warehouse',
    dealerId: 'dealer_id',
    storeId: 'store_id',
    latestOrderId: 'latest_order_id'
  };
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(columnMap)) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const next = (input as Record<string, unknown>)[key];
    if (next === asset[key]) continue;
    changes[key] = { before: asset[key], after: next };
    sets.push(`${column} = ?`);
    values.push(next);
  }
  if (!sets.length && !input.noteContent) return c.json({ id: assetId, changedFields: [] });
  const statements: D1PreparedStatement[] = [];
  if (sets.length) statements.push(c.env.DB.prepare(`UPDATE assets SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?`).bind(...values, user.id, assetId));
  if (changes.currentSn) {
    if (asset.currentSn) statements.push(c.env.DB.prepare(`UPDATE asset_identifiers SET is_current = 0, valid_to = CURRENT_TIMESTAMP WHERE asset_id = ? AND identifier_value = ? COLLATE NOCASE AND is_current = 1`).bind(assetId, asset.currentSn));
    if (asset.currentSn) statements.push(c.env.DB.prepare(`INSERT INTO asset_identifiers (id, asset_id, identifier_type, identifier_value, is_current, valid_to, reason, source, created_by)
      VALUES (?, ?, 'legacy_sn', ?, 0, CURRENT_TIMESTAMP, '管理员修改当前 SN 后自动保留', 'GSX 编辑', ?)`).bind(id(), assetId, asset.currentSn, user.id));
    statements.push(c.env.DB.prepare(`INSERT INTO asset_identifiers (id, asset_id, identifier_type, identifier_value, is_current, valid_from, reason, source, created_by)
      VALUES (?, ?, 'current_sn', ?, 1, CURRENT_TIMESTAMP, '管理员修改当前 SN', 'GSX 编辑', ?)`).bind(id(), assetId, input.currentSn, user.id));
    statements.push(c.env.DB.prepare(`INSERT INTO asset_events (id, asset_id, event_type, occurred_at, title, description, old_value_json, new_value_json, operator_user_id, visibility, source)
      VALUES (?, ?, 'sn_changed', CURRENT_TIMESTAMP, '修改当前 SN', ?, ?, ?, ?, 'admin_private', 'GSX 编辑')`)
      .bind(id(), assetId, `${asset.currentSn || '空'} → ${input.currentSn}`, JSON.stringify({ currentSn: asset.currentSn }), JSON.stringify({ currentSn: input.currentSn }), user.id));
  }
  if (changes.warrantyStartAt || changes.warrantyEndAt || changes.warrantyOverrideStatus || changes.warrantyOverrideReason) {
    statements.push(c.env.DB.prepare(`INSERT INTO asset_events (id, asset_id, event_type, occurred_at, title, description, old_value_json, new_value_json, operator_user_id, visibility, source)
      VALUES (?, ?, 'warranty_extended', CURRENT_TIMESTAMP, '修改保修信息', ?, ?, ?, ?, 'admin_private', 'GSX 编辑')`)
      .bind(id(), assetId, input.warrantyOverrideReason || '管理员调整保修信息', JSON.stringify(asset), JSON.stringify(input), user.id));
  }
  if (input.noteContent) statements.push(c.env.DB.prepare(`INSERT INTO asset_notes (id, asset_id, category, content, visibility, source, created_by)
    VALUES (?, ?, 'private_admin', ?, 'admin_private', 'GSX 编辑', ?)`).bind(id(), assetId, input.noteContent, user.id));
  statements.push(dbAudit(c.env.DB, { actorId: user.id, action: 'asset.update', entityType: 'asset', entityId: assetId, requestId: c.get('requestId'), before: Object.fromEntries(Object.entries(changes).map(([key, change]) => [key, change.before])), after: Object.fromEntries(Object.entries(changes).map(([key, change]) => [key, change.after])) }));
  await c.env.DB.batch(statements);
  return c.json({ id: assetId, changedFields: Object.keys(changes) });
});

app.post('/assets/:id/after-sales', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'after-sales:create');
  const input = await parseBody(c.req.raw, createAssetAfterSalesSchema);
  const scope = assetScope(user);
  const asset = await one<{ id: string; productId: string | null; currentSn: string | null }>(c.env.DB, `SELECT id, product_id AS productId, current_sn AS currentSn FROM assets WHERE id = ? AND ${scope.sql}`, c.req.param('id'), ...scope.params);
  if (!asset) throw forbidden('你无权为该资产创建售后工单');
  assertStoreAccess(user, input.storeId);
  const store = await one<{ dealerId: string }>(c.env.DB, `SELECT dealer_id AS dealerId FROM stores WHERE id = ? AND status = 'active'`, input.storeId);
  if (!store) throw badRequest('所选店铺不可用');
  const existing = await one<{ id: string }>(c.env.DB, `SELECT id FROM after_sales_cases WHERE asset_id = ? AND status IN ('open','in_progress')`, asset.id);
  if (existing) throw conflict('该资产已有未关闭的售后工单，请先继续处理原工单');
  const caseId = id();
  const number = caseNo();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO after_sales_cases (id, case_no, dealer_id, store_id, product_id, serial_number, asset_id, case_type, subject, description, status, workflow_stage, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 'open', ?, ?)`).bind(caseId, number, store.dealerId, input.storeId, asset.productId, asset.currentSn, asset.id, input.caseType, input.subject, input.description, user.id, user.id),
    c.env.DB.prepare(`INSERT INTO asset_events (id, asset_id, event_type, occurred_at, title, description, related_service_case_id, operator_user_id, visibility, source)
      VALUES (?, ?, 'service_received', CURRENT_TIMESTAMP, '创建售后工单', ?, ?, ?, 'service_center', 'GSX')`).bind(id(), asset.id, input.subject, caseId, user.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'asset.after_sales_create', entityType: 'asset', entityId: asset.id, requestId: c.get('requestId'), after: { caseId, caseNo: number } })
  ]);
  return c.json({ id: caseId, caseNo: number }, 201);
});

app.post('/admin/products', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'inventory:manage');
  const input = await parseBody(c.req.raw, createProductSchema);
  const productId = id();
  const inventoryId = id();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO products (id, sku, name, description, product_version, specification, unit_price_cents, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(productId, input.sku, input.name, input.description, input.productVersion, input.specification, input.unitPriceCents, user.id, user.id),
    c.env.DB.prepare('INSERT INTO inventory (id, product_id, reorder_level, created_by, updated_by) VALUES (?, ?, ?, ?, ?)').bind(inventoryId, productId, input.reorderLevel, user.id, user.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'product.create', entityType: 'product', entityId: productId, requestId: c.get('requestId'), after: { sku: input.sku } })
  ]);
  return c.json({ id: productId, inventoryId }, 201);
});

app.post('/admin/inventory/:id/adjustments', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'inventory:manage');
  const input = await parseBody(c.req.raw, adjustInventorySchema);
  const inventory = await one<{ id: string; productId: string; quantity: number }>(c.env.DB, 'SELECT id, product_id AS productId, quantity FROM inventory WHERE id = ?', c.req.param('id'));
  if (!inventory) throw notFound('未找到该库存记录');
  if (inventory.quantity + input.quantityDelta < 0) throw conflict('调整后库存不能小于零');
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO inventory_transactions (id, inventory_id, product_id, transaction_type, quantity_delta, note, created_by)
        VALUES (?, ?, ?, 'adjustment', ?, ?, ?)`).bind(id(), inventory.id, inventory.productId, input.quantityDelta, input.note, user.id),
      dbAudit(c.env.DB, { actorId: user.id, action: 'inventory.adjust', entityType: 'inventory', entityId: inventory.id, requestId: c.get('requestId'), before: { quantity: inventory.quantity }, after: { quantityDelta: input.quantityDelta, note: input.note } })
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Inventory cannot be negative')) throw conflict('调整后库存不能小于零');
    throw error;
  }
  return c.json({ id: inventory.id, quantityDelta: input.quantityDelta });
});

app.post('/admin/dealers', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'dealer:manage');
  const input = await parseBody(c.req.raw, createDealerSchema);
  const dealerId = id();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO dealers (id, code, name, province, authorization_type, service_center_id, contact_name, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(dealerId, input.code, input.name, input.province, input.authorizationType, input.serviceCenterId, input.contactName, user.id, user.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'dealer.create', entityType: 'dealer', entityId: dealerId, requestId: c.get('requestId'), after: input })
  ]);
  return c.json({ id: dealerId }, 201);
});

app.post('/admin/stores', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'store:manage');
  const input = await parseBody(c.req.raw, createStoreSchema);
  const dealer = await one<{ id: string }>(c.env.DB, 'SELECT id FROM dealers WHERE id = ? AND status = \'active\'', input.dealerId);
  if (!dealer) throw badRequest('所选经销商不可用');
  const owner = await one<{ id: string }>(c.env.DB, 'SELECT id FROM users WHERE id = ? AND is_active = 1', input.ownerUserId);
  if (!owner) throw badRequest('所选店铺负责人不可用');
  const storeId = id();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO stores (id, dealer_id, code, name, platform, owner_user_id, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(storeId, input.dealerId, input.code, input.name, input.platform, input.ownerUserId, user.id, user.id),
    c.env.DB.prepare(`INSERT INTO store_user_assignments (user_id, store_id, access_level, assigned_by) VALUES (?, ?, 'owner', ?)`).bind(input.ownerUserId, storeId, user.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'store.create', entityType: 'store', entityId: storeId, requestId: c.get('requestId'), after: input })
  ]);
  return c.json({ id: storeId }, 201);
});

app.post('/admin/users', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'user:manage');
  const input = await parseBody(c.req.raw, createUserSchema);
  const dealerIds = input.dealerIds ?? [];
  const serviceCenterIds = input.serviceCenterIds ?? [];
  const storeIds = input.storeIds ?? [];
  const [selectedRoles, dealerCount, centerCount, storeCount] = await Promise.all([
    all<{ id: string; code: string }>(c.env.DB, `SELECT id, code FROM roles WHERE is_active = 1 AND id IN (${placeholders(input.roleIds)})`, ...input.roleIds),
    dealerIds.length ? one<{ count: number }>(c.env.DB, `SELECT COUNT(*) AS count FROM dealers WHERE status = 'active' AND id IN (${placeholders(dealerIds)})`, ...dealerIds) : Promise.resolve({ count: 0 }),
    serviceCenterIds.length ? one<{ count: number }>(c.env.DB, `SELECT COUNT(*) AS count FROM service_centers WHERE status = 'active' AND id IN (${placeholders(serviceCenterIds)})`, ...serviceCenterIds) : Promise.resolve({ count: 0 }),
    storeIds.length ? one<{ count: number }>(c.env.DB, `SELECT COUNT(*) AS count FROM stores WHERE status = 'active' AND id IN (${placeholders(storeIds)})`, ...storeIds) : Promise.resolve({ count: 0 })
  ]);
  if (selectedRoles.length !== new Set(input.roleIds).size || dealerCount?.count !== new Set(dealerIds).size || centerCount?.count !== new Set(serviceCenterIds).size || storeCount?.count !== new Set(storeIds).size) throw badRequest('角色或授权关系包含不可用的记录');
  if (selectedRoles.some((role) => role.code === 'dealer') && !dealerIds.length) throw badRequest('经销商角色必须同时记录经销商资格');
  if (selectedRoles.some((role) => role.code === 'authorized_service_center') && !serviceCenterIds.length) throw badRequest('授权服务中心角色必须同时记录服务中心资格');
  const userId = id();
  const passwordHash = await hashPassword(input.password);
  await c.env.DB.batch([
    // role/dealer_id are legacy non-authoritative columns retained for the 0001 schema only.
    c.env.DB.prepare(`INSERT INTO users (id, email, password_hash, name, role, dealer_id, created_by, updated_by) VALUES (?, ?, ?, ?, 'admin', NULL, ?, ?)`)
      .bind(userId, input.email, passwordHash, input.name, user.id, user.id),
    ...input.roleIds.map((roleId) => c.env.DB.prepare('INSERT INTO user_roles (user_id, role_id, assigned_by) VALUES (?, ?, ?)').bind(userId, roleId, user.id)),
    ...dealerIds.map((dealerId) => c.env.DB.prepare('INSERT INTO dealer_user_assignments (user_id, dealer_id, assigned_by) VALUES (?, ?, ?)').bind(userId, dealerId, user.id)),
    ...serviceCenterIds.map((serviceCenterId) => c.env.DB.prepare('INSERT INTO service_center_user_assignments (user_id, service_center_id, assigned_by) VALUES (?, ?, ?)').bind(userId, serviceCenterId, user.id)),
    ...storeIds.map((storeId) => c.env.DB.prepare('INSERT INTO store_user_assignments (user_id, store_id, assigned_by) VALUES (?, ?, ?)').bind(userId, storeId, user.id)),
    dbAudit(c.env.DB, { actorId: user.id, action: 'user.create', entityType: 'user', entityId: userId, requestId: c.get('requestId'), after: { email: input.email, roleIds: input.roleIds } })
  ]);
  return c.json({ id: userId }, 201);
});

app.get('/admin/users', requireAuth, async (c) => {
  assertPermission(c.get('user'), 'user:manage');
  return c.json({ users: await all(c.env.DB, `SELECT users.id, users.email, users.name, users.is_active AS isActive, users.watermark_enabled AS watermarkEnabled, users.created_at AS createdAt,
    COALESCE(GROUP_CONCAT(roles.code, ','), '') AS roles FROM users
    LEFT JOIN user_roles ON user_roles.user_id = users.id LEFT JOIN roles ON roles.id = user_roles.role_id
    GROUP BY users.id ORDER BY users.created_at DESC`) });
});

app.get('/admin/users/:id', requireAuth, async (c) => {
  assertPermission(c.get('user'), 'user:manage');
  const account = await one(c.env.DB, 'SELECT id, email, name, is_active AS isActive, watermark_enabled AS watermarkEnabled, created_at AS createdAt, updated_at AS updatedAt FROM users WHERE id = ?', c.req.param('id'));
  if (!account) throw notFound('未找到该用户');
  const [roles, dealers, serviceCenters, stores] = await Promise.all([
    all(c.env.DB, 'SELECT roles.id, roles.code, roles.name FROM user_roles JOIN roles ON roles.id = user_roles.role_id WHERE user_id = ?', c.req.param('id')),
    all(c.env.DB, 'SELECT dealers.id, dealers.name FROM dealer_user_assignments JOIN dealers ON dealers.id = dealer_user_assignments.dealer_id WHERE user_id = ? AND dealer_user_assignments.status = \'active\'', c.req.param('id')),
    all(c.env.DB, 'SELECT service_centers.id, service_centers.name FROM service_center_user_assignments JOIN service_centers ON service_centers.id = service_center_user_assignments.service_center_id WHERE user_id = ? AND service_center_user_assignments.status = \'active\'', c.req.param('id')),
    all(c.env.DB, 'SELECT stores.id, stores.name FROM store_user_assignments JOIN stores ON stores.id = store_user_assignments.store_id WHERE user_id = ? AND store_user_assignments.status = \'active\'', c.req.param('id'))
  ]);
  return c.json({ user: account, roles, dealers, serviceCenters, stores });
});

app.get('/admin/options', requireAuth, async (c) => {
  assertPermission(c.get('user'), 'user:manage');
  const [roles, dealers, stores, users, serviceCenters] = await Promise.all([
    all(c.env.DB, "SELECT id, code, name FROM roles WHERE is_active = 1 ORDER BY name"),
    all(c.env.DB, "SELECT id, name FROM dealers WHERE status = 'active' ORDER BY name"),
    all(c.env.DB, "SELECT id, name FROM stores WHERE status = 'active' ORDER BY name"),
    all(c.env.DB, 'SELECT id, name, email FROM users WHERE is_active = 1 ORDER BY name'),
    all(c.env.DB, "SELECT id, name, province FROM service_centers WHERE status = 'active' ORDER BY name")
  ]);
  return c.json({ roles, dealers, stores, users, serviceCenters });
});

app.get('/admin/dealers', requireAuth, async (c) => {
  assertPermission(c.get('user'), 'dealer:manage');
  return c.json({ dealers: await all(c.env.DB, `SELECT dealers.id, dealers.code, dealers.name, dealers.province, dealers.authorization_type AS authorizationType, dealers.contact_name AS contactName, dealers.status, service_centers.name AS serviceCenterName, COUNT(DISTINCT stores.id) AS storeCount, COUNT(DISTINCT dealer_user_assignments.user_id) AS userCount, dealers.created_at AS createdAt, dealers.updated_at AS updatedAt FROM dealers LEFT JOIN stores ON stores.dealer_id = dealers.id LEFT JOIN dealer_user_assignments ON dealer_user_assignments.dealer_id = dealers.id AND dealer_user_assignments.status = 'active' LEFT JOIN service_centers ON service_centers.id = dealers.service_center_id GROUP BY dealers.id ORDER BY dealers.name`) });
});

app.get('/admin/dealers/:id', requireAuth, async (c) => {
  assertPermission(c.get('user'), 'dealer:manage');
  const dealer = await one(c.env.DB, `SELECT dealers.id, dealers.code, dealers.name, dealers.province, dealers.authorization_type AS authorizationType, dealers.service_center_id AS serviceCenterId, dealers.contact_name AS contactName, dealers.status, dealers.created_at AS createdAt, dealers.updated_at AS updatedAt, service_centers.name AS serviceCenterName FROM dealers LEFT JOIN service_centers ON service_centers.id = dealers.service_center_id WHERE dealers.id = ?`, c.req.param('id'));
  if (!dealer) throw notFound('未找到该经销商');
  const [stores, users, summary] = await Promise.all([
    all(c.env.DB, 'SELECT id, name, platform, status FROM stores WHERE dealer_id = ? ORDER BY name', c.req.param('id')),
    all(c.env.DB, `SELECT users.id, users.name, users.email FROM dealer_user_assignments JOIN users ON users.id = dealer_user_assignments.user_id WHERE dealer_id = ? AND dealer_user_assignments.status = 'active' ORDER BY users.name`, c.req.param('id')),
    one(c.env.DB, `SELECT (SELECT COUNT(*) FROM orders WHERE dealer_id = ?) AS orderCount, (SELECT COUNT(*) FROM after_sales_cases WHERE dealer_id = ?) AS afterSalesCount`, c.req.param('id'), c.req.param('id'))
  ]);
  return c.json({ dealer, stores, users, summary });
});

app.patch('/admin/dealers/:id', requireAuth, async (c) => {
  const user = c.get('user'); assertPermission(user, 'dealer:manage'); const input = await parseBody(c.req.raw, updateDealerSchema);
  const dealer = await one<{ id: string }>(c.env.DB, 'SELECT id FROM dealers WHERE id = ?', c.req.param('id')); if (!dealer) throw notFound('未找到该经销商');
  if (input.serviceCenterId) { const center = await one<{ id: string }>(c.env.DB, "SELECT id FROM service_centers WHERE id = ? AND status = 'active'", input.serviceCenterId); if (!center) throw badRequest('所选授权服务中心不可用'); }
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE dealers SET code = ?, name = ?, province = ?, authorization_type = ?, service_center_id = ?, contact_name = ?, status = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?').bind(input.code, input.name, input.province, input.authorizationType, input.serviceCenterId, input.contactName, input.status, user.id, dealer.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'dealer.update', entityType: 'dealer', entityId: dealer.id, requestId: c.get('requestId'), after: input })
  ]);
  return c.json({ id: dealer.id });
});

app.get('/admin/audit-logs', requireAuth, async (c) => {
  assertPermission(c.get('user'), 'audit:read');
  return c.json({ logs: await all(c.env.DB, `SELECT audit_logs.id, audit_logs.action, audit_logs.entity_type AS entityType, audit_logs.entity_id AS entityId, audit_logs.created_at AS createdAt, users.email AS actorEmail FROM audit_logs LEFT JOIN users ON users.id = audit_logs.actor_id ORDER BY audit_logs.created_at DESC LIMIT 200`) });
});

app.get('/admin/mail-center/status', requireAuth, async (c) => {
  assertPermission(c.get('user'), 'system:manage');
  const sender = notificationSender(c.env);
  const domain = await resendDomainStatus(c.env);
  const recent = await all(c.env.DB, `SELECT id, provider, template_key AS templateKey, subject, to_email AS toEmail, from_email AS fromEmail,
    reply_to_email AS replyToEmail, status, failure_reason AS failureReason, provider_message_id AS providerMessageId, created_at AS createdAt, sent_at AS sentAt
    FROM mail_center_messages ORDER BY created_at DESC LIMIT 20`);
  return c.json({
    provider: c.env.EMAIL_PROVIDER || 'mock',
    environment: mailEnvironment(c.env),
    resendConfigured: Boolean(c.env.RESEND_API_KEY),
    from: { name: sender.name, address: sender.address },
    replyTo: { name: sender.replyToName, address: sender.replyTo },
    domain,
    templates: Object.entries(mailTemplates).map(([key, value]) => ({ key, ...value })),
    recent
  });
});

app.post('/admin/mail-center/preview', requireAuth, async (c) => {
  assertPermission(c.get('user'), 'system:manage');
  const input = await parseBody(c.req.raw, mailPreviewSchema);
  const template = input.template as MailTemplateKey;
  const data = mailSampleData(c.env, template);
  return c.json({ template, subject: mailSubject(template, mailEnvironment(c.env)), html: renderMailHtml(data), text: renderMailText(data) });
});

app.post('/admin/mail-center/test-send', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'system:manage');
  const input = await parseBody(c.req.raw, mailTestSchema);
  const recent = await one<{ count: number }>(c.env.DB, `SELECT COUNT(*) AS count FROM mail_center_messages
    WHERE sent_by = ? AND template_key = 'system_test' AND created_at >= datetime('now', '-60 seconds')`, user.id);
  if ((recent?.count ?? 0) >= 3) throw conflict('测试邮件发送过于频繁，请一分钟后再试');
  const template = input.template as MailTemplateKey;
  const data = mailSampleData(c.env, template);
  const html = renderMailHtml(data);
  const text = renderMailText(data);
  const subject = mailSubject(template, mailEnvironment(c.env));
  const result = await sendViaMailCenter(c, { template, to: input.recipient, subject, html, text, idempotencyKey: input.idempotencyKey, actorId: user.id, relatedEntityType: 'mail_center_test', relatedEntityId: user.id });
  return c.json({ ...result, status: result.sent ? 'sent' : 'failed', subject });
});

app.get('/admin/dashboard', requireAuth, async (c) => {
  assertPermission(c.get('user'), 'data:read:all');
  const [submitted, service, assessment, fulfillment, lowStock, today, month] = await Promise.all([
    one<{ count: number }>(c.env.DB, "SELECT COUNT(*) AS count FROM orders WHERE status = 'submitted'"),
    one<{ count: number }>(c.env.DB, "SELECT COUNT(*) AS count FROM after_sales_cases WHERE status IN ('open', 'in_progress')"),
    one<{ count: number }>(c.env.DB, "SELECT COUNT(*) AS count FROM after_sales_cases WHERE workflow_stage IN ('received', 'assessed', 'recommended')"),
    one<{ count: number }>(c.env.DB, "SELECT COUNT(*) AS count FROM orders WHERE status IN ('approved', 'picking', 'packed')"),
    one<{ count: number }>(c.env.DB, 'SELECT COUNT(*) AS count FROM inventory WHERE quantity <= reorder_level'),
    one<{ count: number }>(c.env.DB, "SELECT COUNT(*) AS count FROM orders WHERE date(created_at) = date('now')"),
    one<{ count: number }>(c.env.DB, "SELECT COUNT(*) AS count FROM orders WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')")
  ]);
  return c.json({ summary: { submitted: submitted?.count ?? 0, service: service?.count ?? 0, assessment: assessment?.count ?? 0, fulfillment: fulfillment?.count ?? 0, lowStock: lowStock?.count ?? 0, today: today?.count ?? 0, month: month?.count ?? 0 } });
});

app.get('/admin/products', requireAuth, async (c) => {
  assertPermission(c.get('user'), 'inventory:manage');
  const search = new URL(c.req.url).searchParams.get('search')?.trim() ?? ''; const active = new URL(c.req.url).searchParams.get('active');
  return c.json({ products: await all(c.env.DB, `SELECT products.id, sku, name, description, product_version AS productVersion, specification, unit_price_cents AS unitPriceCents, is_active AS isActive, products.created_at AS createdAt, products.updated_at AS updatedAt, inventory.id AS inventoryId, inventory.quantity AS availableQuantity, inventory.reserved_quantity AS reservedQuantity, inventory.reorder_level AS reorderLevel FROM products JOIN inventory ON inventory.product_id = products.id WHERE (? = '' OR sku LIKE '%' || ? || '%' OR name LIKE '%' || ? || '%') AND (? = '' OR is_active = ?) ORDER BY sku`, search, search, search, active === 'true' || active === 'false' ? active : '', active === 'true' ? 1 : active === 'false' ? 0 : '') });
});

app.get('/admin/products/:id', requireAuth, async (c) => {
  assertPermission(c.get('user'), 'inventory:manage');
  const product = await one(c.env.DB, `SELECT products.id, sku, name, description, product_version AS productVersion, specification, unit_price_cents AS unitPriceCents, is_active AS isActive, products.created_at AS createdAt, products.updated_at AS updatedAt, inventory.id AS inventoryId, inventory.quantity AS availableQuantity, inventory.reserved_quantity AS reservedQuantity, inventory.reorder_level AS reorderLevel FROM products JOIN inventory ON inventory.product_id = products.id WHERE products.id = ?`, c.req.param('id'));
  if (!product) throw notFound('未找到该产品');
  const orderCount = await one<{ count: number }>(c.env.DB, 'SELECT COUNT(*) AS count FROM order_items WHERE product_id = ?', c.req.param('id'));
  return c.json({ product, orderCount: orderCount?.count ?? 0 });
});

app.patch('/admin/products/:id', requireAuth, async (c) => {
  const user = c.get('user'); assertPermission(user, 'inventory:manage'); const input = await parseBody(c.req.raw, updateProductSchema);
  const product = await one<{ id: string }>(c.env.DB, 'SELECT id FROM products WHERE id = ?', c.req.param('id')); if (!product) throw notFound('未找到该产品');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE products SET sku = ?, name = ?, description = ?, product_version = ?, specification = ?, unit_price_cents = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?').bind(input.sku, input.name, input.description, input.productVersion, input.specification, input.unitPriceCents, Number(input.isActive), user.id, product.id),
    c.env.DB.prepare('UPDATE inventory SET reorder_level = ?, updated_by = ? WHERE product_id = ?').bind(input.reorderLevel, user.id, product.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'product.update', entityType: 'product', entityId: product.id, requestId: c.get('requestId'), after: input })
  ]);
  return c.json({ id: product.id });
});

app.get('/admin/inventory', requireAuth, async (c) => {
  assertPermission(c.get('user'), 'inventory:manage');
  return c.json({ inventory: await all(c.env.DB, `SELECT inventory.id, products.sku, products.name, inventory.quantity AS availableQuantity, inventory.reserved_quantity AS reservedQuantity, inventory.reorder_level AS reorderLevel, inventory.updated_at AS updatedAt FROM inventory JOIN products ON products.id = inventory.product_id ORDER BY products.sku`) });
});

app.get('/admin/inventory/:id/transactions', requireAuth, async (c) => {
  assertPermission(c.get('user'), 'inventory:manage');
  return c.json({ transactions: await all(c.env.DB, `SELECT inventory_transactions.id, transaction_type AS transactionType, quantity_delta AS quantityDelta, reserved_delta AS reservedDelta, note, created_at AS createdAt, users.name AS actorName FROM inventory_transactions LEFT JOIN users ON users.id = inventory_transactions.created_by WHERE inventory_id = ? ORDER BY created_at DESC`, c.req.param('id')) });
});

app.get('/admin/stores', requireAuth, async (c) => {
  assertPermission(c.get('user'), 'store:manage');
  return c.json({ stores: await all(c.env.DB, `SELECT stores.id, stores.dealer_id AS dealerId, stores.code, stores.name, stores.platform, stores.owner_user_id AS ownerUserId, stores.status, stores.created_at AS createdAt, stores.updated_at AS updatedAt, dealers.name AS dealerName, owner.name AS ownerName FROM stores JOIN dealers ON dealers.id = stores.dealer_id LEFT JOIN users AS owner ON owner.id = stores.owner_user_id ORDER BY stores.name`) });
});

app.get('/admin/stores/:id', requireAuth, async (c) => {
  assertPermission(c.get('user'), 'store:manage');
  const store = await one(c.env.DB, `SELECT stores.id, stores.dealer_id AS dealerId, stores.code, stores.name, stores.platform, stores.owner_user_id AS ownerUserId, stores.status, stores.created_at AS createdAt, stores.updated_at AS updatedAt, dealers.name AS dealerName, owner.name AS ownerName FROM stores JOIN dealers ON dealers.id = stores.dealer_id LEFT JOIN users AS owner ON owner.id = stores.owner_user_id WHERE stores.id = ?`, c.req.param('id'));
  if (!store) throw notFound('未找到该店铺');
  const [users, summary] = await Promise.all([
    all(c.env.DB, `SELECT users.id, users.name, users.email, store_user_assignments.access_level AS accessLevel FROM store_user_assignments JOIN users ON users.id = store_user_assignments.user_id WHERE store_id = ? AND store_user_assignments.status = 'active' ORDER BY users.name`, c.req.param('id')),
    one(c.env.DB, `SELECT (SELECT COUNT(*) FROM orders WHERE store_id = ?) AS orderCount, (SELECT COUNT(*) FROM after_sales_cases WHERE store_id = ?) AS afterSalesCount`, c.req.param('id'), c.req.param('id'))
  ]);
  return c.json({ store, users, summary });
});

app.patch('/admin/stores/:id', requireAuth, async (c) => {
  const user = c.get('user'); assertPermission(user, 'store:manage'); const input = await parseBody(c.req.raw, updateStoreSchema);
  const store = await one<{ id: string; ownerUserId: string | null }>(c.env.DB, 'SELECT id, owner_user_id AS ownerUserId FROM stores WHERE id = ?', c.req.param('id')); if (!store) throw notFound('未找到该店铺');
  const dealer = await one<{ id: string }>(c.env.DB, "SELECT id FROM dealers WHERE id = ? AND status = 'active'", input.dealerId); if (!dealer) throw badRequest('所选经销商不可用');
  if (input.ownerUserId) { const owner = await one<{ id: string }>(c.env.DB, 'SELECT id FROM users WHERE id = ? AND is_active = 1', input.ownerUserId); if (!owner) throw badRequest('所选负责人不可用'); }
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE stores SET dealer_id = ?, code = ?, name = ?, platform = ?, owner_user_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?').bind(input.dealerId, input.code, input.name, input.platform, input.ownerUserId, input.status, user.id, store.id),
    ...(input.ownerUserId ? [c.env.DB.prepare("INSERT INTO store_user_assignments (user_id, store_id, access_level, assigned_by) VALUES (?, ?, 'owner', ?) ON CONFLICT(user_id, store_id) DO UPDATE SET access_level = 'owner', status = 'active', assigned_by = excluded.assigned_by").bind(input.ownerUserId, store.id, user.id)] : []),
    dbAudit(c.env.DB, { actorId: user.id, action: 'store.update', entityType: 'store', entityId: store.id, requestId: c.get('requestId'), before: { ownerUserId: store.ownerUserId }, after: input })
  ]);
  return c.json({ id: store.id });
});

app.patch('/admin/users/:id', requireAuth, async (c) => {
  const user = c.get('user'); assertPermission(user, 'user:manage'); const input = await parseBody(c.req.raw, updateUserSchema); const targetId = c.req.param('id');
  const [target, requestedRoles, superAdminCount] = await Promise.all([
    one<{ id: string }>(c.env.DB, 'SELECT id FROM users WHERE id = ?', targetId),
    all<{ id: string; code: string }>(c.env.DB, `SELECT id, code FROM roles WHERE is_active = 1 AND id IN (${placeholders(input.roleIds)})`, ...input.roleIds),
    one<{ count: number }>(c.env.DB, `SELECT COUNT(*) AS count FROM users JOIN user_roles ON user_roles.user_id = users.id JOIN roles ON roles.id = user_roles.role_id WHERE users.is_active = 1 AND roles.code = 'super_admin'`)
  ]);
  if (!target || requestedRoles.length !== new Set(input.roleIds).size) throw badRequest('角色包含不可用的记录');
  const dealerIds = input.dealerIds ?? [];
  const serviceCenterIds = input.serviceCenterIds ?? [];
  const storeIds = input.storeIds ?? [];
  const [dealerCount, centerCount, storeCount] = await Promise.all([
    input.dealerIds !== undefined && dealerIds.length ? one<{ count: number }>(c.env.DB, `SELECT COUNT(*) AS count FROM dealers WHERE status = 'active' AND id IN (${placeholders(dealerIds)})`, ...dealerIds) : Promise.resolve({ count: 0 }),
    input.serviceCenterIds !== undefined && serviceCenterIds.length ? one<{ count: number }>(c.env.DB, `SELECT COUNT(*) AS count FROM service_centers WHERE status = 'active' AND id IN (${placeholders(serviceCenterIds)})`, ...serviceCenterIds) : Promise.resolve({ count: 0 }),
    input.storeIds !== undefined && storeIds.length ? one<{ count: number }>(c.env.DB, `SELECT COUNT(*) AS count FROM stores WHERE status = 'active' AND id IN (${placeholders(storeIds)})`, ...storeIds) : Promise.resolve({ count: 0 })
  ]);
  if (input.dealerIds !== undefined && dealerCount?.count !== new Set(dealerIds).size) throw badRequest('经销商授权包含不可用的记录');
  if (input.serviceCenterIds !== undefined && centerCount?.count !== new Set(serviceCenterIds).size) throw badRequest('服务中心授权包含不可用的记录');
  if (input.storeIds !== undefined && storeCount?.count !== new Set(storeIds).size) throw badRequest('店铺授权包含不可用的记录');
  if (requestedRoles.some((role) => role.code === 'dealer') && input.dealerIds !== undefined && !dealerIds.length) throw badRequest('经销商角色必须同时记录经销商资格');
  if (requestedRoles.some((role) => role.code === 'authorized_service_center') && input.serviceCenterIds !== undefined && !serviceCenterIds.length) throw badRequest('授权服务中心角色必须同时记录服务中心资格');
  const keepsSuperAdmin = requestedRoles.some((role) => role.code === 'super_admin') && input.isActive;
  const currentlySuperAdmin = await one<{ id: string }>(c.env.DB, `SELECT users.id FROM users JOIN user_roles ON user_roles.user_id = users.id JOIN roles ON roles.id = user_roles.role_id WHERE users.id = ? AND roles.code = 'super_admin'`, targetId);
  if (currentlySuperAdmin && !keepsSuperAdmin && (superAdminCount?.count ?? 0) <= 1) throw conflict('至少需要保留一名启用的管理员');
  const scopeStatements: D1PreparedStatement[] = [];
  if (input.dealerIds !== undefined) scopeStatements.push(c.env.DB.prepare('DELETE FROM dealer_user_assignments WHERE user_id = ?').bind(targetId), ...Array.from(new Set(dealerIds)).map((dealerId) => c.env.DB.prepare('INSERT INTO dealer_user_assignments (user_id, dealer_id, assigned_by) VALUES (?, ?, ?)').bind(targetId, dealerId, user.id)));
  if (input.serviceCenterIds !== undefined) scopeStatements.push(c.env.DB.prepare('DELETE FROM service_center_user_assignments WHERE user_id = ?').bind(targetId), ...Array.from(new Set(serviceCenterIds)).map((centerId) => c.env.DB.prepare('INSERT INTO service_center_user_assignments (user_id, service_center_id, assigned_by) VALUES (?, ?, ?)').bind(targetId, centerId, user.id)));
  if (input.storeIds !== undefined) scopeStatements.push(c.env.DB.prepare('DELETE FROM store_user_assignments WHERE user_id = ?').bind(targetId), ...Array.from(new Set(storeIds)).map((storeId) => c.env.DB.prepare('INSERT INTO store_user_assignments (user_id, store_id, assigned_by) VALUES (?, ?, ?)').bind(targetId, storeId, user.id)));
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM user_roles WHERE user_id = ?').bind(targetId),
    c.env.DB.prepare('UPDATE users SET name = ?, is_active = ?, session_version = session_version + 1, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?').bind(input.name, Number(input.isActive), user.id, targetId),
    ...input.roleIds.map((roleId) => c.env.DB.prepare('INSERT INTO user_roles (user_id, role_id, assigned_by) VALUES (?, ?, ?)').bind(targetId, roleId, user.id)),
    ...scopeStatements,
    dbAudit(c.env.DB, { actorId: user.id, action: 'user.update', entityType: 'user', entityId: targetId, requestId: c.get('requestId') })
  ]);
  return c.json({ id: targetId });
});

app.patch('/admin/users/:id/watermark', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'user:manage');
  const input = await parseBody(c.req.raw, updateWatermarkPreferenceSchema);
  const targetId = c.req.param('id');
  const before = await one<{ id: string; watermarkEnabled: number }>(c.env.DB,
    'SELECT id, watermark_enabled AS watermarkEnabled FROM users WHERE id = ?', targetId);
  if (!before) throw notFound('未找到该用户');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET watermark_enabled = ?, session_version = session_version + 1, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?')
      .bind(Number(input.enabled), user.id, targetId),
    dbAudit(c.env.DB, {
      actorId: user.id,
      action: 'user.watermark.update',
      entityType: 'user',
      entityId: targetId,
      requestId: c.get('requestId'),
      before: { enabled: Boolean(before.watermarkEnabled) },
      after: input
    })
  ]);
  return c.json({ id: targetId, watermarkEnabled: input.enabled });
});

app.post('/admin/users/:id/reset-password', requireAuth, async (c) => {
  const user = c.get('user'); assertPermission(user, 'user:manage'); const input = await parseBody(c.req.raw, passwordResetSchema); const passwordHash = await hashPassword(input.nextPassword);
  await c.env.DB.batch([c.env.DB.prepare('UPDATE users SET password_hash = ?, password_changed_at = CURRENT_TIMESTAMP, session_version = session_version + 1, updated_by = ? WHERE id = ?').bind(passwordHash, user.id, c.req.param('id')), dbAudit(c.env.DB, { actorId: user.id, action: 'user.reset_password', entityType: 'user', entityId: c.req.param('id'), requestId: c.get('requestId') })]);
  return c.json({ id: c.req.param('id') });
});

app.post('/admin/users/:id/revoke-sessions', requireAuth, async (c) => { const user = c.get('user'); assertPermission(user, 'user:manage'); await c.env.DB.prepare('UPDATE users SET session_version = session_version + 1, updated_by = ? WHERE id = ?').bind(user.id, c.req.param('id')).run(); return c.json({ id: c.req.param('id'), revoked: true }); });
app.post('/auth/change-password', requireAuth, async (c) => { const user = c.get('user'); const input = await parseBody(c.req.raw, passwordChangeSchema); const account = await one<{ passwordHash: string }>(c.env.DB, 'SELECT password_hash AS passwordHash FROM users WHERE id = ?', user.id); if (!account || !(await verifyPassword(input.currentPassword, account.passwordHash))) throw badRequest('当前密码不正确'); const passwordHash = await hashPassword(input.nextPassword); await c.env.DB.prepare('UPDATE users SET password_hash = ?, password_changed_at = CURRENT_TIMESTAMP, session_version = session_version + 1, updated_by = ? WHERE id = ?').bind(passwordHash, user.id, user.id).run(); return c.json({ changed: true }); });

export default app;
