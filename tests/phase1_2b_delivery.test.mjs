import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { URL } from 'node:url';
import app from '../apps/api/src/index.ts';
import { createSessionToken } from '../apps/api/src/auth.ts';
import { certifiedWarrantyEnd } from '../apps/api/src/certifiedWarranty.ts';
import { warrantyDisplayStatus } from '../packages/shared/dist/index.js';

async function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  const root = new URL('../apps/api/migrations/', import.meta.url);
  for (const name of readdirSync(root).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort()) sqlite.exec(readFileSync(new URL(name, root), 'utf8'));
  sqlite.exec(`PRAGMA foreign_keys = OFF;
    INSERT INTO sales_accounts (id, channel_id, account_name, market_region) VALUES ('account-test', 'channel-ebay-uk', 'Test account', 'UK');
    INSERT INTO assets (id, asset_code, asset_status) VALUES ('43000000-0000-4000-8000-000000000099', 'MC-26-TEST-000099', 'active');
    INSERT INTO asset_locations (asset_id, warehouse_id) VALUES ('43000000-0000-4000-8000-000000000099', 'wh-uk');
    INSERT INTO orders (id, order_no, dealer_id, store_id, created_by, status, channel_id, sales_account_id, fulfilment_warehouse_id, external_order_id)
      VALUES ('order-test', 'TEST-DELIVERY', 'dealer', 'store', 'uk', 'approved', 'channel-ebay-uk', 'account-test', 'wh-uk', 'EXT-DELIVERY');`);
  const tokens = {};
  for (const [user, role, scope] of [
    ['uk', 'uk_fulfilment_operator', { warehouseIds: ['wh-uk'], salesAccountIds: ['account-test'] }],
    ['cn', 'warehouse_manager', { warehouseIds: ['wh-cn-sd'] }],
    ['cert', 'certified_operator', {}],
    ['other', 'uk_fulfilment_operator', { warehouseIds: ['wh-uk'], salesAccountIds: ['account-other'] }]
  ]) {
    sqlite.prepare(`INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, ?, 'unused', 'warehouse')`).run(user, `${user}@example.test`, user);
    sqlite.prepare(`INSERT INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE code = ?`).run(user, role);
    sqlite.prepare(`INSERT INTO user_workspaces (user_id, workspace_id, data_scope_json) VALUES (?, 'ws-uk-fulfilment', ?)`).run(user, JSON.stringify(scope));
    tokens[user] = await createSessionToken({ id: user, email: `${user}@example.test`, name: user, sessionVersion: 1 }, 'test-only-session-secret');
  }
  const db = {
    prepare(sql) {
      let params = [];
      const statement = {
        bind(...values) { params = values; return statement; },
        async first() { return sqlite.prepare(sql).get(...params) ?? null; },
        async all() { return { results: sqlite.prepare(sql).all(...params) }; },
        async run() { const result = sqlite.prepare(sql).run(...params); return { meta: { changes: result.changes } }; }
      };
      return statement;
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }
  };
  const env = { DB: db, SESSION_SECRET: 'test-only-session-secret', APP_ORIGIN: 'https://test.example', APP_ENV: 'staging' };
  const request = (user, path, body) => app.request(`https://test.example${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${tokens[user]}`, Origin: env.APP_ORIGIN, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }, env);
  const ship = async () => {
    assert.equal((await request('uk', '/international/orders/order-test/bind-asset', { assetId: '43000000-0000-4000-8000-000000000099' })).status, 200);
    assert.equal((await request('uk', '/international/orders/order-test/ship', { assetCode: 'MC-26-TEST-000099', carrier: 'Royal Mail', trackingNumber: 'RM-DELIVERY' })).status, 200);
  };
  const deliver = (user = 'uk') => request(user, '/international/orders/order-test/deliver', {});
  const certify = () => sqlite.exec(`INSERT INTO asset_inspection_tasks (id, asset_id, assigned_to, status, result, grade, final_qc)
    VALUES ('inspection-test', '43000000-0000-4000-8000-000000000099', 'cert', 'completed', 'PASS', 'A', 1);
    INSERT INTO asset_certifications (id, asset_id, inspection_task_id, grade, inspection_result, final_qc, verification_code_hash)
    VALUES ('certification-test', '43000000-0000-4000-8000-000000000099', 'inspection-test', 'A', 'PASS', 1, 'test-only');`);
  return { sqlite, db, request, ship, deliver, certify };
}

test('normal shipment then delivery atomically records Customer custody, time, lifecycle and audit without warranties', async () => {
  const f = await fixture(); await f.ship();
  assert.equal((await (await f.request('uk', '/international/orders?view=delivery')).json()).orders.length, 1);
  const response = await f.deliver(); assert.equal(response.status, 200);
  const result = await response.json(); assert.equal(result.status, 'delivered'); assert.ok(result.deliveredAt);
  assert.deepEqual({ ...f.sqlite.prepare('SELECT status, custody, warehouse_id, location_id FROM asset_locations').get() }, { status: 'delivered', custody: 'CUSTOMER', warehouse_id: null, location_id: null });
  assert.equal(f.sqlite.prepare('SELECT delivered_at FROM orders').get().delivered_at, result.deliveredAt);
  const event = f.sqlite.prepare(`SELECT new_value_json FROM asset_events WHERE event_type = 'customer_delivered'`).get();
  const metadata = JSON.parse(event.new_value_json); assert.equal(metadata.order_id, 'order-test'); assert.equal(metadata.external_order_id, 'EXT-DELIVERY'); assert.equal(metadata.delivered_at, result.deliveredAt); assert.equal(metadata.channel, 'EBAY_UK');
  assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'international.order.deliver'`).get().n, 1);
  assert.equal(f.sqlite.prepare('SELECT status FROM international_asset_allocations').get().status, 'fulfilled');
  for (const path of ['/international/orders', '/international/orders?view=delivery']) assert.equal((await (await f.request('uk', path)).json()).orders.length, 0);
  assert.equal((await (await f.request('uk', '/international/warehouses/assets?warehouseId=wh-uk')).json()).assets.length, 0);
  assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM asset_events WHERE event_type = 'warranty_activated'`).get().n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM asset_public_warranties').get().n, 0);
  assert.equal(f.sqlite.prepare('SELECT warranty_start_at FROM assets').get().warranty_start_at, null);
  const detail = (await (await f.request('uk', '/international/orders/order-test')).json()).order;
  assert.equal(detail.deliveredAt, result.deliveredAt); assert.equal(detail.canDeliver, false); assert.equal(detail.warehouseCode, null);
  f.sqlite.close();
});

test('repeated delivery returns same timestamp without duplicate events or audit', async () => {
  const f = await fixture(); await f.ship();
  const first = await (await f.deliver()).json();
  for (let i = 0; i < 3; i++) { const response = await f.deliver(); assert.equal(response.status, 200); assert.deepEqual(await response.json(), first); }
  assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM asset_events WHERE event_type = 'customer_delivered'`).get().n, 1);
  assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'international.order.deliver'`).get().n, 1);
  f.sqlite.close();
});

test('CN, Certified and unauthorized sales account return 403 before and after delivery', async () => {
  const f = await fixture(); await f.ship();
  for (const user of ['cn', 'cert', 'other']) assert.equal((await f.deliver(user)).status, 403);
  await f.deliver();
  for (const user of ['cn', 'cert', 'other']) assert.equal((await f.deliver(user)).status, 403);
  f.sqlite.close();
});

test('only shipped order with fulfilled, in-transit shipment can be delivered', async () => {
  const f = await fixture(); assert.equal((await f.deliver()).status, 409); f.sqlite.close();
  for (const mutation of ["UPDATE orders SET status = 'cancelled'", "UPDATE orders SET fulfilment_warehouse_id = 'wh-cn-sd'", "UPDATE international_asset_allocations SET status = 'released'", "UPDATE asset_locations SET custody = 'WAREHOUSE'", "UPDATE asset_locations SET status = 'on_hand'", "DELETE FROM asset_events WHERE event_type = 'customer_shipped'"]) {
    const f = await fixture(); await f.ship(); f.sqlite.exec(mutation);
    assert.ok([403, 409].includes((await f.deliver()).status), mutation);
    assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM asset_events WHERE event_type = 'customer_delivered'`).get().n, 0); f.sqlite.close();
  }
});

test('transaction race rejects stale state without partial delivery', async () => {
  const f = await fixture(); await f.ship(); const batch = f.db.batch;
  f.db.batch = async (statements) => { f.sqlite.exec("UPDATE international_asset_allocations SET status = 'released'"); return batch(statements); };
  assert.equal((await f.deliver()).status, 409);
  assert.equal(f.sqlite.prepare('SELECT status, delivered_at FROM orders').get().status, 'shipped');
  assert.equal(f.sqlite.prepare('SELECT delivered_at FROM orders').get().delivered_at, null);
  assert.equal(f.sqlite.prepare('SELECT custody FROM asset_locations').get().custody, 'IN_TRANSIT');
  f.sqlite.close();
});

test('concurrent duplicate at batch guard returns committed delivery instead of writing twice', async () => {
  const f = await fixture(); await f.ship(); const batch = f.db.batch; let once = false;
  f.db.batch = async (statements) => { if (!once) { once = true; assert.equal((await f.deliver()).status, 200); } return batch(statements); };
  assert.equal((await f.deliver()).status, 200);
  assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM asset_events WHERE event_type = 'customer_delivered'`).get().n, 1);
  f.sqlite.close();
});

test('Certified Delivered activates existing Asset internal warranty with exact delivery timestamp and source metadata', async () => {
  const f = await fixture(); f.certify(); await f.ship();
  const response = await f.deliver(); assert.equal(response.status, 200); const result = await response.json();
  const warranty = result.certifiedWarranty;
  assert.equal(warranty.status, 'active'); assert.equal(warranty.policyCode, 'MAXCINE_CERTIFIED_STANDARD_12M');
  assert.equal(warranty.start, result.deliveredAt); assert.equal(warranty.end, certifiedWarrantyEnd(result.deliveredAt));
  assert.equal(warranty.sourceOrderId, 'order-test'); assert.equal(warranty.marketRegion, 'UK');
  assert.equal(warranty.activationSource, 'sale_delivery'); assert.ok(warranty.activatedAt);
  const event = f.sqlite.prepare(`SELECT related_order_id, new_value_json FROM asset_events WHERE event_type = 'warranty_activated'`).get();
  const metadata = JSON.parse(event.new_value_json); assert.equal(metadata.policy_code, warranty.policyCode); assert.equal(metadata.source_order_id, 'order-test');
  assert.equal(metadata.start_date, warranty.start); assert.equal(metadata.end_date, warranty.end); assert.equal(metadata.market_region, 'UK');
  assert.equal(f.sqlite.prepare('SELECT certified_warranty_eligibility AS eligibility FROM orders').get().eligibility, 'activated');
  assert.equal((await (await f.request('uk', '/international/orders/order-test')).json()).order.certifiedWarranty.status, 'active');
  assert.equal((await (await f.request('uk', '/international/assets/43000000-0000-4000-8000-000000000099')).json()).certifiedWarranty.sourceOrderId, 'order-test');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM asset_public_warranties').get().n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM asset_public_warranty_entitlements').get().n, 0);
  f.sqlite.close();
});

test('Certified delivery retries are idempotent, preserve dates and produce one activation and audit only', async () => {
  const f = await fixture(); f.certify(); await f.ship(); const first = await (await f.deliver()).json();
  for (let i = 0; i < 3; i++) assert.deepEqual(await (await f.deliver()).json(), first);
  assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM assets WHERE warranty_source_order_id = 'order-test'`).get().n, 1);
  for (const type of ['customer_delivered', 'warranty_activated']) assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM asset_events WHERE event_type = ?').get(type).n, 1);
  assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'international.warranty.activate'`).get().n, 1);
  const manual = await f.request('uk', '/international/assets/43000000-0000-4000-8000-000000000099/warranty-activate', { startDate: '2026-01-01', endDate: '2027-01-01' });
  assert.equal(manual.status, 409);
  assert.equal(f.sqlite.prepare('SELECT warranty_start_at AS start FROM assets').get().start, first.deliveredAt);
  f.sqlite.close();
});

test('activation leaves a pre-existing Public Warranty and its entitlements completely unchanged', async () => {
  const f = await fixture(); f.certify(); await f.ship();
  f.sqlite.exec(`INSERT INTO asset_public_warranties (id, asset_id, serial_number_snapshot, public_warranty_start_date, public_warranty_end_date, public_note)
    VALUES ('public-existing', '43000000-0000-4000-8000-000000000099', 'TEST-PUBLIC-SN', '2025-01-01', '2025-04-01', 'existing projection');
    INSERT INTO asset_public_warranty_entitlements (id, public_warranty_id, entitlement_type, display_name)
    VALUES ('entitlement-existing', 'public-existing', 'standard', 'Existing entitlement');`);
  const before = f.sqlite.prepare('SELECT * FROM asset_public_warranties').all();
  const entitlements = f.sqlite.prepare('SELECT * FROM asset_public_warranty_entitlements').all();
  assert.equal((await f.deliver()).status, 200);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM asset_public_warranties').all(), before);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM asset_public_warranty_entitlements').all(), entitlements);
  f.sqlite.close();
});

test('Non-Certified delivery persists clear ineligibility without later changing the original decision', async () => {
  const f = await fixture(); await f.ship(); const first = await (await f.deliver()).json();
  assert.equal(first.status, 'delivered'); assert.equal(first.certifiedWarranty.status, 'not_activated');
  assert.match(first.certifiedWarranty.reason, /没有 MaxCINE Certification/);
  f.certify(); assert.deepEqual(await (await f.deliver()).json(), first);
  assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM asset_events WHERE event_type = 'warranty_activated'`).get().n, 0);
  f.sqlite.close();
});

test('invalid/revoked/suspended/Parts certification and manual warranty restrictions do not break ordinary delivery', async () => {
  for (const mutation of ["UPDATE asset_certifications SET certification_status = 'revoked'", "UPDATE asset_certifications SET certification_status = 'suspended'", "UPDATE asset_certifications SET final_qc = 0", "UPDATE asset_certifications SET grade = 'D'", "UPDATE asset_certifications SET inspection_result = 'FAIL'", "UPDATE asset_certifications SET certification_date = '2999-01-01'", "UPDATE assets SET warranty_override_status = 'denied'"]) {
    const f = await fixture(); f.certify(); await f.ship(); f.sqlite.exec(mutation);
    const response = await f.deliver(); assert.equal(response.status, 200); const result = await response.json();
    assert.equal(result.status, 'delivered'); assert.equal(result.certifiedWarranty.status, 'not_activated'); assert.ok(result.certifiedWarranty.reason);
    assert.equal(f.sqlite.prepare('SELECT certified_warranty_policy_code AS policy FROM assets').get().policy, null);
    f.sqlite.close();
  }
});

test('Certified activation cannot be triggered by CN, Certified or unauthorized Sales Account persona', async () => {
  const f = await fixture(); f.certify(); await f.ship();
  for (const user of ['cn', 'cert', 'other']) assert.equal((await f.deliver(user)).status, 403);
  assert.equal(f.sqlite.prepare('SELECT warranty_source_order_id AS source FROM assets').get().source, null);
  assert.equal(f.sqlite.prepare('SELECT status FROM orders').get().status, 'shipped');
  assert.equal((await f.deliver()).status, 200);
  for (const user of ['cn', 'cert', 'other']) assert.equal((await f.deliver(user)).status, 403);
  f.sqlite.close();
});

test('warranty write failure rolls back order, custody, both lifecycle events and audit', async () => {
  const f = await fixture(); f.certify(); await f.ship();
  f.sqlite.exec(`CREATE TRIGGER test_warranty_failure BEFORE UPDATE OF certified_warranty_policy_code ON assets BEGIN SELECT RAISE(ABORT, 'test warranty storage failure'); END;`);
  assert.equal((await f.deliver()).status, 500);
  assert.equal(f.sqlite.prepare('SELECT status FROM orders').get().status, 'shipped');
  assert.equal(f.sqlite.prepare('SELECT custody FROM asset_locations').get().custody, 'IN_TRANSIT');
  assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM asset_events WHERE event_type IN ('customer_delivered','warranty_activated')`).get().n, 0);
  assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action IN ('international.order.deliver','international.warranty.activate')`).get().n, 0);
  f.sqlite.close();
});

test('certification changed between preflight and batch cannot issue an invalid warranty', async () => {
  const f = await fixture(); f.certify(); await f.ship(); const batch = f.db.batch;
  f.db.batch = async (statements) => { f.sqlite.exec("UPDATE asset_certifications SET certification_status = 'revoked'"); return batch(statements); };
  assert.equal((await f.deliver()).status, 409); assert.equal(f.sqlite.prepare('SELECT status FROM orders').get().status, 'shipped');
  f.sqlite.close();
});

test('pre-B-4B1 Delivered recovery uses original delivery time without duplicate delivery event or audit', async () => {
  const f = await fixture(); f.certify(); await f.ship(); await f.deliver();
  // Simulate the previous release: delivery is complete but none of the newly
  // added internal warranty columns or activation records existed yet.
  f.sqlite.exec(`DELETE FROM asset_events WHERE event_type = 'warranty_activated';
    DELETE FROM audit_logs WHERE action = 'international.warranty.activate';
    UPDATE assets SET certified_warranty_policy_code = NULL, warranty_source_order_id = NULL, warranty_market_region = NULL,
      warranty_activation_source = NULL, warranty_activated_at = NULL, warranty_start_at = NULL, warranty_end_at = NULL;
    UPDATE orders SET certified_warranty_eligibility = NULL;`);
  const original = f.sqlite.prepare('SELECT delivered_at AS at FROM orders').get().at;
  const recovered = await f.deliver(); assert.equal(recovered.status, 200); const result = await recovered.json();
  assert.equal(result.deliveredAt, original); assert.equal(result.certifiedWarranty.start, original);
  assert.equal(result.certifiedWarranty.status, 'active');
  assert.deepEqual(await (await f.deliver()).json(), result);
  for (const type of ['customer_delivered', 'warranty_activated']) assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM asset_events WHERE event_type = ?').get(type).n, 1);
  assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'international.order.deliver'`).get().n, 1);
  f.sqlite.close();
});

test('12 calendar months clamp leap-day anniversaries, preserve time, and differ from 365 days', () => {
  assert.equal(certifiedWarrantyEnd('2024-02-29T12:34:56.123Z'), '2025-02-28T12:34:56.123Z');
  assert.equal(certifiedWarrantyEnd('2023-03-01T08:00:00.000Z'), '2024-03-01T08:00:00.000Z');
  assert.equal(certifiedWarrantyEnd('2026-01-31T23:59:59.000Z'), '2027-01-31T23:59:59.000Z');
  assert.throws(() => certifiedWarrantyEnd('not-a-date'));
  const asset = { warrantyStartAt: '2026-10-05T12:00:00.000Z', warrantyEndAt: '2027-10-05T12:00:00.000Z', warrantyOverrideStatus: null };
  assert.equal(warrantyDisplayStatus(asset, new Date('2026-10-05T12:00:00.000Z')), '保修中');
  assert.equal(warrantyDisplayStatus(asset, new Date('2027-10-05T12:00:00.000Z')), '已过保');
});
