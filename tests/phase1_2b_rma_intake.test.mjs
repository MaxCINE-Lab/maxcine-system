import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto as crypto } from 'node:crypto';
import { deliveryFixture } from './helpers/deliveryFixture.mjs';

const assetId = '43000000-0000-4000-8000-000000000099';
const body = () => ({ orderId: 'order-test', assetId, reason: 'DEFECTIVE', reasonNote: 'Customer reports issue', returnWarehouseId: 'wh-uk', carrier: 'Royal Mail', returnTracking: 'RM-RETURN-TEST', idempotencyKey: crypto.randomUUID() });
async function fixture(certified = true) {
  const f = await deliveryFixture(); if (certified) f.certify(); await f.ship(); assert.equal((await f.deliver()).status, 200); return f;
}
const snapshot = (f) => ['assets', 'asset_locations', 'orders', 'asset_public_warranties', 'asset_public_warranty_entitlements'].map((table) => f.sqlite.prepare(`SELECT * FROM ${table}`).all());
const count = (f, table, where = '1') => f.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get().n;
async function open(f, input = body(), user = 'uk') {
  const response = await f.request(user, '/international/rmas', input); assert.equal(response.status, 200, await response.clone().text()); return (await response.json()).rma;
}

test('authorized intake atomically records reference, lifecycle and audit without moving asset or warranty', async () => {
  const f = await fixture(); const before = snapshot(f); const rma = await open(f);
  assert.match(rma.rmaReference, /^MC-RMA-\d{2}-000001$/); assert.equal(rma.status, 'open'); assert.equal(rma.businessStatus, 'RETURN_AUTHORIZED');
  assert.equal(rma.returnWarehouse, 'UK'); assert.equal(rma.reason, 'DEFECTIVE'); assert.equal(rma.warrantySnapshot.status, 'active'); assert.equal(rma.warrantySnapshot.sourceOrderId, 'order-test');
  assert.ok(rma.authorizedAt); assert.deepEqual(snapshot(f), before);
  const event = f.sqlite.prepare("SELECT * FROM asset_events WHERE event_type = 'rma_opened'").get();
  const metadata = JSON.parse(event.new_value_json); assert.equal(metadata.rma_reference, rma.rmaReference); assert.equal(metadata.order_id, 'order-test'); assert.equal(metadata.return_warehouse_id, 'wh-uk'); assert.equal(event.related_service_case_id, rma.id);
  const audit = f.sqlite.prepare("SELECT * FROM audit_logs WHERE action = 'international.rma.open'").get(); assert.equal(audit.actor_id, 'uk'); assert.equal(JSON.parse(audit.after_json).sales_account_id, 'account-test'); assert.ok(!audit.after_json.includes('Customer reports'));
  assert.equal((await f.request('uk', `/international/rmas/${rma.id}`)).status, 200);
  assert.equal((await f.request('uk', '/international/rmas')).status, 200);
  const { order } = await (await f.request('uk', '/international/orders/order-test')).json(); assert.equal(order.canOpenRma, false); assert.equal(order.activeRma.id, rma.id);
});

test('non-certified and restricted warranties do not prevent legitimate returns; optional tracking', async () => {
  for (const certified of [false, true]) {
    const f = await fixture(certified); if (certified) f.sqlite.exec("UPDATE assets SET warranty_override_status = 'cancelled'");
    const before = snapshot(f); const input = body(); delete input.carrier; delete input.returnTracking;
    const rma = await open(f, input, 'intl'); assert.equal(rma.carrier, ''); assert.equal(rma.returnTracking, ''); assert.equal(rma.warrantySnapshot.status, certified ? 'restricted' : 'not_activated'); assert.deepEqual(snapshot(f), before);
  }
});

test('same request is idempotent; changed payload or new request cannot create a second active RMA', async () => {
  const f = await fixture(); const input = body(); const first = await open(f, input);
  for (let n = 0; n < 3; n++) assert.deepEqual(await open(f, input), first);
  assert.equal((await f.request('uk', '/international/rmas', { ...input, reason: 'OTHER' })).status, 409);
  assert.equal((await f.request('uk', '/international/rmas', body())).status, 409);
  assert.equal(count(f, 'after_sales_cases'), 1); assert.equal(count(f, 'asset_events', "event_type = 'rma_opened'"), 1); assert.equal(count(f, 'audit_logs', "action = 'international.rma.open'"), 1);
});

test('CN, Certified, unauthorized Sales Account, wrong Warehouse and explicit wrong Market are 403', async () => {
  const f = await fixture();
  for (const user of ['cn', 'cert', 'other', 'wrongWarehouse', 'wrongMarket']) assert.equal((await f.request(user, '/international/rmas', body())).status, 403, user);
  for (const warehouse of ['wh-cn-sd', 'wh-transit']) assert.equal((await f.request('uk', '/international/rmas', { ...body(), returnWarehouseId: warehouse })).status, 403);
  const rma = await open(f);
  for (const user of ['cn', 'cert', 'other', 'wrongWarehouse', 'wrongMarket']) assert.equal((await f.request(user, `/international/rmas/${rma.id}`)).status, 403, user);
  for (const user of ['other', 'wrongWarehouse', 'wrongMarket']) assert.deepEqual((await (await f.request(user, '/international/rmas')).json()).rmas, []);
});

test('server verifies delivered order, fulfilled allocation, CUSTOMER custody and physical market warehouse', async () => {
  const f = await fixture(); const { context } = await (await f.request('uk', '/international/rmas/intake-context?orderId=order-test')).json(); assert.deepEqual(context.warehouses.map((w) => w.id), ['wh-uk']);
  assert.equal((await f.request('uk', '/international/rmas', { ...body(), assetId: '43000000-0000-4000-8000-000000000098' })).status, 409);
  assert.equal((await f.request('admin', '/international/rmas', { ...body(), returnWarehouseId: 'wh-transit' })).status, 400);
  assert.equal((await f.request('admin', '/international/rmas', { ...body(), returnWarehouseId: 'wh-cn-sd' })).status, 403);
  f.sqlite.exec("UPDATE warehouses SET status = 'inactive' WHERE id = 'wh-uk'"); assert.equal((await f.request('uk', '/international/rmas', body())).status, 400); f.sqlite.exec("UPDATE warehouses SET status = 'active' WHERE id = 'wh-uk'");
  for (const [change, restore] of [
    ["UPDATE orders SET status = 'shipped'", "UPDATE orders SET status = 'delivered'"],
    ["UPDATE asset_locations SET custody = 'IN_TRANSIT'", "UPDATE asset_locations SET custody = 'CUSTOMER'"],
    ["UPDATE international_asset_allocations SET status = 'released'", "UPDATE international_asset_allocations SET status = 'fulfilled'"]
  ]) { f.sqlite.exec(change); assert.equal((await f.request('uk', '/international/rmas', body())).status, 409); f.sqlite.exec(restore); }
  assert.equal(count(f, 'after_sales_cases'), 0);
});

test('strict structured reasons; closed history is preserved with unique readable references', async () => {
  const f = await fixture();
  for (const extra of [{ reason: 'anything' }, { rmaReference: 'manual' }, { refundAmount: 100 }, { reasonNote: 'x'.repeat(1001) }]) assert.equal((await f.request('uk', '/international/rmas', { ...body(), ...extra })).status, 400);
  const references = new Set();
  for (const reason of ['DEFECTIVE', 'DAMAGED', 'NOT_AS_DESCRIBED', 'BUYER_REMORSE', 'WRONG_ITEM', 'OTHER']) {
    const rma = await open(f, { ...body(), reason }); references.add(rma.rmaReference); f.sqlite.prepare("UPDATE after_sales_cases SET status = 'closed' WHERE id = ?").run(rma.id);
  }
  assert.equal(references.size, 6); assert.equal(count(f, 'after_sales_cases'), 6);
});

test('event or audit write failure rolls back whole RMA and does not consume its reference', async () => {
  for (const table of ['asset_events', 'audit_logs']) {
    const f = await fixture(); const before = snapshot(f);
    f.sqlite.exec(`CREATE TRIGGER fail_rma BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'test write failure'); END`);
    assert.equal((await f.request('uk', '/international/rmas', body())).status, 500); assert.equal(count(f, 'after_sales_cases'), 0); assert.equal(count(f, 'asset_events', "event_type = 'rma_opened'"), 0); assert.deepEqual(snapshot(f), before);
    f.sqlite.exec('DROP TRIGGER fail_rma'); assert.match((await open(f)).rmaReference, /000001$/);
  }
});

test('concurrent duplicate retry returns committed RMA instead of creating another reference', async () => {
  const f = await fixture(); const original = f.db.batch.bind(f.db); const input = body(); let raced = false; let committed;
  f.db.batch = async (statements) => { if (!raced) { raced = true; committed = await open(f, input); } return original(statements); };
  assert.deepEqual(await open(f, input), committed); assert.equal(count(f, 'after_sales_cases'), 1); assert.equal(count(f, 'asset_events', "event_type = 'rma_opened'"), 1);
});

test('atomic guard rejects asset custody changed after preflight', async () => {
  const f = await fixture(); const original = f.db.batch.bind(f.db);
  f.db.batch = async (statements) => { f.sqlite.exec("UPDATE asset_locations SET custody = 'IN_TRANSIT'"); return original(statements); };
  assert.equal((await f.request('uk', '/international/rmas', body())).status, 409); assert.equal(count(f, 'after_sales_cases'), 0);
});

test('database constraint blocks legacy case conflict and retains closed RMA history', async () => {
  const f = await fixture(); const first = await open(f);
  assert.throws(() => f.sqlite.exec(`INSERT INTO after_sales_cases (id, case_no, dealer_id, order_id, asset_id, subject, created_by) VALUES ('legacy', 'LEGACY', 'dealer', 'order-test', '${assetId}', 'legacy', 'uk')`), /active RMA/);
  f.sqlite.prepare("UPDATE after_sales_cases SET status = 'closed' WHERE id = ?").run(first.id);
  const next = await open(f); assert.match(next.rmaReference, /000002$/); assert.equal(count(f, 'after_sales_cases'), 2);
});

test('legacy RMA registration cannot move custody or issue repeat lifecycle events', async () => {
  const f = await fixture(); const rma = await open(f); const before = snapshot(f);
  assert.equal((await f.request('uk', `/international/after-sales/${rma.id}/rma`, { returnTracking: 'NEW-TRACKING' })).status, 409);
  assert.deepEqual(snapshot(f), before); assert.equal(count(f, 'asset_events', "event_type = 'rma_opened'"), 1);
});
