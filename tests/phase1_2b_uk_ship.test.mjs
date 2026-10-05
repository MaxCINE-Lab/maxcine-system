import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { URL } from 'node:url';
import app from '../apps/api/src/index.ts';
import { createSessionToken } from '../apps/api/src/auth.ts';

async function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  const root = new URL('../apps/api/migrations/', import.meta.url);
  for (const name of readdirSync(root).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort()) sqlite.exec(readFileSync(new URL(name, root), 'utf8'));
  sqlite.exec(`PRAGMA foreign_keys = OFF;
    INSERT INTO sales_accounts (id, channel_id, account_name, market_region) VALUES ('account-test', 'channel-ebay-uk', 'Test account', 'UK');
    INSERT INTO assets (id, asset_code, asset_status) VALUES ('43000000-0000-4000-8000-000000000099', 'MC-26-TEST-000099', 'active');
    INSERT INTO asset_locations (asset_id, warehouse_id, status, custody) VALUES ('43000000-0000-4000-8000-000000000099', 'wh-uk', 'on_hand', 'WAREHOUSE');
    INSERT INTO orders (id, order_no, dealer_id, store_id, created_by, status, channel_id, sales_account_id, fulfilment_warehouse_id, currency) VALUES ('order-test', 'TEST-SHIP', 'dealer', 'store', 'uk', 'approved', 'channel-ebay-uk', 'account-test', 'wh-uk', 'GBP');`);
  for (const [id, role, scope] of [
    ['uk', 'uk_fulfilment_operator', { warehouseIds: ['wh-uk'], salesAccountIds: ['account-test'] }],
    ['cn', 'warehouse_manager', { warehouseIds: ['wh-cn-sd'] }],
    ['cert', 'certified_operator', {}],
    ['other', 'uk_fulfilment_operator', { warehouseIds: ['wh-uk'], salesAccountIds: ['account-other'] }]
  ]) {
    sqlite.prepare(`INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, ?, 'unused', 'warehouse')`).run(id, `${id}@example.test`, id);
    sqlite.prepare(`INSERT INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE code = ?`).run(id, role);
    sqlite.prepare(`INSERT INTO user_workspaces (user_id, workspace_id, data_scope_json) VALUES (?, 'ws-uk-fulfilment', ?)`).run(id, JSON.stringify(scope));
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
  const tokens = {};
  for (const id of ['uk', 'cn', 'cert', 'other']) tokens[id] = await createSessionToken({ id, email: `${id}@example.test`, name: id, sessionVersion: 1 }, env.SESSION_SECRET);
  const request = (user, path, body) => app.request(`https://test.example${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${tokens[user]}`, Origin: env.APP_ORIGIN, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }, env);
  const bind = () => request('uk', '/international/orders/order-test/bind-asset', { assetId: '43000000-0000-4000-8000-000000000099' });
  const ship = (user = 'uk', assetCode = 'MC-26-TEST-000099') => request(user, '/international/orders/order-test/ship', { assetCode, carrier: 'Royal Mail', trackingNumber: 'RM-STG-TEST' });
  return { sqlite, db, request, bind, ship };
}

test('normal bind + UK ship preserves history, tracking, audit and lifecycle and removes queue/inventory', async () => {
  const f = await fixture();
  assert.equal((await f.bind()).status, 200);
  assert.equal(f.sqlite.prepare('SELECT status FROM asset_locations').get().status, 'on_hand');
  assert.equal((await (await f.request('uk', '/international/orders')).json()).orders.length, 1);
  const detail = await (await f.request('uk', '/international/orders/order-test')).json();
  assert.equal(detail.order.canShip, 1);
  assert.equal((await f.ship()).status, 200);
  const order = f.sqlite.prepare('SELECT status, fulfillment_carrier, fulfillment_tracking_number FROM orders').get();
  assert.equal(order.status, 'shipped'); assert.equal(order.fulfillment_carrier, 'Royal Mail'); assert.equal(order.fulfillment_tracking_number, 'RM-STG-TEST');
  assert.equal(f.sqlite.prepare('SELECT status FROM international_asset_allocations').get().status, 'fulfilled');
  assert.deepEqual({ ...f.sqlite.prepare('SELECT custody, status FROM asset_locations').get() }, { custody: 'IN_TRANSIT', status: 'in_transit' });
  const event = f.sqlite.prepare(`SELECT related_order_id, new_value_json FROM asset_events WHERE event_type = 'customer_shipped'`).get();
  assert.equal(event.related_order_id, 'order-test'); assert.equal(JSON.parse(event.new_value_json).trackingNumber, 'RM-STG-TEST');
  assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'international.order.ship'`).get().n, 1);
  assert.equal((await (await f.request('uk', '/international/orders')).json()).orders.length, 0);
  assert.equal((await (await f.request('uk', '/international/warehouses/assets?warehouseId=wh-uk')).json()).assets.length, 0);
  assert.equal((await f.ship()).status, 409);
  assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM asset_events WHERE event_type = 'customer_shipped'`).get().n, 1);
  f.sqlite.close();
});

test('wrong Asset Code and missing Carrier/Tracking cannot mutate shipment state', async () => {
  const f = await fixture(); await f.bind();
  assert.equal((await f.ship('uk', 'MC-WRONG-000000')).status, 400);
  assert.equal((await f.request('uk', '/international/orders/order-test/ship', { assetCode: 'MC-26-TEST-000099', carrier: ' ', trackingNumber: '' })).status, 400);
  assert.equal(f.sqlite.prepare('SELECT status FROM orders').get().status, 'approved');
  assert.equal(f.sqlite.prepare('SELECT status FROM international_asset_allocations').get().status, 'reserved');
  f.sqlite.close();
});

test('CN, Certified and unauthorized sales account requests return HTTP 403', async () => {
  const f = await fixture(); await f.bind();
  for (const user of ['cn', 'cert', 'other']) assert.equal((await f.ship(user)).status, 403);
  assert.equal((await f.request('other', '/international/orders/order-test')).status, 403);
  assert.equal((await (await f.request('other', '/international/orders')).json()).orders.length, 0);
  f.sqlite.close();
});

test('warehouse, custody, allocation, order, transfer and service state violations block ship', async () => {
  for (const mutation of [
    `UPDATE asset_locations SET warehouse_id = 'wh-cn-sd'`,
    `UPDATE asset_locations SET custody = 'IN_TRANSIT'`,
    `UPDATE asset_locations SET status = 'reserved'`,
    `UPDATE international_asset_allocations SET status = 'released'`,
    `UPDATE orders SET status = 'draft'`,
    `UPDATE orders SET fulfilment_warehouse_id = 'wh-cn-sd'`,
    `INSERT INTO asset_transfers (id, asset_id, from_warehouse_id, to_warehouse_id, status) VALUES ('transfer', '43000000-0000-4000-8000-000000000099', 'wh-uk', 'wh-cn-sd', 'created')`,
    `UPDATE assets SET asset_status = 'in_service'`,
    `INSERT INTO after_sales_cases (id, case_no, dealer_id, subject, description, created_by, asset_id) VALUES ('rma', 'TEST-RMA', 'dealer', 'RMA', 'Test', 'uk', '43000000-0000-4000-8000-000000000099')`
  ]) {
    const f = await fixture(); await f.bind(); f.sqlite.exec(mutation);
    const response = await f.ship(); assert.ok([403, 409].includes(response.status), `${mutation}: ${response.status}`);
    assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM asset_events WHERE event_type = 'customer_shipped'`).get().n, 0);
    f.sqlite.close();
  }
});

test('transaction guard rejects state changed after preflight without partial shipment writes', async () => {
  const f = await fixture(); await f.bind();
  const batch = f.db.batch;
  f.db.batch = async (statements) => {
    f.sqlite.exec(`UPDATE international_asset_allocations SET status = 'released'`);
    return batch(statements);
  };
  assert.equal((await f.ship()).status, 409);
  assert.equal(f.sqlite.prepare('SELECT status FROM orders').get().status, 'approved');
  assert.equal(f.sqlite.prepare('SELECT custody FROM asset_locations').get().custody, 'WAREHOUSE');
  assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM asset_events WHERE event_type = 'customer_shipped'`).get().n, 0);
  f.sqlite.close();
});
