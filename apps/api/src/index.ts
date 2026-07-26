import { Hono, type Context } from 'hono';
import { ZodError, z } from 'zod';
import {
  AppError, adjustInventorySchema, afterSalesAssessmentSchema, afterSalesRecommendationSchema, assignAfterSalesSchema, badRequest, can, canAccessStore, canReadOrder, canTransitionOrder, conflict, createAfterSalesSchema,
  createDealerSchema, createOrderSchema, createProductSchema, createStoreSchema, createUserSchema, forbidden, loginSchema, notFound, passwordChangeSchema, passwordResetSchema, reviewOrderSchema, scanSerialSchema, shipmentSchema, updateAfterSalesSchema, updateOrderSchema, updateProductSchema, updateUserSchema,
  type ApiErrorBody, type OrderStatus, type SessionUser
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
  const store = await one<{ id: string; dealerId: string }>(c.env.DB, 'SELECT id, dealer_id AS dealerId FROM stores WHERE id = ? AND status = \'active\'', input.storeId);
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
  const serviceCase = await one<{ id: string; caseNo: string; dealerId: string; storeId: string | null; storeName: string | null; orderId: string | null; productId: string | null; productName: string | null; serialNumber: string | null; caseType: string; subject: string; description: string; contactName: string | null; contactPhone: string | null; status: string; createdAt: string; updatedAt: string }>(c.env.DB,
    `SELECT after_sales_cases.id, case_no AS caseNo, dealer_id AS dealerId, store_id AS storeId, stores.name AS storeName, order_id AS orderId, product_id AS productId, products.name AS productName, serial_number AS serialNumber, case_type AS caseType, subject, description, contact_name AS contactName, contact_phone AS contactPhone, after_sales_cases.status, after_sales_cases.workflow_stage AS workflowStage, asa.service_center_id AS serviceCenterId, after_sales_cases.created_at AS createdAt, after_sales_cases.updated_at AS updatedAt
     FROM after_sales_cases LEFT JOIN stores ON stores.id = after_sales_cases.store_id LEFT JOIN products ON products.id = after_sales_cases.product_id LEFT JOIN after_sales_assignments AS asa ON asa.case_id = after_sales_cases.id WHERE after_sales_cases.id = ?`, c.req.param('id'));
  if (!serviceCase) throw notFound('未找到该售后工单');
  const scope = afterSalesScope(user);
  const allowed = await one<{ id: string }>(c.env.DB, `SELECT id FROM after_sales_cases WHERE id = ? AND ${scope.sql}`, serviceCase.id, ...scope.params);
  if (!allowed) throw forbidden('你无权查看该售后工单');
  const [assessments, recommendations, approvals] = await Promise.all([
    all(c.env.DB, 'SELECT result, details, assessed_at AS assessedAt FROM after_sales_assessments WHERE case_id = ? ORDER BY assessed_at DESC', serviceCase.id),
    all(c.env.DB, 'SELECT recommendation, details, recommended_at AS recommendedAt FROM after_sales_recommendations WHERE case_id = ? ORDER BY recommended_at DESC', serviceCase.id),
    all(c.env.DB, 'SELECT outcome, note, approved_at AS approvedAt FROM after_sales_approvals WHERE case_id = ? ORDER BY approved_at DESC', serviceCase.id)
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
    c.env.DB.prepare('INSERT INTO after_sales_approvals (id, case_id, outcome, note, approved_by) VALUES (?, ?, ?, ?, ?)').bind(id(), serviceCase.id, input.outcome, input.note ?? '', user.id),
    c.env.DB.prepare(`UPDATE after_sales_cases SET status = ?, workflow_stage = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?`).bind(input.outcome === 'approved' ? 'resolved' : 'closed', input.outcome, user.id, serviceCase.id),
    c.env.DB.prepare('INSERT INTO notifications (id, dealer_id, store_id, type, title, body, link) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id(), serviceCase.dealerId, serviceCase.storeId, 'after_sales_approved', '售后工单最终处理结果', input.note ?? `处理结果：${input.outcome}`, `/system/after-sales/${serviceCase.id}`),
    dbAudit(c.env.DB, { actorId: user.id, action: 'after_sales.approve', entityType: 'after_sales_case', entityId: serviceCase.id, requestId: c.get('requestId'), after: { outcome: input.outcome } })
  ]);
  return c.json({ id: serviceCase.id, outcome: input.outcome });
});

app.post('/admin/products', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'inventory:manage');
  const input = await parseBody(c.req.raw, createProductSchema);
  const productId = id();
  const inventoryId = id();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO products (id, sku, name, description, unit_price_cents, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(productId, input.sku, input.name, input.description, input.unitPriceCents, user.id, user.id),
    c.env.DB.prepare('INSERT INTO inventory (id, product_id, created_by, updated_by) VALUES (?, ?, ?, ?)').bind(inventoryId, productId, user.id, user.id),
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
    c.env.DB.prepare('INSERT INTO dealers (id, code, name, province, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?)').bind(dealerId, input.code, input.name, input.province, user.id, user.id),
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

app.get('/admin/dealers', requireAuth, async (c) => {
  assertPermission(c.get('user'), 'dealer:manage');
  return c.json({ dealers: await all(c.env.DB, `SELECT dealers.id, dealers.code, dealers.name, dealers.province, dealers.status, COUNT(stores.id) AS storeCount FROM dealers LEFT JOIN stores ON stores.dealer_id = dealers.id GROUP BY dealers.id ORDER BY dealers.name`) });
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
  return c.json({ products: await all(c.env.DB, `SELECT products.id, sku, name, description, specification, unit_price_cents AS unitPriceCents, is_active AS isActive, inventory.id AS inventoryId, inventory.quantity AS availableQuantity, inventory.reserved_quantity AS reservedQuantity, inventory.reorder_level AS reorderLevel FROM products JOIN inventory ON inventory.product_id = products.id ORDER BY sku`) });
});

app.patch('/admin/products/:id', requireAuth, async (c) => {
  const user = c.get('user'); assertPermission(user, 'inventory:manage'); const input = await parseBody(c.req.raw, updateProductSchema);
  const product = await one<{ id: string }>(c.env.DB, 'SELECT id FROM products WHERE id = ?', c.req.param('id')); if (!product) throw notFound('未找到该产品');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE products SET sku = ?, name = ?, description = ?, specification = ?, unit_price_cents = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?').bind(input.sku, input.name, input.description, input.specification, input.unitPriceCents, Number(input.isActive), user.id, product.id),
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
  return c.json({ stores: await all(c.env.DB, `SELECT stores.id, stores.code, stores.name, stores.platform, stores.status, dealers.name AS dealerName, owner.name AS ownerName FROM stores JOIN dealers ON dealers.id = stores.dealer_id LEFT JOIN users AS owner ON owner.id = stores.owner_user_id ORDER BY stores.name`) });
});

app.patch('/admin/stores/:id', requireAuth, async (c) => {
  const user = c.get('user'); assertPermission(user, 'store:manage');
  const input = await parseBody(c.req.raw, z.object({ name: z.string().trim().min(2).max(160), platform: z.string().trim().min(2).max(64), ownerUserId: z.string().uuid().nullable(), status: z.enum(['active', 'inactive']) }));
  await c.env.DB.prepare('UPDATE stores SET name = ?, platform = ?, owner_user_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?').bind(input.name, input.platform, input.ownerUserId, input.status, user.id, c.req.param('id')).run();
  return c.json({ id: c.req.param('id') });
});

app.patch('/admin/users/:id', requireAuth, async (c) => {
  const user = c.get('user'); assertPermission(user, 'user:manage'); const input = await parseBody(c.req.raw, updateUserSchema); const targetId = c.req.param('id');
  const dealerIds = input.dealerIds ?? []; const serviceCenterIds = input.serviceCenterIds ?? []; const storeIds = input.storeIds ?? [];
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
