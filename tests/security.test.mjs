import assert from 'node:assert/strict';
import test from 'node:test';
import { can, canReadOrder, canTransitionOrder, createAfterSalesSchema, createOrderSchema } from '../packages/shared/dist/index.js';

const dealerA = { id: 'dealer-a', email: 'a@example.test', name: 'Dealer A', role: 'dealer', dealerId: 'dealer-a-id' };
const dealerB = { id: 'dealer-b', email: 'b@example.test', name: 'Dealer B', role: 'dealer', dealerId: 'dealer-b-id' };
const warehouse = { id: 'warehouse', email: 'warehouse@example.test', name: 'Warehouse', role: 'warehouse', dealerId: null };
const admin = { id: 'admin', email: 'admin@example.test', name: 'Admin', role: 'admin', dealerId: null };

test('dealer cannot read another dealer’s order', () => {
  const otherDealerOrder = { dealerId: dealerB.dealerId, status: 'submitted' };
  assert.equal(canReadOrder(dealerA, otherDealerOrder), false);
  assert.equal(canReadOrder(dealerB, otherDealerOrder), true);
});

test('warehouse cannot read drafts or unapproved orders', () => {
  assert.equal(canReadOrder(warehouse, { dealerId: dealerA.dealerId, status: 'draft' }), false);
  assert.equal(canReadOrder(warehouse, { dealerId: dealerA.dealerId, status: 'submitted' }), false);
  assert.equal(canReadOrder(warehouse, { dealerId: dealerA.dealerId, status: 'approved' }), true);
});

test('role escalation is blocked for administrator-only operations', () => {
  assert.equal(can(dealerA, 'user:manage'), false);
  assert.equal(can(warehouse, 'inventory:manage'), false);
  assert.equal(can(admin, 'audit:read'), true);
});

test('order state transitions are controlled by role', () => {
  assert.equal(canTransitionOrder('dealer', 'draft', 'submitted'), true);
  assert.equal(canTransitionOrder('dealer', 'submitted', 'approved'), false);
  assert.equal(canTransitionOrder('warehouse', 'approved', 'picking'), true);
  assert.equal(canTransitionOrder('warehouse', 'packed', 'shipped'), true);
  assert.equal(canTransitionOrder('warehouse', 'draft', 'picking'), false);
});

test('order validation rejects zero quantity and normalizes an omitted note', () => {
  const valid = createOrderSchema.parse({ storeId: '30000000-0000-4000-8000-000000000001', items: [{ productId: '40000000-0000-4000-8000-000000000001', quantity: 1 }] });
  assert.equal(valid.note, '');
  assert.equal(createOrderSchema.safeParse({ storeId: valid.storeId, items: [{ productId: valid.items[0].productId, quantity: 0 }] }).success, false);
});

test('after-sales validation requires the dealer-facing contact and case fields', () => {
  const valid = createAfterSalesSchema.safeParse({ storeId: '30000000-0000-4000-8000-000000000001', caseType: '产品异常', subject: '本地测试问题', description: '这是满足最短长度的本地测试问题描述。', contactName: '本地测试联系人', contactPhone: '00000000000' });
  assert.equal(valid.success, true);
  assert.equal(createAfterSalesSchema.safeParse({ storeId: '30000000-0000-4000-8000-000000000001', caseType: '产品异常', subject: '问题', description: '描述过短', contactName: '', contactPhone: '' }).success, false);
});
