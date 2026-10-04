import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import {
  AppError,
  generateAssetCode,
  requireAssetAccess,
  requireInspectionAssignment,
  requireOrderAccess,
  requireRmaAccess,
  requireSalesAccountScope,
  requireWarehouseScope
} from '../packages/shared/dist/index.js';

const workspace = (code, dataScope) => ({ code, name: code, defaultRoute: '/', dataScope, isDefault: true });
const user = ({ id, roles, permissions, workspaces }) => ({
  id,
  email: `${id}@example.test`,
  name: id,
  role: roles[0],
  dealerId: null,
  roles,
  permissions,
  dealerIds: [],
  serviceCenterIds: [],
  storeIds: [],
  sessionVersion: 1,
  mustChangePassword: false,
  watermarkEnabled: false,
  workspaces
});

const uk = user({ id: 'uk-a', roles: ['uk_fulfilment_operator'], permissions: ['transfer:manage', 'international-order:manage', 'international-after-sales:manage'], workspaces: [workspace('UK_FULFILMENT', { warehouseIds: ['wh-uk'], salesAccountIds: ['account-uk'], marketRegions: ['UK'] })] });
const cn = user({ id: 'cn-a', roles: ['warehouse_manager'], permissions: ['transfer:manage'], workspaces: [workspace('WAREHOUSE', { warehouseIds: ['wh-cn-sd'], marketRegions: ['CN'] })] });
const certifiedA = user({ id: 'cert-a', roles: ['certified_operator'], permissions: ['certified:read', 'certified:manage'], workspaces: [workspace('CERTIFIED', {})] });
const ordinary = user({ id: 'ordinary', roles: ['dealer'], permissions: [], workspaces: [] });

function expect403(callback) {
  assert.throws(callback, (error) => error instanceof AppError && error.status === 403);
}

test('Phase 1.2A scope helpers reject cross-warehouse, cross-assignee and cross-account writes with 403', () => {
  expect403(() => requireWarehouseScope(uk, 'wh-cn-sd'));
  expect403(() => requireWarehouseScope(cn, 'wh-uk'));
  expect403(() => requireInspectionAssignment(certifiedA, 'cert-b'));
  expect403(() => requireSalesAccountScope(uk, 'account-not-authorized'));
  expect403(() => requireOrderAccess(uk, { salesAccountId: 'account-not-authorized', fulfilmentWarehouseId: 'wh-uk' }));
  expect403(() => requireAssetAccess(ordinary, { warehouseId: 'wh-uk', salesAccountId: 'account-uk' }));
  expect403(() => requireRmaAccess(uk, {
    salesAccountId: 'account-uk',
    fulfilmentWarehouseId: 'wh-uk',
    assetWarehouseId: 'wh-uk',
    returnWarehouseId: 'wh-cn-sd',
    marketRegion: 'CN',
    scopedWarehouseRegions: ['UK']
  }));
  assert.doesNotThrow(() => requireWarehouseScope(uk, 'wh-uk'));
  assert.doesNotThrow(() => requireInspectionAssignment(certifiedA, 'cert-a'));
  assert.doesNotThrow(() => requireOrderAccess(uk, { salesAccountId: 'account-uk', fulfilmentWarehouseId: 'wh-uk' }));
});

test('Asset Code is deterministic, human-readable and independent from SN', () => {
  const assetId = '41000000-0000-4000-8000-000000000182';
  const beforeSnChange = generateAssetCode({ assetId, productCode: 'P4P', createdAt: new Date('2026-10-04T00:00:00Z') });
  const afterSnChange = generateAssetCode({ assetId, productCode: 'P4P', createdAt: new Date('2026-10-04T00:00:00Z') });
  assert.equal(beforeSnChange, 'MC-26-P4P-000000000182');
  assert.equal(afterSnChange, beforeSnChange);
});

function migratedDatabase(beforePhase12a) {
  const database = new DatabaseSync(':memory:');
  const migrationRoot = new URL('../apps/api/migrations/', import.meta.url);
  for (const filename of readdirSync(migrationRoot).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort()) {
    if (filename.startsWith('0030_') && beforePhase12a) beforePhase12a(database);
    database.exec(readFileSync(new URL(filename, migrationRoot), 'utf8'));
  }
  database.exec('PRAGMA foreign_keys = OFF');
  return database;
}

test('0030 enforces Asset Code uniqueness while SN remains mutable', () => {
  const database = migratedDatabase();
  database.prepare(`INSERT INTO assets (id, asset_code, current_sn) VALUES (?, ?, ?)`).run('asset-a', 'MC-26-P4P-000001', 'SN-A');
  assert.throws(() => database.prepare(`INSERT INTO assets (id, current_sn) VALUES (?, ?)`).run('asset-no-code', 'SN-NO-CODE'), /asset_code is required/);
  assert.throws(() => database.prepare(`INSERT INTO assets (id, asset_code, current_sn) VALUES (?, ?, ?)`).run('asset-b', 'MC-26-P4P-000001', 'SN-B'), /UNIQUE/);
  database.prepare(`UPDATE assets SET current_sn = ? WHERE id = ?`).run('SN-A-REPLACED', 'asset-a');
  assert.equal(database.prepare(`SELECT asset_code AS assetCode FROM assets WHERE id = ?`).get('asset-a').assetCode, 'MC-26-P4P-000001');
  database.close();
});

test('0030 preserves old Staging lifecycle rows while converting international machine types', () => {
  const database = migratedDatabase((legacy) => {
    legacy.exec(`PRAGMA foreign_keys = OFF;
      INSERT INTO assets (id, current_sn, created_at) VALUES ('asset-legacy', 'MC-P4P-000182', '2026-09-30 00:00:00');
      INSERT INTO asset_events (id, asset_id, event_type, title, source, occurred_at)
        VALUES ('legacy-transfer', 'asset-legacy', 'shipped', '国际调拨已创建', 'international-v1', '2026-09-30 01:00:00');
      INSERT INTO asset_events (id, asset_id, event_type, title, source, occurred_at)
        VALUES ('legacy-domestic', 'asset-legacy', 'shipped', '国内订单发货', '订单履约', '2026-09-30 02:00:00');`);
  });
  const rows = database.prepare(`SELECT id, event_type AS eventType, title, occurred_at AS occurredAt FROM asset_events WHERE asset_id = 'asset-legacy' ORDER BY occurred_at`).all();
  assert.deepEqual(rows.map((row) => row.eventType), ['transfer_created', 'shipped']);
  assert.equal(rows[0].title, '国际调拨已创建');
  assert.equal(rows[0].occurredAt, '2026-09-30 01:00:00');
  assert.equal(database.prepare(`SELECT asset_code AS assetCode FROM assets WHERE id = 'asset-legacy'`).get().assetCode, 'MC-26-P4P-000182');
  database.close();
});

test('Listing history coexists while only one effective Listing is allowed', () => {
  const database = migratedDatabase();
  database.prepare(`INSERT INTO assets (id, asset_code) VALUES (?, ?)`).run('asset-listing', 'MC-26-LIST-000001');
  const insert = database.prepare(`INSERT INTO marketplace_listings (id, asset_id, channel_id, sales_account_id, title, price_minor, status) VALUES (?, 'asset-listing', 'channel', 'account', ?, 100, ?)`);
  insert.run('listing-1', 'First', 'active');
  assert.throws(() => insert.run('listing-2', 'Second', 'active'), /UNIQUE/);
  database.prepare(`UPDATE marketplace_listings SET status = 'sold', ended_at = CURRENT_TIMESTAMP WHERE id = 'listing-1'`).run();
  insert.run('listing-2', 'Second', 'active');
  database.prepare(`UPDATE marketplace_listings SET status = 'cancelled', ended_at = CURRENT_TIMESTAMP WHERE id = 'listing-2'`).run();
  insert.run('listing-3', 'Third', 'active');
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM marketplace_listings WHERE asset_id = 'asset-listing'`).get().count, 3);
  database.close();
});

test('Allocation history retains fulfilled/released rows and permits only one active reservation', () => {
  const database = migratedDatabase();
  database.prepare(`INSERT INTO assets (id, asset_code) VALUES (?, ?)`).run('asset-allocation', 'MC-26-ALLOC-000001');
  const insert = database.prepare(`INSERT INTO international_asset_allocations (allocation_id, asset_id, order_id, status) VALUES (?, 'asset-allocation', ?, 'reserved')`);
  insert.run('allocation-1', 'order-1');
  assert.throws(() => insert.run('allocation-2', 'order-2'), /UNIQUE/);
  database.prepare(`UPDATE international_asset_allocations SET status = 'released', released_at = CURRENT_TIMESTAMP WHERE allocation_id = 'allocation-1'`).run();
  insert.run('allocation-2', 'order-2');
  database.prepare(`UPDATE international_asset_allocations SET status = 'fulfilled', fulfilled_at = CURRENT_TIMESTAMP WHERE allocation_id = 'allocation-2'`).run();
  insert.run('allocation-3', 'order-3');
  assert.deepEqual(database.prepare(`SELECT status FROM international_asset_allocations WHERE asset_id = 'asset-allocation' ORDER BY allocation_id`).all().map((row) => row.status), ['released', 'fulfilled', 'reserved']);
  database.close();
});

test('Lifecycle accepts precise Phase 1.2A event types and Inspection assignment is distinct from start', () => {
  const database = migratedDatabase();
  database.prepare(`INSERT INTO assets (id, asset_code) VALUES (?, ?)`).run('asset-events', 'MC-26-EVENT-000001');
  database.prepare(`INSERT INTO asset_events (id, asset_id, event_type, title) VALUES ('event-1', 'asset-events', 'inspection_assigned', 'Assigned')`).run();
  database.prepare(`INSERT INTO asset_events (id, asset_id, event_type, title) VALUES ('event-2', 'asset-events', 'inspection_started', 'Started')`).run();
  database.prepare(`INSERT INTO asset_events (id, asset_id, event_type, title) VALUES ('event-3', 'asset-events', 'customer_delivered', 'Delivered')`).run();
  assert.throws(() => database.prepare(`INSERT INTO asset_events (id, asset_id, event_type, title) VALUES ('event-x', 'asset-events', 'title_inference', 'Invalid')`).run(), /CHECK/);
  database.prepare(`INSERT INTO asset_inspection_tasks (id, asset_id, status) VALUES ('task-1', 'asset-events', 'assigned')`).run();
  assert.equal(database.prepare(`SELECT status, started_at AS startedAt FROM asset_inspection_tasks WHERE id = 'task-1'`).get().startedAt, null);
  database.prepare(`UPDATE asset_inspection_tasks SET status = 'in_progress', started_at = CURRENT_TIMESTAMP WHERE id = 'task-1'`).run();
  const started = database.prepare(`SELECT status, started_at AS startedAt FROM asset_inspection_tasks WHERE id = 'task-1'`).get();
  assert.equal(started.status, 'in_progress');
  assert.ok(started.startedAt);
  database.prepare(`INSERT INTO asset_locations (asset_id, warehouse_id, status, custody) VALUES ('asset-events', 'wh-uk', 'on_hand', 'WAREHOUSE')`).run();
  database.prepare(`UPDATE asset_locations SET status = 'in_transit', custody = 'IN_TRANSIT' WHERE asset_id = 'asset-events'`).run();
  database.prepare(`UPDATE asset_locations SET status = 'shipped', custody = 'CUSTOMER' WHERE asset_id = 'asset-events'`).run();
  assert.equal(database.prepare(`SELECT custody FROM asset_locations WHERE asset_id = 'asset-events'`).get().custody, 'CUSTOMER');
  database.close();
});

test('International write routes call centralized scope helpers and write precise lifecycle types', () => {
  const source = readFileSync(new URL('../apps/api/src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /requireWarehouseScope\(user, input\.fromWarehouseId\)/);
  assert.match(source, /requireWarehouseScope\(user, action === 'ship' \? transfer\.fromWarehouseId : transfer\.toWarehouseId\)/);
  assert.match(source, /requireOrderAccess\(c\.env\.DB, user, c\.req\.param\('id'\)\)/);
  assert.match(source, /requireRmaAccess\(c\.env\.DB, user, c\.req\.param\('id'\)/);
  assert.match(source, /\/certified\/tasks\/:id\/start/);
  for (const eventType of ['inspection_assigned', 'inspection_started', 'transfer_created', 'transfer_shipped', 'transfer_received', 'listing_created', 'listing_activated', 'listing_cancelled', 'asset_reserved', 'allocation_released', 'customer_shipped', 'customer_delivered', 'sale_completed', 'warranty_activated', 'rma_opened']) {
    assert.match(source, new RegExp(`'${eventType}'`));
  }
});

test('Warehouse and UK transfer roles reach server-side warehouse scope checks', () => {
  const migration = readFileSync(new URL('../apps/api/migrations/0031_phase1_2a_transfer_role_grants.sql', import.meta.url), 'utf8');
  assert.match(migration, /warehouse_manager/);
  assert.match(migration, /uk_fulfilment_operator/);
  assert.match(migration, /transfer:manage/);
  expect403(() => requireWarehouseScope(uk, 'wh-cn-sd'));
  expect403(() => requireWarehouseScope(cn, 'wh-uk'));
});
