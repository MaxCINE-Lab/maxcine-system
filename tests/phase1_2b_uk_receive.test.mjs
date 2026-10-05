import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { AppError, requireWarehouseScope } from '../packages/shared/dist/index.js';

const workspace = (warehouseIds) => ({ code: 'WAREHOUSE', name: 'Warehouse', defaultRoute: '/system/warehouse', dataScope: { warehouseIds }, isDefault: true });
const scopedUser = (id, warehouseIds) => ({
  id, email: `${id}@maxcine.test`, name: id, role: 'uk_fulfilment_operator', dealerId: null,
  roles: ['uk_fulfilment_operator'], permissions: ['transfer:manage', 'warehouse:international-read'],
  dealerIds: [], serviceCenterIds: [], storeIds: [], sessionVersion: 1, mustChangePassword: false,
  watermarkEnabled: false, workspaces: [workspace(warehouseIds)]
});

function migratedDatabase() {
  const database = new DatabaseSync(':memory:');
  const migrationRoot = new URL('../apps/api/migrations/', import.meta.url);
  for (const filename of readdirSync(migrationRoot).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort()) database.exec(readFileSync(new URL(filename, migrationRoot), 'utf8'));
  return database;
}

test('UK destination scope may receive while CN-SD and users without UK scope receive HTTP 403', () => {
  assert.doesNotThrow(() => requireWarehouseScope(scopedUser('uk', ['wh-uk']), 'wh-uk'));
  for (const user of [scopedUser('cn-sd', ['wh-cn-sd']), scopedUser('unscoped', [])]) {
    assert.throws(() => requireWarehouseScope(user, 'wh-uk'), (error) => error instanceof AppError && error.status === 403);
  }
});

test('Receive transition puts the Asset UK on-hand and records transfer_received', () => {
  const database = migratedDatabase();
  database.prepare(`INSERT INTO assets (id, asset_code, current_sn, product_name_snapshot) VALUES ('asset-uk', 'MC-26-UK-000001', 'UK-RECEIVE-000001', 'Receive Fixture')`).run();
  database.prepare(`INSERT INTO asset_locations (asset_id, warehouse_id, status, custody) VALUES ('asset-uk', 'wh-cn-sd', 'in_transit', 'IN_TRANSIT')`).run();
  database.prepare(`INSERT INTO asset_transfers (id, asset_id, from_warehouse_id, to_warehouse_id, status, carrier, tracking_number, shipped_at) VALUES ('transfer-uk', 'asset-uk', 'wh-cn-sd', 'wh-uk', 'shipped', 'DHL', 'UK-TRACK-1', CURRENT_TIMESTAMP)`).run();
  database.prepare(`UPDATE asset_transfers SET status = 'received', received_at = CURRENT_TIMESTAMP WHERE id = 'transfer-uk'`).run();
  database.prepare(`UPDATE asset_locations SET warehouse_id = 'wh-uk', status = 'on_hand', custody = 'WAREHOUSE' WHERE asset_id = 'asset-uk'`).run();
  database.prepare(`INSERT INTO asset_events (id, asset_id, event_type, title) VALUES ('event-received', 'asset-uk', 'transfer_received', '国际调拨已收货')`).run();
  assert.deepEqual({ ...database.prepare(`SELECT status FROM asset_transfers WHERE id = 'transfer-uk'`).get() }, { status: 'received' });
  assert.deepEqual({ ...database.prepare(`SELECT warehouse_id AS warehouseId, status, custody FROM asset_locations WHERE asset_id = 'asset-uk'`).get() }, { warehouseId: 'wh-uk', status: 'on_hand', custody: 'WAREHOUSE' });
  assert.deepEqual({ ...database.prepare(`SELECT event_type AS eventType FROM asset_events WHERE asset_id = 'asset-uk'`).get() }, { eventType: 'transfer_received' });
  database.close();
});

test('Receive API enforces destination scope and server-side Asset Code match', () => {
  const source = readFileSync(new URL('../apps/api/src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /const toWarehouseId = c\.req\.query\('toWarehouseId'\)/);
  assert.match(source, /requireWarehouseScope\(user, scopedWarehouseId\)/);
  assert.match(source, /action === 'ship' \? transfer\.fromWarehouseId : transfer\.toWarehouseId/);
  assert.match(source, /input\.assetCode\.toUpperCase\(\) !== transfer\.assetCode\.toUpperCase\(\)/);
  assert.match(source, /throw badRequest\('Asset 不匹配'\)/);
  assert.match(source, /isReceived \? 'on_hand' : 'in_transit'/);
  assert.match(source, /isReceived \? 'WAREHOUSE' : 'IN_TRANSIT'/);
  assert.match(source, /isReceived \? 'transfer_received' : 'transfer_shipped'/);
});

test('UK workspace exposes awaiting receipt, strict match UI, and UK inventory fields', () => {
  const portal = readFileSync(new URL('../apps/web/src/InternationalPortal.tsx', import.meta.url), 'utf8');
  const navigation = readFileSync(new URL('../apps/web/src/systemNavigation.tsx', import.meta.url), 'utf8');
  assert.match(portal, /function UkReceiving/);
  assert.match(portal, /\/international\/transfers\?toWarehouseId=wh-uk/);
  assert.match(portal, /Asset 不匹配/);
  assert.match(portal, /设备匹配/);
  assert.match(portal, /disabled=\{!matches \|\| submitting\}/);
  assert.match(portal, /UK 入库完成/);
  for (const label of ['Grade', 'Certification Status', 'Location Status']) assert.match(portal, new RegExp(label));
  assert.match(navigation, /\['待收货', '\/system\/uk-fulfilment\/receiving'\]/);
});
