import { Hono, type Context } from 'hono';
import { ZodError, z } from 'zod';
import {
  AppError, adjustInventorySchema, afterSalesAssessmentSchema, afterSalesRecommendationSchema, assignAfterSalesSchema, badRequest, can, canAccessStore, canReadOrder, canTransitionOrder, confirmHistoricalWarrantyImportSchema, conflict, createAfterSalesSchema, createAssetAfterSalesSchema,
  createDealerSchema, createOrderSchema, createProductSchema, createStoreSchema, createUserSchema, forbidden, loginSchema, notFound, passwordChangeSchema, passwordResetSchema, reviewOrderSchema, scanSerialSchema, shipmentSchema, updateAfterSalesSchema, updateDealerSchema, updateOrderSchema, updateProductSchema, updateStoreSchema, updateUserSchema,
  historicalWarrantyPrecheckSchema, HISTORICAL_WARRANTY_COLUMNS, normalizeHistoricalWarrantyRecords, updateAssetWarrantySchema, warrantyDisplayStatus, type ApiErrorBody, type NormalizedWarrantyRecord, type OrderStatus, type SessionUser
} from '@maxcine/shared';
import { all, caseNo, id, one, orderNo } from './db';
import { createSessionToken, hashIdentifier, hashPassword, loadSessionUser, requireAuth, verifyPassword } from './auth';
import type { Env, Variables } from './types';

type App = { Bindings: Env; Variables: Variables };
type OrderRow = { id: string; orderNo: string; dealerId: string; storeId: string; status: OrderStatus; totalCents: number; note: string; createdAt: string; updatedAt: string; submittedAt: string | null; reviewedAt: string | null };
type OrderItemRow = { id: string; productId: string; name: string; sku: string; quantity: number; unitPriceCents: number };
type DbUser = { id: string; email: string; passwordHash: string; name: string; isActive: number };

const app = new Hono<App>();
const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

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

function assertAssetReadAccess(user: SessionUser): void {
  if (!hasGlobalAssetAccess(user) && !can(user, 'asset:read') && !can(user, 'asset:warehouse-read')) throw forbidden();
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
    created_at AS createdAt, updated_at AS updatedAt, submitted_at AS submittedAt, reviewed_at AS reviewedAt FROM orders WHERE id = ?`, orderId);
  if (!order) throw notFound('未找到该订单');
  return order;
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

function afterSalesScope(user: SessionUser): { sql: string; params: string[] } {
  if (can(user, 'data:read:all')) return { sql: '1 = 1', params: [] };
  const clauses: string[] = [];
  const params: string[] = [];
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

function assetScope(user: SessionUser, alias = 'assets'): { sql: string; params: string[] } {
  if (hasGlobalAssetAccess(user)) return { sql: '1 = 1', params: [] };
  const clauses: string[] = [];
  const params: string[] = [];
  if (can(user, 'asset:read') && user.storeIds.length) {
    clauses.push(`${alias}.store_id IN (${placeholders(user.storeIds)})`);
    params.push(...user.storeIds);
  }
  if (can(user, 'asset:read') && user.dealerIds.length) {
    clauses.push(`${alias}.dealer_id IN (${placeholders(user.dealerIds)})`);
    params.push(...user.dealerIds);
  }
  if (can(user, 'asset:read') && user.serviceCenterIds.length) {
    clauses.push(`EXISTS (SELECT 1 FROM after_sales_cases ascases JOIN after_sales_assignments asa ON asa.case_id = ascases.id WHERE ascases.asset_id = ${alias}.id AND asa.service_center_id IN (${placeholders(user.serviceCenterIds)}))`);
    params.push(...user.serviceCenterIds);
  }
  if (can(user, 'asset:warehouse-read')) {
    clauses.push(`EXISTS (SELECT 1 FROM orders asset_orders WHERE asset_orders.id = ${alias}.latest_order_id AND asset_orders.status IN ('approved','picking','packed','shipped','delivered'))`);
  }
  if (!clauses.length) throw forbidden('当前账户没有授权的资产数据范围');
  return { sql: `(${clauses.join(' OR ')})`, params };
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

app.use('*', async (c, next) => {
  const requestId = c.req.header('X-Request-ID') ?? crypto.randomUUID();
  c.set('requestId', requestId);
  c.header('X-Request-ID', requestId);
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  const origin = c.req.header('Origin');
  if (origin && origin === c.env.APP_ORIGIN) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Access-Control-Allow-Credentials', 'true');
    c.header('Vary', 'Origin');
  }
  if (c.req.method === 'OPTIONS') return c.body(null, 204, { 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Authorization,Content-Type,X-Request-ID' });
  if (unsafeMethods.has(c.req.method) && origin && origin !== c.env.APP_ORIGIN) throw forbidden('当前请求来源无权限提交数据');
  await next();
});

app.onError((error, c) => {
  if (error instanceof AppError) return errorResponse(c, error);
  if (error instanceof ZodError) return errorResponse(c, badRequest('请检查填写内容', zodDetails(error)));
  console.error(JSON.stringify({ requestId: c.get('requestId'), error: error instanceof Error ? error.message : 'Unknown error' }));
  return errorResponse(c, new AppError(500, 'INTERNAL_ERROR', '系统繁忙，请稍后再试'));
});

app.get('/health', (c) => c.json({ ok: true, service: 'maxcine-api', requestId: c.get('requestId') }));

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
  c.header('Set-Cookie', `mc_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${isSecure ? '; Secure' : ''}`);
  return c.json({ user: sessionUser });
});

app.post('/auth/logout', requireAuth, (c) => {
  c.header('Set-Cookie', 'mc_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
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
  assertPermission(c.get('user'), 'inventory:read');
  const search = new URL(c.req.url).searchParams.get('search')?.trim() ?? '';
  const items = await all<{ id: string; productId: string; sku: string; name: string; description: string; specification: string; unitPriceCents: number; availableQuantity: number; reservedQuantity: number; reorderLevel: number; updatedAt: string }>(c.env.DB,
    `SELECT inventory.id, products.id AS productId, products.sku, products.name, products.description, products.specification,
      products.unit_price_cents AS unitPriceCents, inventory.quantity AS availableQuantity, inventory.reserved_quantity AS reservedQuantity, inventory.reorder_level AS reorderLevel,
      inventory.updated_at AS updatedAt
     FROM inventory JOIN products ON products.id = inventory.product_id
     WHERE products.is_active = 1 AND (? = '' OR products.name LIKE '%' || ? || '%' OR products.sku LIKE '%' || ? || '%')
     ORDER BY products.sku`, search, search, search);
  return c.json({ items });
});

app.get('/inventory/:id', requireAuth, async (c) => {
  assertPermission(c.get('user'), 'inventory:read');
  const item = await one<{ id: string; productId: string; sku: string; name: string; description: string; specification: string; unitPriceCents: number; availableQuantity: number; reservedQuantity: number; reorderLevel: number; updatedAt: string }>(c.env.DB,
    `SELECT inventory.id, products.id AS productId, products.sku, products.name, products.description, products.specification,
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
    c.env.DB.prepare(`INSERT INTO orders (id, order_no, dealer_id, store_id, note, total_cents, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(orderId, orderNo(), store.dealerId, input.storeId, input.note, total, user.id, user.id),
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
  if (order.status !== 'draft' || !canAccessStore(user, order.storeId)) throw conflict('只有授权范围内的草稿订单可以编辑');
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
    c.env.DB.prepare(`UPDATE orders SET store_id = ?, note = ?, total_cents = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ? AND status = 'draft'`)
      .bind(input.storeId, input.note, total, user.id, order.id),
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
  if (status && ['draft', 'submitted', 'approved', 'rejected', 'picking', 'packed', 'shipped', 'delivered', 'cancelled'].includes(status)) { where.push('orders.status = ?'); params.push(status); }
  if (search) { where.push('orders.order_no LIKE ?'); params.push(`%${search}%`); }
  if (storeId) {
    if (!canAccessStore(user, storeId) && !can(user, 'order:warehouse-read')) throw forbidden('该店铺不在你的授权范围内');
    where.push('orders.store_id = ?'); params.push(storeId);
  }
  if (from) { where.push('orders.created_at >= ?'); params.push(`${from} 00:00:00`); }
  if (to) { where.push('orders.created_at <= ?'); params.push(`${to} 23:59:59`); }
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const count = await one<{ count: number }>(c.env.DB, `SELECT COUNT(*) AS count FROM orders${clause}`, ...params);
  const orders = await all<OrderRow & { storeName: string; itemCount: number }>(c.env.DB,
    `SELECT orders.id, orders.order_no AS orderNo, orders.dealer_id AS dealerId, orders.store_id AS storeId, orders.status, orders.total_cents AS totalCents, orders.note,
      orders.created_at AS createdAt, orders.updated_at AS updatedAt, orders.submitted_at AS submittedAt, orders.reviewed_at AS reviewedAt, stores.name AS storeName,
      COALESCE((SELECT SUM(quantity) FROM order_items WHERE order_id = orders.id), 0) AS itemCount
     FROM orders JOIN stores ON stores.id = orders.store_id${clause} ORDER BY orders.created_at DESC LIMIT ? OFFSET ?`, ...params, limit, (page - 1) * limit);
  return c.json({ orders, pagination: { page, limit, total: count?.count ?? 0, totalPages: Math.max(1, Math.ceil((count?.count ?? 0) / limit)) } });
});

app.get('/orders/:id', requireAuth, async (c) => {
  const user = c.get('user');
  const order = await getOrder(c.env.DB, c.req.param('id'));
  assertOrderAccess(user, order);
  const [items, shipment, overview] = await Promise.all([
    all<OrderItemRow>(c.env.DB, `SELECT id, product_id AS productId, product_name_snapshot AS name, sku_snapshot AS sku, quantity, unit_price_cents AS unitPriceCents FROM order_items WHERE order_id = ?`, order.id),
    one<{ id: string; trackingNumber: string; carrier: string; status: string; shippedAt: string }>(c.env.DB, `SELECT id, tracking_number AS trackingNumber, carrier, status, shipped_at AS shippedAt FROM shipments WHERE order_id = ?`, order.id),
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
  return c.json({ order: { ...order, ...overview }, items, serials, shipment, timeline });
});

app.post('/orders/:id/submit', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'order:submit');
  const order = await getOrder(c.env.DB, c.req.param('id'));
  assertOrderAccess(user, order);
  const dealer = await one<{ id: string }>(c.env.DB, "SELECT id FROM dealers WHERE id = ? AND status = 'active'", order.dealerId);
  if (!dealer) throw forbidden('所属经销商已停用，无法提交订单');
  if (!canTransitionOrder(user, order.status, 'submitted') || !canAccessStore(user, order.storeId)) throw conflict('该订单暂时不能提交审核');
  const unavailable = await one<{ count: number }>(c.env.DB, `SELECT COUNT(*) AS count FROM order_items
    JOIN inventory ON inventory.product_id = order_items.product_id WHERE order_items.order_id = ? AND order_items.quantity > inventory.quantity`, order.id);
  if ((unavailable?.count ?? 0) > 0) throw conflict('订单中有产品库存不足，请修改后再提交');
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE orders SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ? AND status = 'draft'`).bind(user.id, order.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'order.submit', entityType: 'order', entityId: order.id, requestId: c.get('requestId'), before: { status: 'draft' }, after: { status: 'submitted' } })
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
  assertPermission(user, 'order:fulfill');
  const input = await parseBody(c.req.raw, shipmentSchema);
  const order = await getOrder(c.env.DB, c.req.param('id'));
  assertOrderAccess(user, order);
  if (!canTransitionOrder(user, order.status, 'shipped')) throw conflict('该订单暂时不能发货');
  const shipmentId = id();
  const existingTracking = await one<{ id: string }>(c.env.DB, 'SELECT id FROM shipments WHERE tracking_number = ?', input.trackingNumber);
  if (existingTracking) throw conflict('该运单号已被使用');
  const items = await all<{ productId: string; quantity: number; inventoryId: string }>(c.env.DB, `SELECT order_items.product_id AS productId, order_items.quantity, inventory.id AS inventoryId FROM order_items JOIN inventory ON inventory.product_id = order_items.product_id WHERE order_items.order_id = ?`, order.id);
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO shipments (id, order_id, carrier, tracking_number, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(shipmentId, order.id, input.carrier, input.trackingNumber, user.id, user.id),
    c.env.DB.prepare(`UPDATE serial_numbers SET state = 'shipped', shipment_id = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ?
      WHERE state = 'allocated' AND order_item_id IN (SELECT id FROM order_items WHERE order_id = ?)`)
      .bind(shipmentId, user.id, order.id),
    c.env.DB.prepare(`UPDATE orders SET status = 'shipped', updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ? AND status = 'packed'`).bind(user.id, order.id),
    ...items.map((item) => c.env.DB.prepare(`INSERT INTO inventory_transactions (id, inventory_id, product_id, order_id, transaction_type, quantity_delta, reserved_delta, note, created_by) VALUES (?, ?, ?, ?, 'order_shipped', 0, ?, ?, ?)`).bind(id(), item.inventoryId, item.productId, order.id, -item.quantity, `订单 ${order.orderNo} 已发货，预留库存正式出库`, user.id)),
    c.env.DB.prepare('INSERT INTO notifications (id, dealer_id, store_id, type, title, body, link) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id(), order.dealerId, order.storeId, 'order_shipped', '订单已发货', `${input.carrier}运单号：${input.trackingNumber}`, `/system/orders/${order.id}`),
    dbAudit(c.env.DB, { actorId: user.id, action: 'warehouse.ship', entityType: 'order', entityId: order.id, requestId: c.get('requestId'), before: { status: 'packed' }, after: { status: 'shipped', trackingNumber: input.trackingNumber } })
  ]);
  return c.json({ id: order.id, status: 'shipped', trackingNumber: input.trackingNumber });
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

app.post('/after-sales', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'after-sales:create');
  const input = await parseBody(c.req.raw, createAfterSalesSchema);
  assertStoreAccess(user, input.storeId);
  const store = await one<{ id: string; dealerId: string }>(c.env.DB, 'SELECT id, dealer_id AS dealerId FROM stores WHERE id = ? AND status = \'active\'', input.storeId);
  if (!store) throw forbidden('该店铺不可用');
  if (input.orderId) {
    const order = await getOrder(c.env.DB, input.orderId);
    assertOrderAccess(user, order);
    if (order.storeId !== input.storeId) throw badRequest('关联订单必须属于所选店铺');
    if (input.productId) {
      const item = await one<{ id: string }>(c.env.DB, 'SELECT id FROM order_items WHERE order_id = ? AND product_id = ?', order.id, input.productId);
      if (!item) throw badRequest('所选产品不在关联订单中');
    }
  }
  const caseId = id();
  const reference = caseNo();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO after_sales_cases (id, case_no, dealer_id, store_id, order_id, product_id, serial_number, case_type, subject, description, contact_name, contact_phone, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(caseId, reference, store.dealerId, input.storeId, input.orderId ?? null, input.productId ?? null, input.serialNumber ?? null, input.caseType, input.subject, input.description, input.contactName, input.contactPhone, user.id, user.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'after_sales.create', entityType: 'after_sales_case', entityId: caseId, requestId: c.get('requestId') })
  ]);
  return c.json({ id: caseId, caseNo: reference, status: 'open' }, 201);
});

app.get('/after-sales', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'after-sales:read');
  const page = pageValue(new URL(c.req.url).searchParams.get('page') ?? undefined);
  const limit = limitValue(new URL(c.req.url).searchParams.get('limit') ?? undefined);
  const scope = afterSalesScope(user);
  const cases = await all(c.env.DB, `SELECT after_sales_cases.id, case_no AS caseNo, dealer_id AS dealerId, order_id AS orderId, products.name AS productName, serial_number AS serialNumber, case_type AS caseType, subject, status, workflow_stage AS workflowStage, after_sales_cases.created_at AS createdAt, after_sales_cases.updated_at AS updatedAt
    FROM after_sales_cases LEFT JOIN products ON products.id = after_sales_cases.product_id WHERE ${scope.sql}
    ORDER BY after_sales_cases.created_at DESC LIMIT ? OFFSET ?`, ...scope.params, limit, (page - 1) * limit);
  return c.json({ cases });
});

app.get('/after-sales/:id', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'after-sales:read');
  const serviceCase = await one<{ id: string; caseNo: string; dealerId: string; dealerName: string; storeId: string | null; storeName: string | null; orderId: string | null; productId: string | null; productName: string | null; serialNumber: string | null; caseType: string; subject: string; description: string; contactName: string | null; contactPhone: string | null; status: string; workflowStage: string; serviceCenterId: string | null; serviceCenterName: string | null; assignedAt: string | null; createdAt: string; updatedAt: string }>(c.env.DB,
    `SELECT after_sales_cases.id, case_no AS caseNo, after_sales_cases.dealer_id AS dealerId, dealers.name AS dealerName, store_id AS storeId, stores.name AS storeName, order_id AS orderId, product_id AS productId, products.name AS productName, serial_number AS serialNumber, case_type AS caseType, subject, description, contact_name AS contactName, contact_phone AS contactPhone, after_sales_cases.status, after_sales_cases.workflow_stage AS workflowStage, asa.service_center_id AS serviceCenterId, service_centers.name AS serviceCenterName, asa.assigned_at AS assignedAt, after_sales_cases.created_at AS createdAt, after_sales_cases.updated_at AS updatedAt
     FROM after_sales_cases JOIN dealers ON dealers.id = after_sales_cases.dealer_id LEFT JOIN stores ON stores.id = after_sales_cases.store_id LEFT JOIN products ON products.id = after_sales_cases.product_id LEFT JOIN after_sales_assignments AS asa ON asa.case_id = after_sales_cases.id LEFT JOIN service_centers ON service_centers.id = asa.service_center_id WHERE after_sales_cases.id = ?`, c.req.param('id'));
  if (!serviceCase) throw notFound('未找到该售后工单');
  const scope = afterSalesScope(user);
  const allowed = await one<{ id: string }>(c.env.DB, `SELECT id FROM after_sales_cases WHERE id = ? AND ${scope.sql}`, serviceCase.id, ...scope.params);
  if (!allowed) throw forbidden('你无权查看该售后工单');
  const [assessments, recommendations, approvals] = await Promise.all([
    all(c.env.DB, 'SELECT result, details, assessed_at AS assessedAt, users.name AS actorName FROM after_sales_assessments JOIN users ON users.id = after_sales_assessments.assessed_by WHERE case_id = ? ORDER BY assessed_at DESC', serviceCase.id),
    all(c.env.DB, 'SELECT recommendation, details, recommended_at AS recommendedAt, users.name AS actorName FROM after_sales_recommendations JOIN users ON users.id = after_sales_recommendations.recommended_by WHERE case_id = ? ORDER BY recommended_at DESC', serviceCase.id),
    all(c.env.DB, 'SELECT outcome, resolution, note, approved_at AS approvedAt, users.name AS actorName FROM after_sales_approvals JOIN users ON users.id = after_sales_approvals.approved_by WHERE case_id = ? ORDER BY approved_at DESC', serviceCase.id)
  ]);
  return c.json({ case: serviceCase, assessments, recommendations, approvals });
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
  const query = (c.req.query('q') ?? '').trim();
  if (query.length < 2) throw badRequest('请输入至少两个字符进行查询');
  const scope = assetScope(user);
  const like = `%${query.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
  const items = await all<{ id: string; currentSn: string | null; originalSn: string | null; productName: string; version: string; sourceChannel: string; warrantyEndAt: string | null; warrantyStartAt: string | null; warrantyOverrideStatus: string | null; assetStatus: string; dataQualityStatus: string }>(c.env.DB,
    `SELECT DISTINCT assets.id, assets.current_sn AS currentSn, assets.original_sn AS originalSn, assets.product_name_snapshot AS productName, assets.version_snapshot AS version,
      assets.source_channel AS sourceChannel, assets.warranty_end_at AS warrantyEndAt, assets.warranty_start_at AS warrantyStartAt, assets.warranty_override_status AS warrantyOverrideStatus, assets.asset_status AS assetStatus, assets.data_quality_status AS dataQualityStatus
     FROM assets LEFT JOIN asset_identifiers ON asset_identifiers.asset_id = assets.id LEFT JOIN asset_sales ON asset_sales.id IN (SELECT sale_id FROM asset_sale_assets WHERE asset_id = assets.id)
     LEFT JOIN orders ON orders.id = assets.latest_order_id LEFT JOIN after_sales_cases ON after_sales_cases.asset_id = assets.id
     WHERE ${scope.sql} AND (assets.current_sn LIKE ? ESCAPE '\\' OR assets.original_sn LIKE ? ESCAPE '\\' OR asset_identifiers.identifier_value LIKE ? ESCAPE '\\' OR asset_sales.tracking_number LIKE ? ESCAPE '\\' OR orders.order_no LIKE ? ESCAPE '\\' OR after_sales_cases.case_no LIKE ? ESCAPE '\\')
     ORDER BY assets.updated_at DESC LIMIT 50`, ...scope.params, like, like, like, like, like, like);
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
  const today = new Date().toISOString().slice(0, 10);
  if (search) { const like = `%${search.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`; filters.push(`(assets.current_sn LIKE ? ESCAPE '\\' OR assets.original_sn LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM asset_identifiers WHERE asset_id = assets.id AND identifier_value LIKE ? ESCAPE '\\'))`); params.push(like, like, like); }
  if (version) { filters.push('assets.version_snapshot = ?'); params.push(version); }
  if (assetStatus) { filters.push('assets.asset_status = ?'); params.push(assetStatus); }
  if (channel) { filters.push('assets.source_channel = ?'); params.push(channel); }
  if (warehouse) { filters.push('assets.shipping_warehouse = ?'); params.push(warehouse); }
  if (quality === 'exception') filters.push(`(assets.data_quality_status <> 'normal' OR assets.warranty_override_status IN ('exception','denied','cancelled','scrapped'))`);
  else if (quality) { filters.push('assets.data_quality_status = ?'); params.push(quality); }
  if (warrantyStatus === '在保') { filters.push(`assets.warranty_override_status IS NULL AND assets.warranty_start_at IS NOT NULL AND assets.warranty_end_at IS NOT NULL AND assets.warranty_start_at <= ? AND assets.warranty_end_at >= ?`); params.push(today, today); }
  if (warrantyStatus === '已过保') { filters.push(`assets.warranty_override_status IS NULL AND assets.warranty_end_at IS NOT NULL AND assets.warranty_end_at < ?`); params.push(today); }
  if (warrantyStatus === '无有效日期') filters.push(`assets.warranty_override_status IS NULL AND (assets.warranty_start_at IS NULL OR assets.warranty_end_at IS NULL)`);
  const overrideMap: Record<string, string> = { '无保修': 'no_warranty', '拒保': 'denied', '异常': 'exception', '注销': 'cancelled', '报废': 'scrapped' };
  if (overrideMap[warrantyStatus]) { filters.push('assets.warranty_override_status = ?'); params.push(overrideMap[warrantyStatus]); }
  const where = filters.join(' AND ');
  const page = pageValue(c.req.query('page'));
  const limit = limitValue(c.req.query('limit'), 30);
  const [count, items, versions, channels, warehouses] = await Promise.all([
    one<{ count: number }>(c.env.DB, `SELECT COUNT(*) AS count FROM assets WHERE ${where}`, ...params),
    all<{ id: string; currentSn: string | null; productName: string; version: string; sourceChannel: string; shippingWarehouse: string; warrantyEndAt: string | null; warrantyStartAt: string | null; warrantyOverrideStatus: string | null; assetStatus: string; dataQualityStatus: string; latestEvent: string | null; updatedAt: string }>(c.env.DB,
      `SELECT assets.id, assets.current_sn AS currentSn, assets.product_name_snapshot AS productName, assets.version_snapshot AS version, assets.source_channel AS sourceChannel, assets.shipping_warehouse AS shippingWarehouse,
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
  const asset = await one<{ id: string; currentSn: string | null; originalSn: string | null; productId: string | null; productName: string; version: string; assetStatus: string; warrantyPolicy: string; warrantyStartAt: string | null; warrantyEndAt: string | null; warrantyOverrideStatus: string | null; warrantyOverrideReason: string; sourceChannel: string; shippingWarehouse: string; dealerName: string | null; storeName: string | null; latestOrderId: string | null; latestOrderNo: string | null; dataQualityStatus: string; createdAt: string; updatedAt: string }>(c.env.DB,
    `SELECT assets.id, assets.current_sn AS currentSn, assets.original_sn AS originalSn, assets.product_id AS productId, assets.product_name_snapshot AS productName, assets.version_snapshot AS version, assets.asset_status AS assetStatus, assets.warranty_policy AS warrantyPolicy,
      assets.warranty_start_at AS warrantyStartAt, assets.warranty_end_at AS warrantyEndAt, assets.warranty_override_status AS warrantyOverrideStatus, assets.warranty_override_reason AS warrantyOverrideReason,
      assets.source_channel AS sourceChannel, assets.shipping_warehouse AS shippingWarehouse, dealers.name AS dealerName, stores.name AS storeName, assets.latest_order_id AS latestOrderId, orders.order_no AS latestOrderNo,
      assets.data_quality_status AS dataQualityStatus, assets.created_at AS createdAt, assets.updated_at AS updatedAt
      FROM assets LEFT JOIN dealers ON dealers.id = assets.dealer_id LEFT JOIN stores ON stores.id = assets.store_id LEFT JOIN orders ON orders.id = assets.latest_order_id WHERE assets.id = ? AND ${scope.sql}`, c.req.param('id'), ...scope.params);
  if (!asset) {
    if (hasGlobalAssetAccess(user)) throw notFound('未找到该资产');
    throw forbidden('未找到该资产或你无权查看');
  }
  const visibility = eventVisibilityScope(user);
  const [identifiers, events, serviceCases, notes, sales, audit] = await Promise.all([
    all(c.env.DB, `SELECT identifier_type AS identifierType, identifier_value AS identifierValue, is_current AS isCurrent, valid_from AS validFrom, valid_to AS validTo, reason, source, created_at AS createdAt FROM asset_identifiers WHERE asset_id = ? ORDER BY is_current DESC, created_at DESC`, asset.id),
    all(c.env.DB, `SELECT asset_events.id, event_type AS eventType, occurred_at AS occurredAt, title, description, related_order_id AS relatedOrderId, related_service_case_id AS relatedServiceCaseId, users.name AS operatorName, visibility, source, asset_events.created_at AS createdAt FROM asset_events LEFT JOIN users ON users.id = asset_events.operator_user_id WHERE asset_id = ? AND ${visibility.sql} ORDER BY COALESCE(occurred_at, asset_events.created_at) DESC, asset_events.created_at DESC`, asset.id, ...visibility.params),
    all(c.env.DB, `SELECT id, case_no AS caseNo, status, workflow_stage AS workflowStage, subject, created_at AS createdAt, updated_at AS updatedAt FROM after_sales_cases WHERE asset_id = ? ORDER BY updated_at DESC`, asset.id),
    hasGlobalAssetAccess(user) ? all(c.env.DB, `SELECT category, content, visibility, source, created_at AS createdAt FROM asset_notes WHERE asset_id = ? AND visibility = 'admin_private' ORDER BY created_at DESC`, asset.id) : Promise.resolve([]),
    hasGlobalAssetAccess(user) ? all(c.env.DB, `SELECT source_channel AS sourceChannel, purchase_date AS purchaseDate, purchase_date_annotation AS purchaseDateAnnotation, purchase_price_raw AS purchasePriceRaw, unit_price_cents AS unitPriceCents, quantity, total_price_cents AS totalPriceCents, payment_status AS paymentStatus, payment_amount_cents AS paymentAmountCents, payment_raw AS paymentRaw, tracking_number AS trackingNumber, shipping_warehouse AS shippingWarehouse FROM asset_sales JOIN asset_sale_assets ON asset_sale_assets.sale_id = asset_sales.id WHERE asset_sale_assets.asset_id = ? ORDER BY purchase_date DESC`, asset.id) : all(c.env.DB, `SELECT source_channel AS sourceChannel, purchase_date AS purchaseDate, tracking_number AS trackingNumber, shipping_warehouse AS shippingWarehouse FROM asset_sales JOIN asset_sale_assets ON asset_sale_assets.sale_id = asset_sales.id WHERE asset_sale_assets.asset_id = ? ORDER BY purchase_date DESC`, asset.id),
    hasGlobalAssetAccess(user) ? all(c.env.DB, `SELECT audit_logs.action, audit_logs.created_at AS createdAt, users.name AS actorName FROM audit_logs LEFT JOIN users ON users.id = audit_logs.actor_id WHERE entity_type = 'asset' AND entity_id = ? ORDER BY audit_logs.created_at DESC LIMIT 100`, asset.id) : Promise.resolve([])
  ]);
  return c.json({ asset: { ...asset, warrantyStatus: warrantyDisplayStatus(asset), ...(hasGlobalAssetAccess(user) ? {} : { warrantyOverrideReason: '' }) }, identifiers, events, serviceCases, notes, sales, audit });
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
  return c.json({ users: await all(c.env.DB, `SELECT users.id, users.email, users.name, users.is_active AS isActive, users.created_at AS createdAt,
    COALESCE(GROUP_CONCAT(roles.code, ','), '') AS roles FROM users
    LEFT JOIN user_roles ON user_roles.user_id = users.id LEFT JOIN roles ON roles.id = user_roles.role_id
    GROUP BY users.id ORDER BY users.created_at DESC`) });
});

app.get('/admin/users/:id', requireAuth, async (c) => {
  assertPermission(c.get('user'), 'user:manage');
  const account = await one(c.env.DB, 'SELECT id, email, name, is_active AS isActive, created_at AS createdAt, updated_at AS updatedAt FROM users WHERE id = ?', c.req.param('id'));
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
  const dealerIds = input.dealerIds ?? []; const serviceCenterIds = input.serviceCenterIds ?? []; const storeIds = input.storeIds ?? [];
  const [target, requestedRoles, superAdminCount] = await Promise.all([
    one<{ id: string }>(c.env.DB, 'SELECT id FROM users WHERE id = ?', targetId),
    all<{ id: string; code: string }>(c.env.DB, `SELECT id, code FROM roles WHERE is_active = 1 AND id IN (${placeholders(input.roleIds)})`, ...input.roleIds),
    one<{ count: number }>(c.env.DB, `SELECT COUNT(*) AS count FROM users JOIN user_roles ON user_roles.user_id = users.id JOIN roles ON roles.id = user_roles.role_id WHERE users.is_active = 1 AND roles.code = 'super_admin'`)
  ]);
  if (!target || requestedRoles.length !== new Set(input.roleIds).size) throw badRequest('角色包含不可用的记录');
  const keepsSuperAdmin = requestedRoles.some((role) => role.code === 'super_admin') && input.isActive;
  const currentlySuperAdmin = await one<{ id: string }>(c.env.DB, `SELECT users.id FROM users JOIN user_roles ON user_roles.user_id = users.id JOIN roles ON roles.id = user_roles.role_id WHERE users.id = ? AND roles.code = 'super_admin'`, targetId);
  if (currentlySuperAdmin && !keepsSuperAdmin && (superAdminCount?.count ?? 0) <= 1) throw conflict('至少需要保留一名启用的超级管理员');
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM user_roles WHERE user_id = ?').bind(targetId), c.env.DB.prepare('DELETE FROM dealer_user_assignments WHERE user_id = ?').bind(targetId), c.env.DB.prepare('DELETE FROM service_center_user_assignments WHERE user_id = ?').bind(targetId), c.env.DB.prepare('DELETE FROM store_user_assignments WHERE user_id = ?').bind(targetId),
    c.env.DB.prepare('UPDATE users SET name = ?, is_active = ?, session_version = session_version + 1, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?').bind(input.name, Number(input.isActive), user.id, targetId),
    ...input.roleIds.map((roleId) => c.env.DB.prepare('INSERT INTO user_roles (user_id, role_id, assigned_by) VALUES (?, ?, ?)').bind(targetId, roleId, user.id)),
    ...dealerIds.map((dealerId) => c.env.DB.prepare('INSERT INTO dealer_user_assignments (user_id, dealer_id, assigned_by) VALUES (?, ?, ?)').bind(targetId, dealerId, user.id)),
    ...serviceCenterIds.map((centerId) => c.env.DB.prepare('INSERT INTO service_center_user_assignments (user_id, service_center_id, assigned_by) VALUES (?, ?, ?)').bind(targetId, centerId, user.id)),
    ...storeIds.map((storeId) => c.env.DB.prepare('INSERT INTO store_user_assignments (user_id, store_id, assigned_by) VALUES (?, ?, ?)').bind(targetId, storeId, user.id)),
    dbAudit(c.env.DB, { actorId: user.id, action: 'user.update', entityType: 'user', entityId: targetId, requestId: c.get('requestId') })
  ]);
  return c.json({ id: targetId });
});

app.post('/admin/users/:id/reset-password', requireAuth, async (c) => {
  const user = c.get('user'); assertPermission(user, 'user:manage'); const input = await parseBody(c.req.raw, passwordResetSchema); const passwordHash = await hashPassword(input.nextPassword);
  await c.env.DB.batch([c.env.DB.prepare('UPDATE users SET password_hash = ?, password_changed_at = CURRENT_TIMESTAMP, session_version = session_version + 1, updated_by = ? WHERE id = ?').bind(passwordHash, user.id, c.req.param('id')), dbAudit(c.env.DB, { actorId: user.id, action: 'user.reset_password', entityType: 'user', entityId: c.req.param('id'), requestId: c.get('requestId') })]);
  return c.json({ id: c.req.param('id') });
});

app.post('/admin/users/:id/revoke-sessions', requireAuth, async (c) => { const user = c.get('user'); assertPermission(user, 'user:manage'); await c.env.DB.prepare('UPDATE users SET session_version = session_version + 1, updated_by = ? WHERE id = ?').bind(user.id, c.req.param('id')).run(); return c.json({ id: c.req.param('id'), revoked: true }); });
app.post('/auth/change-password', requireAuth, async (c) => { const user = c.get('user'); const input = await parseBody(c.req.raw, passwordChangeSchema); const account = await one<{ passwordHash: string }>(c.env.DB, 'SELECT password_hash AS passwordHash FROM users WHERE id = ?', user.id); if (!account || !(await verifyPassword(input.currentPassword, account.passwordHash))) throw badRequest('当前密码不正确'); const passwordHash = await hashPassword(input.nextPassword); await c.env.DB.prepare('UPDATE users SET password_hash = ?, password_changed_at = CURRENT_TIMESTAMP, session_version = session_version + 1, updated_by = ? WHERE id = ?').bind(passwordHash, user.id, user.id).run(); return c.json({ changed: true }); });

export default app;
