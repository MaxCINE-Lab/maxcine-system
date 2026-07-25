import assert from 'node:assert/strict';
import test from 'node:test';
import { can, canReadOrder, canTransitionOrder } from '../packages/shared/dist/index.js';

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
