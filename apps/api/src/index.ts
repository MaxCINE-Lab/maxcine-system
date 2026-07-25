import { Hono, type Context } from 'hono';
import { ZodError, z } from 'zod';
import {
  AppError, adjustInventorySchema, badRequest, can, canReadOrder, canTransitionOrder, conflict, createAfterSalesSchema,
  createDealerSchema, createOrderSchema, createProductSchema, createStoreSchema, createUserSchema, forbidden, loginSchema, notFound, reviewOrderSchema, scanSerialSchema, shipmentSchema, updateAfterSalesSchema,
  type ApiErrorBody, type OrderStatus, type SessionUser
} from '@maxcine/shared';
import { MockEmailAdapter, emailTemplate } from './email';
import { all, caseNo, id, one, orderNo } from './db';
import { createSessionToken, hashIdentifier, hashPassword, requireAuth, verifyPassword } from './auth';
import type { Env, Variables } from './types';

type App = { Bindings: Env; Variables: Variables };
type OrderRow = { id: string; orderNo: string; dealerId: string; storeId: string; status: OrderStatus; totalCents: number; note: string; createdAt: string; submittedAt: string | null; reviewedAt: string | null };
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
    throw badRequest('Request body must be valid JSON');
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw badRequest('Some fields are invalid', zodDetails(parsed.error));
  return parsed.data;
}

async function getOrder(db: D1Database, orderId: string): Promise<OrderRow> {
  const order = await one<OrderRow>(db, `SELECT id, order_no AS orderNo, dealer_id AS dealerId, store_id AS storeId, status, total_cents AS totalCents, note,
    created_at AS createdAt, submitted_at AS submittedAt, reviewed_at AS reviewedAt FROM orders WHERE id = ?`, orderId);
  if (!order) throw notFound('Order not found');
  return order;
}

function assertOrderAccess(user: SessionUser, order: OrderRow): void {
  if (!canReadOrder(user, order)) throw forbidden('You cannot access this order');
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
  if (c.req.method === 'OPTIONS') return c.body(null, 204, { 'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS', 'Access-Control-Allow-Headers': 'Authorization,Content-Type,X-Request-ID' });
  if (unsafeMethods.has(c.req.method) && origin && origin !== c.env.APP_ORIGIN) throw forbidden('Cross-origin write requests are not allowed');
  await next();
});

app.onError((error, c) => {
  if (error instanceof AppError) return errorResponse(c, error);
  if (error instanceof ZodError) return errorResponse(c, badRequest('Some fields are invalid', zodDetails(error)));
  console.error(JSON.stringify({ requestId: c.get('requestId'), error: error instanceof Error ? error.message : 'Unknown error' }));
  return errorResponse(c, new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred'));
});

app.get('/health', (c) => c.json({ ok: true, service: 'maxcine-api', requestId: c.get('requestId') }));

app.post('/auth/login', async (c) => {
  const input = await parseBody(c.req.raw, loginSchema);
  const identifierHash = await hashIdentifier(input.email);
  const attempts = await one<{ count: number }>(c.env.DB,
    `SELECT COUNT(*) AS count FROM login_attempts WHERE identifier_hash = ? AND succeeded = 0 AND attempted_at > datetime('now', '-15 minutes')`, identifierHash);
  if ((attempts?.count ?? 0) >= 8) throw new AppError(429, 'RATE_LIMITED', 'Too many login attempts. Try again in 15 minutes.');
  const user = await one<DbUser>(c.env.DB, `SELECT id, email, password_hash AS passwordHash, name, role, dealer_id AS dealerId, is_active AS isActive FROM users WHERE email = ?`, input.email);
  const valid = Boolean(user?.isActive && user && await verifyPassword(input.password, user.passwordHash));
  await c.env.DB.prepare('INSERT INTO login_attempts (id, identifier_hash, succeeded) VALUES (?, ?, ?)').bind(id(), identifierHash, valid ? 1 : 0).run();
  if (!valid || !user) throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
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

app.get('/inventory', requireAuth, async (c) => {
  assertPermission(c.get('user'), 'inventory:read');
  const items = await all<{ id: string; sku: string; name: string; quantity: number; reorderLevel: number }>(c.env.DB,
    `SELECT inventory.id, products.sku, products.name, inventory.quantity, inventory.reorder_level AS reorderLevel
     FROM inventory JOIN products ON products.id = inventory.product_id WHERE products.is_active = 1 ORDER BY products.sku`);
  return c.json({ items });
});

app.post('/orders', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'order:create');
  const input = await parseBody(c.req.raw, createOrderSchema);
  if (user.role !== 'dealer' || !user.dealerId) throw forbidden('Orders must be created from a dealer account');
  const store = await one<{ id: string }>(c.env.DB, 'SELECT id FROM stores WHERE id = ? AND dealer_id = ? AND status = \'active\'', input.storeId, user.dealerId);
  if (!store) throw forbidden('This store is not available to your dealer');
  if (new Set(input.items.map((item) => item.productId)).size !== input.items.length) throw badRequest('Each product can appear only once in an order');
  const productIds = input.items.map((item) => item.productId);
  const placeholders = productIds.map(() => '?').join(',');
  const products = await all<{ id: string; sku: string; name: string; price: number }>(c.env.DB,
    `SELECT id, sku, name, unit_price_cents AS price FROM products WHERE is_active = 1 AND id IN (${placeholders})`, ...productIds);
  if (products.length !== input.items.length) throw badRequest('One or more products are unavailable');
  const productsById = new Map(products.map((product) => [product.id, product]));
  const orderId = id();
  const lines = input.items.map((item) => ({ ...item, product: productsById.get(item.productId)! }));
  const total = lines.reduce((sum, line) => sum + line.quantity * line.product.price, 0);
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(`INSERT INTO orders (id, order_no, dealer_id, store_id, total_cents, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(orderId, orderNo(), user.dealerId, input.storeId, total, user.id, user.id),
    ...lines.map((line) => c.env.DB.prepare(`INSERT INTO order_items (id, order_id, product_id, product_name_snapshot, sku_snapshot, unit_price_cents, quantity, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id(), orderId, line.productId, line.product.name, line.product.sku, line.product.price, line.quantity, user.id, user.id)),
    dbAudit(c.env.DB, { actorId: user.id, action: 'order.create', entityType: 'order', entityId: orderId, requestId: c.get('requestId'), after: { status: 'draft' } })
  ];
  await c.env.DB.batch(statements);
  return c.json({ id: orderId, status: 'draft' }, 201);
});

app.get('/orders', requireAuth, async (c) => {
  const user = c.get('user');
  let sql = `SELECT id, order_no AS orderNo, dealer_id AS dealerId, store_id AS storeId, status, total_cents AS totalCents, note, created_at AS createdAt, submitted_at AS submittedAt, reviewed_at AS reviewedAt FROM orders`;
  const params: string[] = [];
  if (user.role === 'dealer') { sql += ' WHERE dealer_id = ?'; params.push(user.dealerId ?? ''); }
  if (user.role === 'warehouse') sql += ` WHERE status IN ('approved','picking','packed','shipped','delivered')`;
  sql += ' ORDER BY created_at DESC LIMIT 100';
  return c.json({ orders: await all<OrderRow>(c.env.DB, sql, ...params) });
});

app.get('/orders/:id', requireAuth, async (c) => {
  const user = c.get('user');
  const order = await getOrder(c.env.DB, c.req.param('id'));
  assertOrderAccess(user, order);
  const [items, shipment] = await Promise.all([
    all<OrderItemRow>(c.env.DB, `SELECT id, product_id AS productId, product_name_snapshot AS name, sku_snapshot AS sku, quantity, unit_price_cents AS unitPriceCents FROM order_items WHERE order_id = ?`, order.id),
    one<{ id: string; trackingNumber: string; carrier: string; status: string; shippedAt: string }>(c.env.DB, `SELECT id, tracking_number AS trackingNumber, carrier, status, shipped_at AS shippedAt FROM shipments WHERE order_id = ?`, order.id)
  ]);
  const serials = await all<{ id: string; productId: string; serialNumber: string; state: string; orderItemId: string }>(c.env.DB,
    `SELECT id, product_id AS productId, serial_number AS serialNumber, state, order_item_id AS orderItemId FROM serial_numbers WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = ?)`, order.id);
  return c.json({ order, items, serials, shipment });
});

app.post('/orders/:id/submit', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'order:submit');
  const order = await getOrder(c.env.DB, c.req.param('id'));
  assertOrderAccess(user, order);
  if (!canTransitionOrder(user.role, order.status, 'submitted')) throw conflict('This order cannot be submitted in its current state');
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
  const notifications = user.role === 'dealer' && user.dealerId
    ? await all(c.env.DB, `SELECT id, type, title, body, link, read_at AS readAt, created_at AS createdAt FROM notifications WHERE dealer_id = ? OR user_id = ? ORDER BY created_at DESC LIMIT 100`, user.dealerId, user.id)
    : await all(c.env.DB, `SELECT id, type, title, body, link, read_at AS readAt, created_at AS createdAt FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`, user.id);
  return c.json({ notifications });
});

app.post('/after-sales', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'after-sales:create');
  const input = await parseBody(c.req.raw, createAfterSalesSchema);
  if (!user.dealerId) throw forbidden('A dealer relationship is required to create an after-sales case');
  if (input.orderId) assertOrderAccess(user, await getOrder(c.env.DB, input.orderId));
  const caseId = id();
  const reference = caseNo();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO after_sales_cases (id, case_no, dealer_id, order_id, subject, description, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(caseId, reference, user.dealerId, input.orderId ?? null, input.subject, input.description, user.id, user.id),
    dbAudit(c.env.DB, { actorId: user.id, action: 'after_sales.create', entityType: 'after_sales_case', entityId: caseId, requestId: c.get('requestId') })
  ]);
  const email = emailTemplate('after_sales_created', { reference, logoUrl: `${c.env.APP_ORIGIN}/assets/maxcine-logo-dark.jpg` });
  await mailer.send({ ...email, to: user.email });
  return c.json({ id: caseId, caseNo: reference, status: 'open' }, 201);
});

app.get('/after-sales', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'after-sales:read');
  const cases = user.role === 'admin'
    ? await all(c.env.DB, `SELECT id, case_no AS caseNo, dealer_id AS dealerId, order_id AS orderId, subject, status, created_at AS createdAt, updated_at AS updatedAt FROM after_sales_cases ORDER BY created_at DESC LIMIT 100`)
    : await all(c.env.DB, `SELECT id, case_no AS caseNo, dealer_id AS dealerId, order_id AS orderId, subject, status, created_at AS createdAt, updated_at AS updatedAt FROM after_sales_cases WHERE dealer_id = ? ORDER BY created_at DESC LIMIT 100`, user.dealerId ?? '');
  return c.json({ cases });
});

app.get('/after-sales/:id', requireAuth, async (c) => {
  const user = c.get('user');
  assertPermission(user, 'after-sales:read');
  const serviceCase = await one<{ id: string; caseNo: string; dealerId: string; orderId: string | null; subject: string; description: string; status: string; createdAt: string; updatedAt: string }>(c.env.DB,
    `SELECT id, case_no AS caseNo, dealer_id AS dealerId, order_id AS orderId, subject, description, status, created_at AS createdAt, updated_at AS updatedAt FROM after_sales_cases WHERE id = ?`, c.req.param('id'));
  if (!serviceCase) throw notFound('After-sales case not found');
  if (user.role === 'dealer' && user.dealerId !== serviceCase.dealerId) throw forbidden('You cannot access this after-sales case');
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
