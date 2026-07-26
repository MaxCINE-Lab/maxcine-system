import assert from 'node:assert/strict';
import test from 'node:test';
import { can, canAccessStore, canReadOrder, canTransitionOrder, createAfterSalesSchema, createOrderSchema, loginSchema } from '../packages/shared/dist/index.js';

function user({ id, permissions = [], storeIds = [], serviceCenterIds = [], roles = [] }) {
  return { id, email: `${id}@example.test`, name: id, permissions, storeIds, serviceCenterIds, roles, dealerIds: [] };
}

const dealerA = user({ id: 'dealer-a', roles: ['dealer'], storeIds: ['store-a'], permissions: ['order:read', 'order:create', 'order:submit', 'after-sales:create', 'after-sales:read', 'notifications:read'] });
const dealerB = user({ id: 'dealer-b', roles: ['dealer'], storeIds: ['store-b'], permissions: ['order:read', 'order:create', 'order:submit', 'after-sales:create', 'after-sales:read', 'notifications:read'] });
const warehouse = user({ id: 'warehouse', roles: ['warehouse_manager'], permissions: ['order:warehouse-read', 'order:fulfill', 'inventory:read', 'inventory:warehouse-manage', 'notifications:read'] });
const superAdmin = user({ id: 'super-admin', roles: ['super_admin'], permissions: ['data:read:all', 'user:manage', 'audit:read', 'after-sales:approve'] });
const serviceCenter = user({ id: 'service-center', roles: ['authorized_service_center'], serviceCenterIds: ['center-a'], permissions: ['after-sales:read', 'after-sales:receive', 'after-sales:damage-assess', 'after-sales:recommend'] });

test('dealer data isolation is based on store assignment rather than email or name', () => {
  assert.equal(canReadOrder(dealerA, { storeId: 'store-b', status: 'submitted' }), false);
  assert.equal(canReadOrder(dealerB, { storeId: 'store-b', status: 'submitted' }), true);
  assert.equal(canReadOrder(superAdmin, { storeId: 'store-b', status: 'submitted' }), true);
  assert.equal(canAccessStore(dealerA, 'store-a'), true);
  assert.equal(canAccessStore(dealerA, 'store-b'), false);
});

test('warehouse can only read orders after they enter the warehouse flow', () => {
  assert.equal(canReadOrder(warehouse, { storeId: 'store-a', status: 'draft' }), false);
  assert.equal(canReadOrder(warehouse, { storeId: 'store-a', status: 'submitted' }), false);
  assert.equal(canReadOrder(warehouse, { storeId: 'store-a', status: 'approved' }), true);
});

test('privileged operations require an effective permission relation', () => {
  assert.equal(can(dealerA, 'user:manage'), false);
  assert.equal(can(warehouse, 'inventory:manage'), false);
  assert.equal(can(warehouse, 'after-sales:read'), false);
  assert.equal(can(serviceCenter, 'after-sales:approve'), false);
  assert.equal(can(superAdmin, 'audit:read'), true);
});

test('order transitions are enforced by permissions, not a single role field', () => {
  assert.equal(canTransitionOrder(dealerA, 'draft', 'submitted'), true);
  assert.equal(canTransitionOrder(dealerA, 'submitted', 'approved'), false);
  assert.equal(canTransitionOrder(warehouse, 'approved', 'picking'), true);
  assert.equal(canTransitionOrder(warehouse, 'packed', 'shipped'), true);
  assert.equal(canTransitionOrder(warehouse, 'draft', 'picking'), false);
});

test('input normalizes account emails to lowercase', () => {
  assert.equal(loginSchema.parse({ email: 'YUKYINCHEW@MAXCINE.CN', password: 'DemoOnly-ChangeMe-2026' }).email, 'yukyinchew@maxcine.cn');
});

test('order and after-sales schemas allow local demo data without contact details', () => {
  const valid = createOrderSchema.parse({ storeId: '30000000-0000-4000-8000-000000000001', items: [{ productId: '40000000-0000-4000-8000-000000000001', quantity: 1 }] });
  assert.equal(valid.note, '');
  assert.equal(createOrderSchema.safeParse({ storeId: valid.storeId, items: [{ productId: valid.items[0].productId, quantity: 0 }] }).success, false);
  assert.equal(createAfterSalesSchema.safeParse({ storeId: valid.storeId, caseType: '产品异常', subject: '本地演示问题', description: '这是满足最短长度的本地演示问题描述。' }).success, true);
});
