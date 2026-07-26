import { Hono, type Context } from 'hono';
import { ZodError, z } from 'zod';
import {
  AppError, adjustInventorySchema, badRequest, can, canReadOrder, canTransitionOrder, conflict, createAfterSalesSchema,
  createDealerSchema, createOrderSchema, createProductSchema, createStoreSchema, createUserSchema, forbidden, loginSchema, notFound, reviewOrderSchema, scanSerialSchema, shipmentSchema, updateAfterSalesSchema, updateOrderSchema,
  type ApiErrorBody, type OrderStatus, type SessionUser
} from '@maxcine/shared';
import { MockEmailAdapter, emailTemplate } from './email';
import { all, caseNo, id, one, orderNo } from './db';
import { createSessionToken, hashIdentifier, hashPassword, requireAuth, verifyPassword } from './auth';
import type { Env, Variables } from './types';

type App = { Bindings: Env; Variables: Variables };
type OrderRow = { id: string; orderNo: string; dealerId: string; storeId: string; status: OrderStatus; totalCents: number; note: string; createdAt: string; updatedAt: string; submittedAt: string | null; reviewedAt: string | null };
type OrderItemRow = { id: string; productId: string; name: string; sku: string; quantity: number; unitPriceCents: number };
type DbUser = SessionUser & { passwordHash: string; isActive: number };

const app = new Hono<App>();
const mailer = new MockEmailAdapter();

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
  const user = await one<DbUser>(c.env.DB, `SELECT id, email, password_hash AS passwordHash, name, role, dealer_id AS dealerId, is_active AS isActive FROM users WHERE email = ?`, input.email);
  const valid = Boolean(user?.isActive && user && await verifyPassword(input.password, user.passwordHash));
  await c.env.DB.prepare('INSERT INTO login_attempts (id, identifier_hash, succeeded) VALUES (?, ?, ?)').bind(id(), identifierHash, valid ? 1 : 0).run();
  if (!valid || !user) throw new AppError(401, 'INVALID_CREDENTIALS', '账号或密码不正确');
  const sessionUser: SessionUser = { id: user.id, email: user.email, name: user.name, role: user.role, dealerId: user.dealerId };
  const token = await createSessionToken(sessionUser, c.env.SESSION_SECRET);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(user.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'auth.login', entityType: 'user', entityId: user.id, requestId: c.get('requestId') })
  ]);
  const isSecure = new URL(c.req.url).protocol === 'https:';
  c.header('Set-Cookie', `mc_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${isSecure ? '; Secure' : ''}`);
  return c.json({ user: sessionUser, token });
});

app.post('/auth/logout', requireAuth, (c) => {
  c.header('Set-Cookie', 'mc_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  return c.body(null, 204);
});

app.get('/me', requireAuth, (c) => c.json({ user: c.get('user') }));

app.get('/stores', requireAuth, async (c) => {
  const user = c.get('user');
  if (user.role !== 'dealer' || !user.dealerId) throw forbidden('仅经销商账户可以查看授权店铺');
  const stores = await all<{ id: string; code: string; name: string }>(c.env.DB,
    `SELECT id, code, name FROM stores WHERE dealer_id = ? AND status = 'active' ORDER BY name`, user.dealerId);
  return c.json({ stores });
});

app.get('/inventory', requireAuth, async (c) => {
  assertPermission(c.get('user'), 'inventory:read');
  const search = new URL(c.req.url).searchParams.get('search')?.trim() ?? '';
  const items = await all<{ id: string; productId: string; sku: string; name: string; description: string; specification: string; unitPriceCents: number; availableQuantity: number; reservedQuantity: number; reorderLevel: number; updatedAt: string }>(c.env.DB,
    `SELECT inventory.id, products.id AS productId, products.sku, products.name, products.description, products.specification,
      products.unit_price_cents AS unitPriceCents, inventory.quantity AS availableQuantity, inventory.reorder_level AS reorderLevel,
      inventory.updated_at AS updatedAt,
      COALESCE((SELECT SUM(order_items.quantity) FROM order_items JOIN orders ON orders.id = order_items.order_id
        WHERE order_items.product_id = products.id AND orders.status IN ('approved','picking','packed')), 0) AS reservedQuantity
     FROM inventory JOIN products ON products.id = inventory.product_id
     WHERE products.is_active = 1 AND (? = '' OR products.name LIKE '%' || ? || '%' OR products.sku LIKE '%' || ? || '%')
     ORDER BY products.sku`, search, search, search);
  return c.json({ items });
});

app.get('/inventory/:id', requireAuth, async (c) => {
  assertPermission(c.get('user'), 'inventory:read');
  const item = await one<{ id: string; productId: string; sku: string; name: string; description: string; specification: string; unitPriceCents: number; availableQuantity: number; reservedQuantity: number; reorderLevel: number; updatedAt: string }>(c.env.DB,
    `SELECT inventory.id, products.id AS productId, products.sku, products.name, products.description, products.specification,
      products.unit_price_cents AS unitPriceCents, inventory.quantity AS availableQuantity, inventory.reorder_level AS reorderLevel,
      inventory.updated_at AS updatedAt,
      COALESCE((SELECT SUM(order_items.quantity) FROM order_items JOIN orders ON orders.id = order_items.order_id
        WHERE order_items.product_id = products.id AND orders.status IN ('approved','picking','packed')), 0) AS reservedQuantity
     FROM inventory JOIN products ON products.id = inventory.product_id WHERE inventory.id = ?`, c.req.param('id'));
  if (!item) throw notFound('未找到该产品库存');
  return c.json({ item });
});

app.get('/dealer/dashboard', requireAuth, async (c) => {
  const user = c.get('user');
  if (user.role !== 'dealer' || !user.dealerId) throw forbidden('仅经销商账户可以查看此页面');
  const [draft, submitted, inventoryAlert, notifications] = await Promise.all([
    one<{ count: number }>(c.env.DB, `SELECT COUNT(*) AS count FROM orders WHERE dealer_id = ? AND status = 'draft'`, user.dealerId),
    one<{ count: number }>(c.env.DB, `SELECT COUNT(*) AS count FROM orders WHERE dealer_id = ? AND status = 'submitted'`, user.dealerId),
    one<{ count: number }>(c.env.DB, `SELECT COUNT(*) AS count FROM inventory WHERE quantity <= reorder_level`),
    all<{ id: string; title: string; body: string; type: string; link: string | null; createdAt: string; readAt: string | null }>(c.env.DB,
      `SELECT id, title, body, type, link, created_at AS createdAt, read_at AS readAt FROM notifications
       WHERE dealer_id = ? OR user_id = ? ORDER BY created_at DESC LIMIT 6`, user.dealerId, user.id)
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
  if (user.role !== 'dealer' || !user.dealerId) throw forbidden('仅经销商账户可以创建订单');
  const store = await one<{ id: string }>(c.env.DB, 'SELECT id FROM stores WHERE id = ? AND dealer_id = ? AND status = \'active\'', input.storeId, user.dealerId);
  if (!store) throw forbidden('该店铺不在你的授权范围内');
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
      .bind(orderId, orderNo(), user.dealerId, input.storeId, input.note, total, user.id, user.id),
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
  if (user.role !== 'dealer' || !user.dealerId || order.status !== 'draft') throw conflict('只有草稿订单可以编辑');
  const store = await one<{ id: string }>(c.env.DB, 'SELECT id FROM stores WHERE id = ? AND dealer_id = ? AND status = \'active\'', input.storeId, user.dealerId);
  if (!store) throw forbidden('该店铺不在你的授权范围内');
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
  if (user.role !== 'dealer' || order.status !== 'draft') throw conflict('只有草稿订单可以删除');
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
  if (user.role !== 'dealer' || !user.dealerId || source.status !== 'rejected') throw conflict('仅审核未通过的订单可以复制');
  const items = await all<{ productId: string; quantity: number; sku: string; name: string; price: number; availableQuantity: number }>(c.env.DB,
    `SELECT order_items.product_id AS productId, order_items.quantity, products.sku, products.name, products.unit_price_cents AS price, inventory.quantity AS availableQuantity
      FROM order_items JOIN products ON products.id = order_items.product_id JOIN inventory ON inventory.product_id = products.id WHERE order_items.order_id = ? AND products.is_active = 1`, source.id);
  if (!items.length || items.some((item) => item.quantity > item.availableQuantity)) throw conflict('原订单中有产品暂时无法复制，请重新选择产品');
  const copiedId = id();
  const total = items.reduce((sum, item) => sum + item.quantity * item.price, 0);
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO orders (id, order_no, dealer_id, store_id, note, total_cents, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(copiedId, orderNo(), user.dealerId, source.storeId, '', total, user.id, user.id),
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
  if (user.role === 'dealer') { where.push('orders.dealer_id = ?'); params.push(user.dealerId ?? ''); }
  if (user.role === 'warehouse') where.push(`orders.status IN ('approved','picking','packed','shipped','delivered')`);
  if (status && ['draft', 'submitted', 'approved', 'rejected', 'picking', 'packed', 'shipped', 'delivered', 'cancelled'].includes(status)) { where.push('orders.status = ?'); params.push(status); }
  if (search) { where.push('orders.order_no LIKE ?'); params.push(`%${search}%`); }
  if (storeId) { where.push('orders.store_id = ?'); params.push(storeId); }
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
  if (!canTransitionOrder(user.role, order.status, 'submitted')) throw conflict('该订单暂时不能提交审核');
  const unavailable = await one<{ count: number }>(c.env.DB, `SELECT COUNT(*) AS count FROM order_items
    JOIN inventory ON inventory.product_id = order_items.product_id WHERE order_items.order_id = ? AND order_items.quantity > inventory.quantity`, order.id);
  if ((unavailable?.count ?? 0) > 0) throw conflict('订单中有产品库存不足，请修改后再提交');
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE orders SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ? AND status = 'draft'`).bind(user.id, order.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'order.submit', entityType: 'order', entityId: order.id, requestId: c.get('requestId'), before: { status: 'draft' }, after: { status: 'submitted' } })
  ]);
  const message = emailTemplate('order_submitted', { reference: order.orderNo, logoUrl: `${c.env.APP_ORIGIN}/assets/maxcine-logo-dark.jpg` });
  await mailer.send({ ...message, to: user.email });
  return c.json({ id: order.id, status: 'submitted' });
});

app.post('/orders/:id/review', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'order:review');
  const input = await parseBody(c.req.raw, reviewOrderSchema);
  const order = await getOrder(c.env.DB, c.req.param('id'));
  if (order.status !== 'submitted') throw conflict('Only submitted orders can be reviewed');
  const targetStatus: OrderStatus = input.approved ? 'approved' : 'rejected';
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(`UPDATE orders SET status = ?, note = ?, reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ? AND status = 'submitted'`)
      .bind(targetStatus, input.note ?? '', user.id, user.id, order.id)
  ];
  if (input.approved) {
    const items = await all<{ productId: string; quantity: number }>(c.env.DB, 'SELECT product_id AS productId, quantity FROM order_items WHERE order_id = ?', order.id);
    for (const item of items) {
      const inventory = await one<{ id: string; quantity: number }>(c.env.DB, 'SELECT id, quantity FROM inventory WHERE product_id = ?', item.productId);
      if (!inventory || inventory.quantity < item.quantity) throw conflict('Insufficient shared inventory to approve this order');
      statements.push(c.env.DB.prepare(`INSERT INTO inventory_transactions (id, inventory_id, product_id, order_id, transaction_type, quantity_delta, note, created_by)
        VALUES (?, ?, ?, ?, 'order_reserved', ?, ?, ?)`).bind(id(), inventory.id, item.productId, order.id, -item.quantity, `Reserved for ${order.orderNo}`, user.id));
    }
  }
  statements.push(
    c.env.DB.prepare('INSERT INTO notifications (id, dealer_id, type, title, body, link) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id(), order.dealerId, `order_${targetStatus}`, input.approved ? '订单审核通过' : '订单审核未通过', input.note ?? '', `/system/orders/${order.id}`),
    dbAudit(c.env.DB, { actorId: user.id, action: input.approved ? 'order.approve' : 'order.reject', entityType: 'order', entityId: order.id, requestId: c.get('requestId'), before: { status: 'submitted' }, after: { status: targetStatus } })
  );
  try {
    await c.env.DB.batch(statements);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Inventory cannot be negative')) throw conflict('Insufficient shared inventory to approve this order');
    throw error;
  }
  const email = emailTemplate(input.approved ? 'order_approved' : 'order_rejected', { reference: order.orderNo, note: input.note, logoUrl: `${c.env.APP_ORIGIN}/assets/maxcine-logo-dark.jpg` });
  await mailer.send({ ...email, to: 'dealer-notification@example.test' });
  return c.json({ id: order.id, status: targetStatus });
});

app.post('/orders/:id/picking', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'order:fulfill');
  const order = await getOrder(c.env.DB, c.req.param('id'));
  if (!canTransitionOrder(user.role, order.status, 'picking')) throw conflict('This order is not ready for picking');
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
  if (order.status !== 'picking') throw conflict('Serial numbers can only be recorded while picking');
  const item = await one<OrderItemRow>(c.env.DB, `SELECT id, product_id AS productId, product_name_snapshot AS name, sku_snapshot AS sku, quantity, unit_price_cents AS unitPriceCents
    FROM order_items WHERE order_id = ? AND product_id = ?`, order.id, input.productId);
  if (!item) throw badRequest('This product is not part of the order');
  const count = await one<{ count: number }>(c.env.DB, `SELECT COUNT(*) AS count FROM serial_numbers WHERE order_item_id = ? AND state IN ('allocated','shipped')`, item.id);
  if ((count?.count ?? 0) >= item.quantity) throw conflict('All serial numbers for this item have already been recorded');
  const existing = await one<{ id: string }>(c.env.DB, 'SELECT id FROM serial_numbers WHERE serial_number = ?', input.serialNumber);
  if (existing) throw conflict('This SN has already been bound or recorded');
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO serial_numbers (id, product_id, serial_number, state, order_item_id, bound_at, created_by, updated_by)
      VALUES (?, ?, ?, 'allocated', ?, CURRENT_TIMESTAMP, ?, ?)`).bind(id(), input.productId, input.serialNumber, item.id, user.id, user.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'warehouse.bind_serial', entityType: 'order', entityId: order.id, requestId: c.get('requestId'), after: { serialNumber: input.serialNumber, productId: input.productId } })
  ]);
  return c.json({ serialNumber: input.serialNumber, state: 'allocated' }, 201);
});

app.post('/orders/:id/pack', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'order:fulfill');
  const order = await getOrder(c.env.DB, c.req.param('id'));
  if (!canTransitionOrder(user.role, order.status, 'packed')) throw conflict('This order is not ready to be packed');
  const [expected, scanned] = await Promise.all([
    one<{ count: number }>(c.env.DB, 'SELECT COALESCE(SUM(quantity), 0) AS count FROM order_items WHERE order_id = ?', order.id),
    one<{ count: number }>(c.env.DB, `SELECT COUNT(*) AS count FROM serial_numbers WHERE state = 'allocated' AND order_item_id IN (SELECT id FROM order_items WHERE order_id = ?)`, order.id)
  ]);
  if ((expected?.count ?? 0) !== (scanned?.count ?? 0)) throw conflict('Record all required serial numbers before packing');
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
  if (!canTransitionOrder(user.role, order.status, 'shipped')) throw conflict('This order is not ready to ship');
  const shipmentId = id();
  const existingTracking = await one<{ id: string }>(c.env.DB, 'SELECT id FROM shipments WHERE tracking_number = ?', input.trackingNumber);
  if (existingTracking) throw conflict('This tracking number has already been used');
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO shipments (id, order_id, tracking_number, created_by, updated_by) VALUES (?, ?, ?, ?, ?)`)
      .bind(shipmentId, order.id, input.trackingNumber, user.id, user.id),
    c.env.DB.prepare(`UPDATE serial_numbers SET state = 'shipped', shipment_id = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ?
      WHERE state = 'allocated' AND order_item_id IN (SELECT id FROM order_items WHERE order_id = ?)`)
      .bind(shipmentId, user.id, order.id),
    c.env.DB.prepare(`UPDATE orders SET status = 'shipped', updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ? AND status = 'packed'`).bind(user.id, order.id),
    c.env.DB.prepare('INSERT INTO notifications (id, dealer_id, type, title, body, link) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id(), order.dealerId, 'order_shipped', '订单已发货', `顺丰运单号：${input.trackingNumber}`, `/system/orders/${order.id}`),
    dbAudit(c.env.DB, { actorId: user.id, action: 'warehouse.ship', entityType: 'order', entityId: order.id, requestId: c.get('requestId'), before: { status: 'packed' }, after: { status: 'shipped', trackingNumber: input.trackingNumber } })
  ]);
  const email = emailTemplate('order_shipped', { reference: order.orderNo, trackingNumber: input.trackingNumber, logoUrl: `${c.env.APP_ORIGIN}/assets/maxcine-logo-dark.jpg` });
  await mailer.send({ ...email, to: 'dealer-notification@example.test' });
  return c.json({ id: order.id, status: 'shipped', trackingNumber: input.trackingNumber });
});

app.get('/notifications', requireAuth, async (c) => {
  const user = c.get('user');
  const url = new URL(c.req.url);
  const page = pageValue(url.searchParams.get('page') ?? undefined);
  const limit = limitValue(url.searchParams.get('limit') ?? undefined);
  const scopeSql = user.role === 'dealer' && user.dealerId ? '(dealer_id = ? OR user_id = ?)' : 'user_id = ?';
  const scopeParams: string[] = user.role === 'dealer' && user.dealerId ? [user.dealerId, user.id] : [user.id];
  const [notifications, unread] = await Promise.all([
    all(c.env.DB, `SELECT id, type, title, body, link, read_at AS readAt, created_at AS createdAt FROM notifications WHERE ${scopeSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`, ...scopeParams, limit, (page - 1) * limit),
    one<{ count: number }>(c.env.DB, `SELECT COUNT(*) AS count FROM notifications WHERE ${scopeSql} AND read_at IS NULL`, ...scopeParams)
  ]);
  return c.json({ notifications, unreadCount: unread?.count ?? 0 });
});

app.patch('/notifications/:id/read', requireAuth, async (c) => {
  const user = c.get('user');
  const notification = await one<{ id: string }>(c.env.DB,
    user.role === 'dealer' && user.dealerId
      ? 'SELECT id FROM notifications WHERE id = ? AND (dealer_id = ? OR user_id = ?)' : 'SELECT id FROM notifications WHERE id = ? AND user_id = ?',
    ...(user.role === 'dealer' && user.dealerId ? [c.req.param('id'), user.dealerId, user.id] : [c.req.param('id'), user.id]));
  if (!notification) throw notFound('未找到该通知');
  await c.env.DB.prepare('UPDATE notifications SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP) WHERE id = ?').bind(notification.id).run();
  return c.json({ id: notification.id, read: true });
});

app.post('/notifications/read-all', requireAuth, async (c) => {
  const user = c.get('user');
  if (user.role === 'dealer' && user.dealerId) {
    await c.env.DB.prepare('UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE read_at IS NULL AND (dealer_id = ? OR user_id = ?)').bind(user.dealerId, user.id).run();
  } else {
    await c.env.DB.prepare('UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE read_at IS NULL AND user_id = ?').bind(user.id).run();
  }
  return c.json({ read: true });
});

app.post('/after-sales', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'after-sales:create');
  const input = await parseBody(c.req.raw, createAfterSalesSchema);
  if (user.role !== 'dealer' || !user.dealerId) throw forbidden('仅经销商账户可以提交售后申请');
  const store = await one<{ id: string }>(c.env.DB, 'SELECT id FROM stores WHERE id = ? AND dealer_id = ? AND status = \'active\'', input.storeId, user.dealerId);
  if (!store) throw forbidden('该店铺不在你的授权范围内');
  if (input.orderId) {
    const order = await getOrder(c.env.DB, input.orderId);
    assertOrderAccess(user, order);
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
      .bind(caseId, reference, user.dealerId, input.storeId, input.orderId ?? null, input.productId ?? null, input.serialNumber ?? null, input.caseType, input.subject, input.description, input.contactName, input.contactPhone, user.id, user.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'after_sales.create', entityType: 'after_sales_case', entityId: caseId, requestId: c.get('requestId') })
  ]);
  const email = emailTemplate('after_sales_created', { reference, logoUrl: `${c.env.APP_ORIGIN}/assets/maxcine-logo-dark.jpg` });
  await mailer.send({ ...email, to: user.email });
  return c.json({ id: caseId, caseNo: reference, status: 'open' }, 201);
});

app.get('/after-sales', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'after-sales:read');
  const page = pageValue(new URL(c.req.url).searchParams.get('page') ?? undefined);
  const limit = limitValue(new URL(c.req.url).searchParams.get('limit') ?? undefined);
  const cases = user.role === 'admin'
    ? await all(c.env.DB, `SELECT after_sales_cases.id, case_no AS caseNo, dealer_id AS dealerId, order_id AS orderId, products.name AS productName, serial_number AS serialNumber, case_type AS caseType, subject, status, after_sales_cases.created_at AS createdAt, after_sales_cases.updated_at AS updatedAt FROM after_sales_cases LEFT JOIN products ON products.id = after_sales_cases.product_id ORDER BY after_sales_cases.created_at DESC LIMIT ? OFFSET ?`, limit, (page - 1) * limit)
    : await all(c.env.DB, `SELECT after_sales_cases.id, case_no AS caseNo, dealer_id AS dealerId, order_id AS orderId, products.name AS productName, serial_number AS serialNumber, case_type AS caseType, subject, status, after_sales_cases.created_at AS createdAt, after_sales_cases.updated_at AS updatedAt FROM after_sales_cases LEFT JOIN products ON products.id = after_sales_cases.product_id WHERE dealer_id = ? ORDER BY after_sales_cases.created_at DESC LIMIT ? OFFSET ?`, user.dealerId ?? '', limit, (page - 1) * limit);
  return c.json({ cases });
});

app.get('/after-sales/:id', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'after-sales:read');
  const serviceCase = await one<{ id: string; caseNo: string; dealerId: string; storeId: string | null; storeName: string | null; orderId: string | null; productId: string | null; productName: string | null; serialNumber: string | null; caseType: string; subject: string; description: string; contactName: string | null; contactPhone: string | null; status: string; createdAt: string; updatedAt: string }>(c.env.DB,
    `SELECT after_sales_cases.id, case_no AS caseNo, dealer_id AS dealerId, store_id AS storeId, stores.name AS storeName, order_id AS orderId, product_id AS productId, products.name AS productName, serial_number AS serialNumber, case_type AS caseType, subject, description, contact_name AS contactName, contact_phone AS contactPhone, after_sales_cases.status, after_sales_cases.created_at AS createdAt, after_sales_cases.updated_at AS updatedAt
     FROM after_sales_cases LEFT JOIN stores ON stores.id = after_sales_cases.store_id LEFT JOIN products ON products.id = after_sales_cases.product_id WHERE after_sales_cases.id = ?`, c.req.param('id'));
  if (!serviceCase) throw notFound('未找到该售后工单');
  if (user.role === 'dealer' && user.dealerId !== serviceCase.dealerId) throw forbidden('你无权查看该售后工单');
  return c.json({ case: serviceCase });
});

app.patch('/after-sales/:id', requireAuth, async (c) => {
  const user = c.get('user');
  if (user.role !== 'admin') throw forbidden();
  const input = await parseBody(c.req.raw, updateAfterSalesSchema);
  const serviceCase = await one<{ id: string; caseNo: string; dealerId: string; status: string }>(c.env.DB, 'SELECT id, case_no AS caseNo, dealer_id AS dealerId, status FROM after_sales_cases WHERE id = ?', c.req.param('id'));
  if (!serviceCase) throw notFound('After-sales case not found');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE after_sales_cases SET status = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?').bind(input.status, user.id, serviceCase.id),
    c.env.DB.prepare('INSERT INTO notifications (id, dealer_id, type, title, body, link) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id(), serviceCase.dealerId, 'after_sales_updated', '售后工单状态更新', input.note ?? `当前状态：${input.status}`, `/system/after-sales/${serviceCase.id}`),
    dbAudit(c.env.DB, { actorId: user.id, action: 'after_sales.update', entityType: 'after_sales_case', entityId: serviceCase.id, requestId: c.get('requestId'), before: { status: serviceCase.status }, after: { status: input.status } })
  ]);
  const email = emailTemplate('after_sales_updated', { reference: serviceCase.caseNo, status: input.status, logoUrl: `${c.env.APP_ORIGIN}/assets/maxcine-logo-dark.jpg` });
  await mailer.send({ ...email, to: 'dealer-notification@example.test' });
  return c.json({ id: serviceCase.id, status: input.status });
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
  if (!inventory) throw notFound('Inventory record not found');
  if (inventory.quantity + input.quantityDelta < 0) throw conflict('This adjustment would make inventory negative');
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO inventory_transactions (id, inventory_id, product_id, transaction_type, quantity_delta, note, created_by)
        VALUES (?, ?, ?, 'adjustment', ?, ?, ?)`).bind(id(), inventory.id, inventory.productId, input.quantityDelta, input.note, user.id),
      dbAudit(c.env.DB, { actorId: user.id, action: 'inventory.adjust', entityType: 'inventory', entityId: inventory.id, requestId: c.get('requestId'), before: { quantity: inventory.quantity }, after: { quantityDelta: input.quantityDelta, note: input.note } })
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Inventory cannot be negative')) throw conflict('This adjustment would make inventory negative');
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
    c.env.DB.prepare('INSERT INTO dealers (id, code, name, created_by, updated_by) VALUES (?, ?, ?, ?, ?)').bind(dealerId, input.code, input.name, user.id, user.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'dealer.create', entityType: 'dealer', entityId: dealerId, requestId: c.get('requestId'), after: input })
  ]);
  return c.json({ id: dealerId }, 201);
});

app.post('/admin/stores', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'dealer:manage');
  const input = await parseBody(c.req.raw, createStoreSchema);
  const dealer = await one<{ id: string }>(c.env.DB, 'SELECT id FROM dealers WHERE id = ? AND status = \'active\'', input.dealerId);
  if (!dealer) throw badRequest('The selected dealer is unavailable');
  const storeId = id();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO stores (id, dealer_id, code, name, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?)').bind(storeId, input.dealerId, input.code, input.name, user.id, user.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'store.create', entityType: 'store', entityId: storeId, requestId: c.get('requestId'), after: input })
  ]);
  return c.json({ id: storeId }, 201);
});

app.post('/admin/users', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'user:manage');
  const input = await parseBody(c.req.raw, createUserSchema);
  if (input.dealerId) {
    const dealer = await one<{ id: string }>(c.env.DB, 'SELECT id FROM dealers WHERE id = ? AND status = \'active\'', input.dealerId);
    if (!dealer) throw badRequest('The selected dealer is unavailable');
  }
  const userId = id();
  const passwordHash = await hashPassword(input.password);
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO users (id, email, password_hash, name, role, dealer_id, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(userId, input.email, passwordHash, input.name, input.role, input.dealerId ?? null, user.id, user.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'user.create', entityType: 'user', entityId: userId, requestId: c.get('requestId'), after: { email: input.email, role: input.role } })
  ]);
  return c.json({ id: userId }, 201);
});

app.get('/admin/users', requireAuth, async (c) => {
  assertPermission(c.get('user'), 'user:manage');
  return c.json({ users: await all(c.env.DB, `SELECT id, email, name, role, dealer_id AS dealerId, is_active AS isActive, created_at AS createdAt FROM users ORDER BY created_at DESC`) });
});

app.get('/admin/dealers', requireAuth, async (c) => {
  assertPermission(c.get('user'), 'dealer:manage');
  return c.json({ dealers: await all(c.env.DB, `SELECT dealers.id, dealers.code, dealers.name, dealers.status, COUNT(stores.id) AS storeCount FROM dealers LEFT JOIN stores ON stores.dealer_id = dealers.id GROUP BY dealers.id ORDER BY dealers.name`) });
});

app.get('/admin/audit-logs', requireAuth, async (c) => {
  assertPermission(c.get('user'), 'audit:read');
  return c.json({ logs: await all(c.env.DB, `SELECT audit_logs.id, audit_logs.action, audit_logs.entity_type AS entityType, audit_logs.entity_id AS entityId, audit_logs.created_at AS createdAt, users.email AS actorEmail FROM audit_logs LEFT JOIN users ON users.id = audit_logs.actor_id ORDER BY audit_logs.created_at DESC LIMIT 200`) });
});

export default app;
