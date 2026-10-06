import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import app from '../../apps/api/src/index.ts';
import { createSessionToken } from '../../apps/api/src/auth.ts';
const { FormData } = globalThis;

export async function deliveryFixture(options = {}) {
  const sqlite = new DatabaseSync(':memory:');
  const root = new URL('../../apps/api/migrations/', import.meta.url);
  for (const name of readdirSync(root).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort()) sqlite.exec(readFileSync(new URL(name, root), 'utf8'));
  sqlite.exec(`PRAGMA foreign_keys = OFF;
    INSERT INTO sales_accounts (id, channel_id, account_name, market_region) VALUES ('account-test', 'channel-ebay-uk', 'Test account', 'UK');
    INSERT INTO assets (id, asset_code, asset_status) VALUES ('43000000-0000-4000-8000-000000000099', 'MC-26-TEST-000099', 'active');
    INSERT INTO asset_locations (asset_id, warehouse_id) VALUES ('43000000-0000-4000-8000-000000000099', 'wh-uk');
    INSERT INTO orders (id, order_no, dealer_id, store_id, created_by, status, channel_id, sales_account_id, fulfilment_warehouse_id, external_order_id)
      VALUES ('order-test', 'TEST-DELIVERY', 'dealer', 'store', 'uk', 'approved', 'channel-ebay-uk', 'account-test', 'wh-uk', 'EXT-DELIVERY');`);
  // The legacy administrator role is normally created by the application seed,
  // not migrations. Supply its existing grants in this isolated fixture only.
  sqlite.exec(`INSERT OR IGNORE INTO permissions (code, name) VALUES ('data:read:all', 'Global data read');
    INSERT OR IGNORE INTO roles (id, code, name) VALUES ('role-test-admin', 'super_admin', 'Test admin');
    INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
      SELECT roles.id, permissions.code FROM roles CROSS JOIN permissions
      WHERE roles.code = 'super_admin' AND permissions.code IN ('asset:read','asset:manage','data:read:all');`);
  const tokens = {};
  for (const [user, role, scope] of [
    ['uk', 'uk_fulfilment_operator', { warehouseIds: ['wh-uk'], salesAccountIds: ['account-test'] }],
    ['cn', 'warehouse_manager', { warehouseIds: ['wh-cn-sd'] }],
    ['cert', 'certified_operator', {}],
    ['other', 'uk_fulfilment_operator', { warehouseIds: ['wh-uk'], salesAccountIds: ['account-other'] }],
    ['admin', 'super_admin', {}],
    ['intl', 'international_operator', { warehouseIds: ['wh-uk'], salesAccountIds: ['account-test'], marketRegions: ['UK'] }],
    ['wrongWarehouse', 'uk_fulfilment_operator', { warehouseIds: ['wh-sg'], salesAccountIds: ['account-test'] }],
    ['wrongMarket', 'uk_fulfilment_operator', { warehouseIds: ['wh-uk'], salesAccountIds: ['account-test'], marketRegions: ['SG'] }]
  ]) {
    sqlite.prepare(`INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, ?, 'unused', ?)`).run(user, `${user}@example.test`, user, user === 'admin' ? 'admin' : 'warehouse');
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
  const env = { DB: db, ASSETS: options.assets, SESSION_SECRET: 'test-only-session-secret', APP_ORIGIN: 'https://test.example', APP_ENV: 'staging' };
  const request = (user, path, body, method = body ? 'POST' : 'GET') => app.request(`https://test.example${path}`, { method, headers: { Authorization: `Bearer ${tokens[user]}`, Origin: env.APP_ORIGIN, ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) }, ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}) }, env);
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
