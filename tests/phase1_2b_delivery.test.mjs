import assert from 'node:assert/strict';
import { test } from 'node:test';
import { certifiedWarrantyEnd } from '../apps/api/src/certifiedWarranty.ts';
import { warrantyDisplayStatus } from '../packages/shared/dist/index.js';
import { certifiedPublicWarrantyDto } from '../apps/api/src/publicWarrantyProjection.ts';

import { deliveryFixture as fixture } from './helpers/deliveryFixture.mjs';

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
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM asset_public_warranties').get().n, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM asset_public_warranty_entitlements').get().n, 1);
  assert.equal(result.publicWarrantyProjection.synced, true);
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

test('Public projection reuses this Asset legacy row while preserving unrelated data and entitlements', async () => {
  const f = await fixture(); f.certify(); await f.ship();
  f.sqlite.exec(`INSERT INTO asset_public_warranties (id, asset_id, serial_number_snapshot, public_warranty_start_date, public_warranty_end_date, public_note)
    VALUES ('public-existing', '43000000-0000-4000-8000-000000000099', 'TEST-PUBLIC-SN', '2025-01-01', '2025-04-01', 'existing projection');
    INSERT INTO asset_public_warranty_entitlements (id, public_warranty_id, entitlement_type, display_name)
    VALUES ('entitlement-existing', 'public-existing', 'standard', 'Existing entitlement');`);
  f.sqlite.exec(`INSERT INTO assets (id, asset_code) VALUES ('other-asset', 'MC-26-OTHER-000001');
    INSERT INTO asset_public_warranties (id, asset_id, serial_number_snapshot, public_note) VALUES ('unrelated', 'other-asset', 'OTHER-SN', 'keep');`);
  const before = f.sqlite.prepare("SELECT * FROM asset_public_warranties WHERE id = 'unrelated'").get();
  const entitlements = f.sqlite.prepare('SELECT * FROM asset_public_warranty_entitlements').all();
  assert.equal((await f.deliver()).status, 200);
  assert.deepEqual(f.sqlite.prepare("SELECT * FROM asset_public_warranties WHERE id = 'unrelated'").get(), before);
  assert.deepEqual(f.sqlite.prepare("SELECT * FROM asset_public_warranty_entitlements WHERE id = 'entitlement-existing'").all(), entitlements);
  assert.equal(f.sqlite.prepare("SELECT projection_policy_code FROM asset_public_warranties WHERE id = 'public-existing'").get().projection_policy_code, 'MAXCINE_CERTIFIED_STANDARD_12M');
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
  // Invalid issuance facts are fixture inputs, not edits to immutable history.
  for (const facts of [{status:'revoked'},{status:'suspended'},{finalQc:0},{grade:'D'},{result:'FAIL'},{date:'2999-01-01'},{denied:true}]) {
    const f = await fixture(); f.certify(facts); await f.ship(); if(facts.denied)f.sqlite.exec("UPDATE assets SET warranty_override_status = 'denied'");
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

const assetId = '43000000-0000-4000-8000-000000000099';
async function publicQuery(f, identifier = 'MC-26-TEST-000099', lang = 'en') {
  const challenge = await (await f.request('uk', '/public/warranty/challenges', {})).json();
  const completed = await (await f.request('uk', `/public/warranty/challenges/${challenge.challengeId}/complete`, { sliderValue: 100 })).json();
  return f.request('uk', `/public/warranty/${identifier}?challengeId=${challenge.challengeId}&token=${completed.token}&lang=${lang}`);
}

test('Public projection is automatic on new Delivered and public SN/Asset Code query returns only consumer whitelist', async () => {
  const f = await fixture(); f.certify();
  f.sqlite.exec(`UPDATE assets SET current_sn = 'SECRET-SN-000099', product_name_snapshot = 'DJI Test Product', warranty_override_reason = 'PRIVATE-NOTE';
    UPDATE orders SET shipping_address = 'PRIVATE-ADDRESS', customer_profile = 'PRIVATE-BUYER';`);
  await f.ship(); const delivered = await (await f.deliver()).json();
  for (const identifier of ['MC-26-TEST-000099', 'SECRET-SN-000099']) {
    const response = await publicQuery(f, identifier); assert.equal(response.status, 200); const dto = await response.json();
    assert.deepEqual(Object.keys(dto).sort(), ['serialNumber','assetCode','productName','productVersion','warrantyStatus','warrantyStatusCode','warrantyPolicyName','warrantyStartDate','warrantyEndDate','marketRegion','certificationStatus','grade','purchaseDate','publicNote','publicEntitlements'].sort());
    assert.equal(dto.serialNumber, '***0099'); assert.equal(dto.assetCode, 'MC-26-TEST-000099');
    assert.equal(dto.productName, 'DJI Test Product'); assert.equal(dto.warrantyStatusCode, 'ACTIVE');
    assert.equal(dto.warrantyPolicyName, 'MaxCINE Certified 12-Month Limited Warranty');
    assert.equal(dto.warrantyStartDate, delivered.deliveredAt.slice(0,10));
    assert.equal(dto.warrantyEndDate, delivered.certifiedWarranty.end.slice(0,10));
    assert.equal(dto.publicEntitlements.length, 1); assert.equal(dto.publicEntitlements[0].marketRegion, 'UK');
    assert.doesNotMatch(JSON.stringify(dto), /SECRET-SN|PRIVATE-|order-test|EXT-DELIVERY|account-test|sourceOrder|warehouse|cost|margin|supplier|audit/i);
  }
  assert.equal((await (await publicQuery(f, undefined, 'zh')).json()).warrantyPolicyName, 'MaxCINE Certified 12个月有限保修');
  f.sqlite.close();
});

test('Public historical backfill and repeated sync/Delivered/reads are idempotent and preserve original dates', async () => {
  const f = await fixture(); f.certify(); await f.ship(); const original = await (await f.deliver()).json();
  f.sqlite.exec('DELETE FROM asset_public_warranty_entitlements; DELETE FROM asset_public_warranties;');
  const path = '/international/orders/order-test/public-warranty-sync';
  assert.equal((await f.request('uk', path, {})).status, 200);
  const warranty = f.sqlite.prepare('SELECT * FROM asset_public_warranties').all();
  const entitlements = f.sqlite.prepare('SELECT * FROM asset_public_warranty_entitlements').all();
  for (let i = 0; i < 3; i++) {
    assert.equal((await f.request('uk', path, {})).status, 200);
    const repeated = await (await f.deliver()).json(); assert.equal(repeated.deliveredAt, original.deliveredAt);
    assert.deepEqual(repeated.certifiedWarranty, original.certifiedWarranty);
    assert.equal((await publicQuery(f)).status, 200);
  }
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM asset_public_warranties').all(), warranty);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM asset_public_warranty_entitlements').all(), entitlements);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM asset_events WHERE event_type = 'warranty_activated'").get().n, 1);
  f.sqlite.exec('DELETE FROM asset_public_warranty_entitlements; DELETE FROM asset_public_warranties;');
  assert.equal((await f.deliver()).status, 200); // Repeat Delivered is also a recoverable backfill.
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM asset_public_warranties').get().n, 1);
  f.sqlite.close();
});

test('Public status/dates ignore corrupted cache and follow canonical boundaries/VOID/SUSPENDED', async () => {
  const f = await fixture(); f.certify(); await f.ship(); const delivered = await (await f.deliver()).json();
  f.sqlite.exec("UPDATE asset_public_warranties SET public_warranty_status = 'expired', public_warranty_end_date = '2000-01-01';");
  assert.equal((await (await publicQuery(f)).json()).warrantyStatusCode, 'ACTIVE');
  const start = new Date(delivered.certifiedWarranty.start); const end = new Date(delivered.certifiedWarranty.end);
  assert.equal((await certifiedPublicWarrantyDto(f.db, assetId, 'en', start)).warrantyStatusCode, 'ACTIVE');
  assert.equal((await certifiedPublicWarrantyDto(f.db, assetId, 'en', end)).warrantyStatusCode, 'EXPIRED');
  assert.equal((await certifiedPublicWarrantyDto(f.db, assetId, 'en', new Date(start.getTime()-1))).warrantyStatusCode, 'PENDING');
  for (const [override, status] of [['cancelled','VOID'], ['exception','SUSPENDED']]) {
    f.sqlite.prepare('UPDATE assets SET warranty_override_status = ?').run(override);
    const dto = await (await publicQuery(f)).json(); assert.equal(dto.warrantyStatusCode, status);
    assert.equal(dto.publicEntitlements[0].status, dto.warrantyStatus);
  }
  f.sqlite.close();
});

test('Public query does not falsely advertise revoked/suspended/invalid Certification', async () => {
  for (const facts of [{status:'revoked'},{status:'suspended'},{finalQc:0},{grade:'D'},{result:'FAIL'}]) {
    const f = await fixture(); f.certify(facts); await f.ship(); await f.deliver();
    const response = await publicQuery(f); assert.equal(response.status, 404); assert.doesNotMatch(await response.text(), /MaxCINE Certified|SECRET/);
    f.sqlite.close();
  }
  // Current status can still be revoked/suspended without rewriting issuance
  // facts. Existing public projection must cease advertising Certification.
  for(const status of ['revoked','suspended']){
    const f=await fixture();f.certify();await f.ship();await f.deliver();assert.equal((await publicQuery(f)).status,200);
    f.sqlite.prepare('UPDATE asset_certifications SET certification_status=?').run(status);
    assert.equal((await publicQuery(f)).status,404);f.sqlite.close();
  }
});

test('Public sync denies CN/Certified/unauthorized account and non-Certified order', async () => {
  const f = await fixture(); await f.ship(); await f.deliver();
  const path = '/international/orders/order-test/public-warranty-sync';
  for (const user of ['cn','cert','other']) assert.equal((await f.request(user, path, {})).status, 403);
  assert.equal((await f.request('uk', path, {})).status, 409);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM asset_public_warranties').get().n, 0);
  f.sqlite.close();
});

test('Public projection write failure rolls back Delivered, internal activation, custody, events and audit', async () => {
  const f = await fixture(); f.certify(); await f.ship();
  f.sqlite.exec("CREATE TRIGGER test_public_failure BEFORE INSERT ON asset_public_warranty_entitlements BEGIN SELECT RAISE(ABORT, 'projection storage failure'); END;");
  assert.equal((await f.deliver()).status, 500);
  assert.equal(f.sqlite.prepare('SELECT status FROM orders').get().status, 'shipped');
  assert.equal(f.sqlite.prepare('SELECT warranty_source_order_id AS source FROM assets').get().source, null);
  assert.equal(f.sqlite.prepare('SELECT custody FROM asset_locations').get().custody, 'IN_TRANSIT');
  for (const table of ['asset_public_warranties', 'asset_public_warranty_entitlements']) assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM asset_events WHERE event_type IN ('customer_delivered','warranty_activated')").get().n, 0);
  f.sqlite.close();
});

test('Public backfill preserves legacy visibility opt-out', async () => {
  const f = await fixture(); f.certify(); await f.ship();
  f.sqlite.exec(`INSERT INTO asset_public_warranties (id, asset_id, serial_number_snapshot, public_warranty_status)
    VALUES ('hidden-public', '${assetId}', 'HIDDEN-SN', 'hidden');`);
  await f.deliver(); assert.equal((await publicQuery(f)).status, 404);
  assert.equal(f.sqlite.prepare('SELECT is_public_query_enabled AS enabled FROM asset_public_warranties').get().enabled, 0);
  f.sqlite.close();
});

test('Public legacy non-Certified query DTO remains compatible', async () => {
  const f = await fixture();
  f.sqlite.exec(`INSERT INTO asset_public_warranties (id, asset_id, serial_number_snapshot, product_name_snapshot, public_note)
    VALUES ('legacy', '${assetId}', 'LEGACY-SN', 'Legacy Product', 'Safe public note');`);
  const response = await publicQuery(f, 'LEGACY-SN'); assert.equal(response.status, 200); const dto = await response.json();
  assert.equal(dto.serialNumber, 'LEGACY-SN'); assert.equal(dto.publicNote, 'Safe public note');
  assert.equal(dto.assetCode, undefined); assert.equal(dto.warrantyStatusCode, undefined);
  f.sqlite.close();
});

test('Public managed warranty cannot be independently edited; internal override is visible in Admin and Consumer DTOs', async () => {
  const f = await fixture(); f.certify(); await f.ship(); await f.deliver();
  const response = await f.request('admin', `/admin/assets/${assetId}/public-warranty`, {
    publicWarrantyStartDate: '2000-01-01', publicWarrantyEndDate: '2001-01-01', publicWarrantyStatus: 'expired', isPublicQueryEnabled: true
  }, 'PATCH');
  assert.equal(response.status, 409);
  f.sqlite.exec("UPDATE assets SET warranty_override_status = 'cancelled'; UPDATE asset_public_warranties SET public_warranty_status = 'active';");
  const detail = await (await f.request('admin', `/assets/${assetId}`)).json();
  assert.equal(detail.publicWarranty.isManagedProjection, true);
  assert.equal(detail.publicWarranty.warrantyStatus, detail.asset.warrantyStatus);
  assert.equal((await (await publicQuery(f)).json()).warrantyStatusCode, 'VOID');
  f.sqlite.close();
});
