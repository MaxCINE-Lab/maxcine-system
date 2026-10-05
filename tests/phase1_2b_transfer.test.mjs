import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { URL } from 'node:url';
import { AppError, requireWarehouseScope } from '../packages/shared/dist/index.js';

const workspace = (warehouseIds) => ({ code: 'WAREHOUSE', name: 'Warehouse', defaultRoute: '/system/warehouse', dataScope: { warehouseIds }, isDefault: true });
const user = (id, warehouseIds) => ({
  id,
  email: `${id}@maxcine.test`,
  name: id,
  role: 'warehouse_manager',
  dealerId: null,
  roles: ['warehouse_manager'],
  permissions: ['transfer:manage', 'warehouse:international-read'],
  dealerIds: [],
  serviceCenterIds: [],
  storeIds: [],
  sessionVersion: 1,
  mustChangePassword: false,
  watermarkEnabled: false,
  workspaces: [workspace(warehouseIds)]
});

test('CN-SD may ship its transfer while UK remains forbidden by server scope', () => {
  assert.doesNotThrow(() => requireWarehouseScope(user('cn-sd', ['wh-cn-sd']), 'wh-cn-sd'));
  assert.throws(() => requireWarehouseScope(user('uk', ['wh-uk']), 'wh-cn-sd'), (error) => error instanceof AppError && error.status === 403);
});

test('Transfer list and ship routes enforce transfer permission and source warehouse scope', () => {
  const source = readFileSync(new URL('../apps/api/src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /app\.get\('\/international\/transfers'/);
  assert.match(source, /requireWarehouseScope\(user, scopedWarehouseId\)/);
  assert.match(source, /app\.post\('\/international\/transfers\/:id\/:action'/);
  assert.match(source, /requireWarehouseScope\(user, action === 'ship' \? transfer\.fromWarehouseId : transfer\.toWarehouseId\)/);
  assert.match(source, /'transfer_created'/);
  assert.match(source, /'transfer_shipped'/);
  assert.match(source, /isReceived \? 'WAREHOUSE' : 'IN_TRANSIT'/);
});

test('Warehouse UI exposes only the CN-SD create and ship workflow', () => {
  const portal = readFileSync(new URL('../apps/web/src/InternationalPortal.tsx', import.meta.url), 'utf8');
  const warehousePortal = portal.slice(portal.indexOf('function CnSdTransfers'), portal.indexOf('function Listings'));
  const app = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
  const navigation = readFileSync(new URL('../apps/web/src/systemNavigation.tsx', import.meta.url), 'utf8');
  assert.match(portal, /function CnSdTransfers/);
  assert.match(portal, /fromWarehouseId: 'wh-cn-sd', toWarehouseId: 'wh-uk'/);
  assert.match(portal, /\/international\/transfers\/\$\{transfer\.id\}\/ship/);
  assert.match(portal, /CN-SD → UK · In Transit/);
  assert.doesNotMatch(warehousePortal, /确认收货/);
  assert.match(app, /path\.startsWith\('\/system\/warehouse\/transfers'\)/);
  assert.match(navigation, /\['调拨', '\/system\/warehouse\/transfers'\]/);
});
