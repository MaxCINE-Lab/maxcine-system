import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { URL } from 'node:url';
import { addUnit, original, product, replaceFixture } from './helpers/replaceFixture.mjs';

const integrityTables = ['orders', 'international_asset_allocations', 'asset_public_warranties', 'asset_public_warranty_entitlements', 'rma_return_inspections', 'rma_return_inspection_evidence', 'asset_certifications'];
const integrity = (f) => integrityTables.map((t) => f.sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all());
const assetRow = (f, id) => f.sqlite.prepare('SELECT * FROM assets WHERE id=?').get(id);
const location = (f, id) => ({ ...f.sqlite.prepare('SELECT warehouse_id,status,custody FROM asset_locations WHERE asset_id=?').get(id) });
const executionRow = (f) => f.sqlite.prepare('SELECT * FROM rma_replace_executions').get();
const caseRow = (f) => ({ ...f.sqlite.prepare('SELECT status,service_stage,cross_border_resolution,outbound_shipped_at FROM after_sales_cases WHERE id=?').get(f.rma.id) });
const events = (f) => f.sqlite.prepare("SELECT event_type,asset_id,related_order_id FROM asset_events WHERE source='international-rma-replace' ORDER BY event_type,asset_id").all().map((r) => ({ ...r }));
const audits = (f) => f.sqlite.prepare("SELECT action FROM audit_logs WHERE action LIKE 'international.rma.replacement_%' ORDER BY action").all().map((r) => r.action);
const status = async (response, expected, label) => { const body = await response.text(); assert.equal(response.status, expected, `${label ?? ''} ${body}`); return body ? JSON.parse(body) : null; };
const ready = async (f, user = 'admin') => { await status(await f.start(user), 200, 'start'); await status(await f.select(user), 200, 'select'); };

test('valid REPLACE: start, commit and complete keep two separate canonical Assets and an open RMA', async () => {
  const f = await replaceFixture(); const before = integrity(f), originalBefore = assetRow(f, original.assetId), originalLocation = location(f, original.assetId), replacementBefore = assetRow(f, f.replacement.assetId);
  let d = await f.data(); assert.equal(d.resolutionType, 'REPLACE'); assert.equal(d.executionStatus, 'NOT_STARTED'); assert.equal(d.canStart, true);
  d = await status(await f.start(), 200); assert.equal(d.executionStatus, 'REPLACEMENT_IN_PROGRESS'); assert.equal(caseRow(f).service_stage, 'REPLACEMENT_IN_PROGRESS');
  assert.deepEqual(d.candidates.map((c) => c.assetCode), [f.replacement.assetCode]); assert.equal(d.canSelect, true);
  d = await status(await f.select(), 200); assert.equal(d.replacementAsset.assetCode, f.replacement.assetCode); assert.equal(d.replacementAsset.committed, true); assert.equal(d.canComplete, true);
  assert.deepEqual(location(f, f.replacement.assetId), { warehouse_id: 'wh-uk', status: 'reserved', custody: 'WAREHOUSE' });
  d = await status(await f.complete(), 200); assert.equal(d.executionStatus, 'REPLACEMENT_COMPLETED'); assert.equal(d.shipmentPending, true); assert.equal(d.rmaOpen, true); assert.equal(d.warrantyChanged, false);
  const e = executionRow(f); assert.equal(e.original_asset_id, original.assetId); assert.equal(e.replacement_asset_id, f.replacement.assetId); assert.notEqual(e.original_asset_id, e.replacement_asset_id);
  assert.equal(e.rma_id, f.rma.id); assert.equal(e.resolution_reference, f.rma.id); assert.equal(e.started_by, 'admin'); assert.equal(e.completed_by, 'admin'); assert.match(e.execution_notes, /Synthetic/);
  assert.deepEqual(caseRow(f), { status: 'in_progress', service_stage: 'REPLACEMENT_COMPLETED', cross_border_resolution: 'REPLACE', outbound_shipped_at: null });
  assert.deepEqual(integrity(f), before, 'original Order / Allocation / Warranty projection / inspection / certification history unchanged');
  assert.deepEqual(assetRow(f, original.assetId), originalBefore); assert.deepEqual(location(f, original.assetId), originalLocation);
  assert.deepEqual(assetRow(f, f.replacement.assetId), replacementBefore, 'replacement keeps its own identity, SN and Warranty fields');
  assert.equal(assetRow(f, original.assetId).inventory_status, 'QUARANTINED');
  assert.deepEqual(events(f).map((r) => [r.event_type, r.asset_id === original.assetId ? 'O' : 'R', r.related_order_id]), [
    ['replacement_asset_committed', 'O', 'order-test'], ['replacement_asset_committed', 'R', null],
    ['replacement_execution_completed', 'O', 'order-test'], ['replacement_execution_completed', 'R', null], ['replacement_execution_started', 'O', 'order-test']]);
  assert.deepEqual(audits(f), ['international.rma.replacement_asset_committed', 'international.rma.replacement_execution_completed', 'international.rma.replacement_execution_started']);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM asset_events WHERE asset_id=? AND event_type IN ('shipped','customer_shipped','customer_delivered','sold','warranty_activated')").get(f.replacement.assetId).n, 0, 'no shipment / delivery / sale facts for the replacement');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM international_asset_allocations WHERE asset_id=?').get(f.replacement.assetId).n, 0);
  const metadata = f.sqlite.prepare("SELECT new_value_json FROM asset_events WHERE source='international-rma-replace'").all().map((r) => r.new_value_json).join(' ');
  for (const banned of ['shipping', 'address', 'customer_profile', 'buyer', 'email']) assert.equal(metadata.includes(banned), false, banned);
});

test('REPAIR / REFUND / REJECT resolutions cannot start a replacement execution', async () => {
  for (const resolution of ['REPAIR', 'REFUND', 'REJECT']) {
    const f = await replaceFixture({ resolution }); const d = await f.data(); assert.equal(d.resolutionType, resolution); assert.equal(d.canStart, false);
    await status(await f.start(), 409, resolution); assert.equal(executionRow(f), undefined); assert.equal(caseRow(f).service_stage, 'RESOLUTION_DECIDED');
    assert.throws(() => f.sqlite.prepare(`INSERT INTO rma_replace_executions(id,rma_id,original_asset_id,order_id,resolution_reference,resolution_decided_at,inspection_id,status,started_by,started_at,created_at,updated_at)
      SELECT 'forced',id,asset_id,order_id,id,resolution_decided_at,resolution_inspection_id,'REPLACEMENT_IN_PROGRESS','admin','2026-10-07T00:00:00Z','2026-10-07T00:00:00Z','2026-10-07T00:00:00Z' FROM after_sales_cases WHERE id=?`).run(f.rma.id), /Invalid replacement start/);
  }
});

test('ineligible replacement Assets are rejected and nothing is committed', async () => {
  const cases = [
    ['same Asset', () => original.assetCode, 409], ['nonexistent', () => 'MC-26-DOES-NOT-EXIST', 404],
    ['quarantined', (f) => addUnit(f, { n: 11, inventory: 'QUARANTINED', status: 'returned' }).assetCode, 409],
    ['wrong custody', (f) => addUnit(f, { n: 12, custody: 'SERVICE_CENTER' }).assetCode, 409],
    ['wrong warehouse', (f) => addUnit(f, { n: 13, warehouse: 'wh-cn-sd' }).assetCode, 409],
    ['wrong market', (f) => addUnit(f, { n: 14, warehouse: 'wh-sg' }).assetCode, 409],
    ['in transit', (f) => addUnit(f, { n: 15, status: 'in_transit', custody: 'IN_TRANSIT' }).assetCode, 409],
    ['reserved location', (f) => addUnit(f, { n: 16, status: 'reserved' }).assetCode, 409],
    ['active allocation', (f) => { const u = addUnit(f, { n: 17 }); f.sqlite.exec(`INSERT INTO orders (id,order_no,dealer_id,store_id,created_by,status,channel_id,sales_account_id,fulfilment_warehouse_id,external_order_id) VALUES ('order-alloc','TEST-ALLOC','dealer','store','uk','approved','channel-ebay-uk','account-test','wh-uk','EXT-ALLOC');
      INSERT INTO international_asset_allocations(allocation_id,order_id,asset_id,status) VALUES('alloc-other','order-alloc','${u.assetId}','reserved')`); return u.assetCode; }, 409],
    ['active listing', (f) => { const u = addUnit(f, { n: 18 }); f.sqlite.exec(`INSERT INTO marketplace_listings(id,asset_id,channel_id,sales_account_id,title,price_minor,currency,status,created_by) VALUES('listing-other','${u.assetId}','channel-ebay-uk','account-test','Listed',100,'GBP','active','admin')`); return u.assetCode; }, 409],
    ['active transfer', (f) => { const u = addUnit(f, { n: 19 }); f.sqlite.exec(`INSERT INTO asset_transfers(id,asset_id,from_warehouse_id,to_warehouse_id,status,created_by) VALUES('transfer-other','${u.assetId}','wh-uk','wh-sg','created','admin')`); return u.assetCode; }, 409],
    ['active RMA', (f) => { const u = addUnit(f, { n: 20 }); f.sqlite.exec(`INSERT INTO after_sales_cases(id,case_no,dealer_id,subject,description,status,created_by,asset_id) VALUES('legacy-open-case','CASE-REPL','dealer','Open','Synthetic','open','admin','${u.assetId}')`); return u.assetCode; }, 409],
    ['revoked certification', (f) => addUnit(f, { n: 21, cert: 'revoked' }).assetCode, 409],
    ['suspended certification', (f) => addUnit(f, { n: 22, cert: 'suspended' }).assetCode, 409],
    ['no certification', (f) => addUnit(f, { n: 23, cert: null }).assetCode, 409],
    ['Parts / Repair grade', (f) => addUnit(f, { n: 24, grade: 'D' }).assetCode, 409],
    ['final QC missing', (f) => addUnit(f, { n: 25, finalQc: 0 }).assetCode, 409],
    ['incompatible product name', (f) => addUnit(f, { n: 26, name: 'Different Product' }).assetCode, 409],
    ['incompatible version', (f) => addUnit(f, { n: 27, version: 'Pro Kit' }).assetCode, 409],
    ['incompatible product_id', (f) => { f.sqlite.exec("INSERT OR IGNORE INTO products(id,sku,name,unit_price_cents) VALUES('product-other','SKU-OTHER','Other',1)"); return addUnit(f, { n: 28, productId: 'product-other' }).assetCode; }, 409],
    ['in service', (f) => { const u = addUnit(f, { n: 29 }); f.sqlite.prepare("UPDATE assets SET asset_status='in_service' WHERE id=?").run(u.assetId); return u.assetCode; }, 409],
  ];
  for (const [label, unit, code] of cases) {
    const f = await replaceFixture(); await status(await f.start(), 200); const assetCode = unit(f); const before = f.sqlite.prepare('SELECT asset_id,status FROM asset_locations ORDER BY asset_id').all();
    await status(await f.select('admin', assetCode), code, label);
    assert.equal(executionRow(f).replacement_asset_id, null, label); assert.deepEqual(f.sqlite.prepare('SELECT asset_id,status FROM asset_locations ORDER BY asset_id').all(), before, label);
    assert.equal(events(f).some((e) => e.event_type === 'replacement_asset_committed'), false, label);
  }
  // Empty original product identity cannot prove compatibility.
  const f = await replaceFixture(); f.sqlite.prepare("UPDATE assets SET product_name_snapshot='' WHERE id=?").run(original.assetId); await f.start();
  f.sqlite.prepare("UPDATE assets SET product_name_snapshot='' WHERE id=?").run(f.replacement.assetId); await status(await f.select(), 409, 'unprovable model');
});

test('authorization: admin and explicit operator allowed; warehouse / repair / Certified / ordinary International and wrong scopes denied', async () => {
  const operator = await replaceFixture(); operator.grant('uk'); await ready(operator, 'uk'); await status(await operator.complete('uk'), 200, 'operator');
  assert.equal(executionRow(operator).completed_by, 'uk');
  const f = await replaceFixture(); f.grant('intl', 'role-international-repair-operator'); f.grant('cn', 'role-international-repair-operator');
  for (const user of ['uk', 'cn', 'cert', 'intl']) {
    await status(await f.start(user), 403, `${user} start`); await status(await f.select(user), 403, `${user} select`); await status(await f.complete(user), 403, `${user} complete`);
  }
  for (const user of ['other', 'wrongMarket', 'wrongWarehouse']) {
    f.grant(user); for (const call of [() => f.detail(user), () => f.start(user), () => f.select(user), () => f.complete(user)]) await status(await call(), 403, user);
  }
  f.grant('intl'); f.sqlite.prepare("DELETE FROM user_workspaces WHERE user_id='intl'").run(); await status(await f.start('intl'), 403, 'missing workspace');
  assert.equal(executionRow(f), undefined);
  // RMA access does not grant access to replacement stock in another warehouse.
  const scope = await replaceFixture(); scope.grant('uk'); await status(await scope.start('uk'), 200); const foreign = addUnit(scope, { n: 31, warehouse: 'wh-sg' });
  await status(await scope.select('uk', foreign.assetCode), 403, 'replacement outside caller warehouse scope'); assert.equal(executionRow(scope).replacement_asset_id, null);
  // Reads require explicit permission; read-only users see no candidates and cannot act.
  const read = await replaceFixture(); await read.start(); const view = await read.data('uk'); assert.equal(view.canSelect, false); assert.deepEqual(view.candidates, []);
  await status(await read.detail('cert'), 403, 'certified read');
});

test('idempotency: duplicate start / selection / completion converge; conflicting or out-of-order calls are 409', async () => {
  const f = await replaceFixture();
  await status(await f.complete(), 409, 'complete before start'); await status(await f.select(), 409, 'select before start');
  await status(await f.start(), 200); const first = executionRow(f); for (let n = 0; n < 3; n++) await status(await f.start(), 200); assert.deepEqual(executionRow(f), first);
  await status(await f.complete(), 409, 'complete before selection');
  await status(await f.select(), 200); const selected = executionRow(f); for (let n = 0; n < 3; n++) await status(await f.select(), 200); assert.deepEqual(executionRow(f), selected);
  const other = addUnit(f, { n: 41 }); await status(await f.select('admin', other.assetCode), 409, 'different selection'); assert.equal(location(f, other.assetId).status, 'on_hand');
  await status(await f.complete('admin', other.assetCode), 409, 'confirm code mismatch');
  await status(await f.complete(), 200); const done = executionRow(f); for (let n = 0; n < 3; n++) await status(await f.complete(), 200); assert.deepEqual(executionRow(f), done);
  await status(await f.complete('admin', f.replacement.assetCode, 'Different notes'), 409, 'conflicting completion');
  await status(await f.start(), 409, 'restart completed'); await status(await f.select('admin', other.assetCode), 409, 'change after completion');
  await status(await f.select(), 200, 'same selection after completion is a read');
  assert.equal(events(f).length, 5); assert.equal(audits(f).length, 3);
});

test('two RMAs competing for one replacement Asset: exactly one commitment wins', async () => {
  const f = await replaceFixture(); const second = await f.second(); await status(await f.start(), 200); await status(await f.request('admin', `${second.base}/start`, {}), 200);
  await status(await f.select(), 200); await status(await f.select('admin', f.replacement.assetCode, second.base), 409, 'already committed');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM rma_replace_executions WHERE replacement_asset_id=?').get(f.replacement.assetId).n, 1);
  // Interleaved: RMA 2 commits inside RMA 1's request window; RMA 1 must lose atomically.
  const g = await replaceFixture(); const rival = await g.second(); await g.start(); await g.request('admin', `${rival.base}/start`, {});
  const batch = g.db.batch.bind(g.db); let raced = false;
  g.db.batch = async (statements) => { if (!raced) { raced = true; await status(await g.select('admin', g.replacement.assetCode, rival.base), 200, 'rival'); } return batch(statements); };
  await status(await g.select(), 409, 'loser'); assert.equal(executionRow(g).replacement_asset_id, null);
  assert.equal(g.sqlite.prepare('SELECT rma_id FROM rma_replace_executions WHERE replacement_asset_id=?').get(g.replacement.assetId).rma_id, rival.rma.id);
  assert.equal(g.sqlite.prepare("SELECT COUNT(*) n FROM asset_events WHERE asset_id=? AND event_type='replacement_asset_committed'").get(g.replacement.assetId).n, 1);
});

test('concurrent conflicting selections on one RMA leave a single valid commitment', async () => {
  const f = await replaceFixture(); await f.start(); const other = addUnit(f, { n: 51 }); const batch = f.db.batch.bind(f.db); let raced = false;
  f.db.batch = async (statements) => { if (!raced) { raced = true; await status(await f.select('admin', other.assetCode), 200, 'inner'); } return batch(statements); };
  await status(await f.select(), 409, 'outer'); assert.equal(executionRow(f).replacement_asset_id, other.assetId);
  assert.equal(location(f, other.assetId).status, 'reserved'); assert.equal(location(f, f.replacement.assetId).status, 'on_hand');
});

test('replacement becoming ineligible after selection blocks completion without substitution', async () => {
  for (const [label, mutate] of [
    ['revoked', (f) => f.sqlite.prepare("UPDATE asset_certifications SET certification_status='revoked' WHERE asset_id=?").run(f.replacement.assetId)],
    ['suspended', (f) => f.sqlite.prepare("UPDATE asset_certifications SET certification_status='suspended' WHERE asset_id=?").run(f.replacement.assetId)],
    ['quarantined', (f) => f.sqlite.prepare("UPDATE assets SET inventory_status='QUARANTINED' WHERE id=?").run(f.replacement.assetId)],
    ['in service', (f) => f.sqlite.prepare("UPDATE assets SET asset_status='in_service' WHERE id=?").run(f.replacement.assetId)]]) {
    const f = await replaceFixture(); await ready(f); addUnit(f, { n: 61 }); mutate(f);
    const d = await f.data(); assert.equal(d.canComplete, false, label); assert.ok(d.replacementAsset.blockers.length, label);
    await status(await f.complete(), 409, label); assert.equal(executionRow(f).status, 'REPLACEMENT_IN_PROGRESS'); assert.equal(executionRow(f).replacement_asset_id, f.replacement.assetId, `${label}: never substituted`);
    assert.throws(() => f.sqlite.prepare("UPDATE rma_replace_executions SET status='REPLACEMENT_COMPLETED',completed_by='admin',completed_at='2099-01-01T00:00:00Z',execution_notes='x',completion_fingerprint='x'").run(), /Invalid replacement completion/, label);
  }
});

test('committed replacement leaves sellable inventory; allocation, listing, transfer and location changes are blocked', async () => {
  const f = await replaceFixture();
  const inventory = async () => (await (await f.request('uk', '/international/warehouses/assets?warehouseId=wh-uk')).json()).assets.map((a) => a.assetId);
  assert.ok((await inventory()).includes(f.replacement.assetId)); await ready(f); assert.equal((await inventory()).includes(f.replacement.assetId), false);
  f.sqlite.exec(`INSERT INTO orders (id,order_no,dealer_id,store_id,created_by,status,channel_id,sales_account_id,fulfilment_warehouse_id,external_order_id) VALUES ('order-next','TEST-NEXT','dealer','store','uk','approved','channel-ebay-uk','account-test','wh-uk','EXT-NEXT')`);
  await status(await f.request('uk', '/international/orders/order-next/bind-asset', { assetId: f.replacement.assetId }), 409, 'allocation');
  await status(await f.request('intl', '/marketplace/listings', { assetId: f.replacement.assetId, channelId: 'channel-ebay-uk', salesAccountId: 'account-test', title: 'Must stay committed', priceMinor: 100, currency: 'GBP' }), 409, 'listing');
  await status(await f.request('admin', '/international/transfers', { assetId: f.replacement.assetId, fromWarehouseId: 'wh-uk', toWarehouseId: 'wh-sg' }), 409, 'transfer');
  assert.throws(() => f.sqlite.exec(`INSERT INTO international_asset_allocations(allocation_id,order_id,asset_id,status) VALUES('forced','order-next','${f.replacement.assetId}','reserved')`), /RMA replacement/);
  assert.throws(() => f.sqlite.exec(`INSERT INTO marketplace_listings(id,asset_id,channel_id,sales_account_id,title,price_minor,currency,status,created_by) VALUES('forced','${f.replacement.assetId}','channel-ebay-uk','account-test','x',1,'GBP','draft','admin')`), /RMA replacement/);
  assert.throws(() => f.sqlite.exec(`INSERT INTO asset_transfers(id,asset_id,from_warehouse_id,to_warehouse_id,created_by) VALUES('forced','${f.replacement.assetId}','wh-uk','wh-sg','admin')`), /RMA replacement/);
  for (const sql of ["status='on_hand'", "custody='CUSTOMER'", "warehouse_id='wh-sg'"]) assert.throws(() => f.sqlite.exec(`UPDATE asset_locations SET ${sql} WHERE asset_id='${f.replacement.assetId}'`), /RMA replacement/, sql);
  await status(await f.complete(), 200); assert.equal((await inventory()).includes(f.replacement.assetId), false); assert.equal(location(f, f.replacement.assetId).status, 'reserved');
});

test('history is immutable: completed execution, selection and relationship cannot be rewritten or deleted', async () => {
  const f = await replaceFixture(); await ready(f); const other = addUnit(f, { n: 71 });
  assert.throws(() => f.sqlite.prepare('UPDATE rma_replace_executions SET replacement_asset_id=?').run(other.assetId), /immutable/);
  await f.complete();
  for (const sql of ["UPDATE rma_replace_executions SET execution_notes='rewritten'", "UPDATE rma_replace_executions SET status='REPLACEMENT_IN_PROGRESS'", 'DELETE FROM rma_replace_executions',
    `UPDATE rma_replace_executions SET original_asset_id='${other.assetId}'`]) assert.throws(() => f.sqlite.exec(sql), /immutable|cannot be deleted/, sql);
  assert.throws(() => f.sqlite.exec(`UPDATE after_sales_cases SET service_stage='RESOLUTION_DECIDED' WHERE id='${f.rma.id}'`), /Invalid replacement case state/);
  assert.throws(() => f.sqlite.exec(`UPDATE after_sales_cases SET status='closed' WHERE id='${f.rma.id}'`), /Invalid replacement case state/, 'closure is a separate future workflow');
});

test('Start / Select / Complete roll back completely on Event or Audit failure', async () => {
  for (const action of ['start', 'select', 'complete']) for (const table of ['asset_events', 'audit_logs']) {
    const f = await replaceFixture(); if (action !== 'start') await f.start(); if (action === 'complete') await f.select();
    const snapshot = () => [executionRow(f), caseRow(f), location(f, f.replacement.assetId), events(f), audits(f)]; const before = snapshot();
    f.sqlite.exec(`CREATE TRIGGER fail_replace BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'test replace failure'); END`);
    await status(await (action === 'start' ? f.start() : action === 'select' ? f.select() : f.complete()), 500, `${action}/${table}`); assert.deepEqual(snapshot(), before, `${action}/${table}`);
  }
});

test('lost committed responses recover on exact retries without duplicate events', async () => {
  for (const action of ['start', 'select', 'complete']) {
    const f = await replaceFixture(); if (action !== 'start') await f.start(); if (action === 'complete') await f.select();
    const batch = f.db.batch.bind(f.db); let lost = true; f.db.batch = async (statements) => { const result = await batch(statements); if (lost) { lost = false; throw new Error('lost replace committed response'); } return result; };
    const run = () => (action === 'start' ? f.start() : action === 'select' ? f.select() : f.complete());
    await status(await run(), 500, action); await status(await run(), 200, `${action} retry`);
    const counts = f.sqlite.prepare("SELECT event_type,asset_id,COUNT(*) n FROM asset_events WHERE source='international-rma-replace' GROUP BY 1,2").all(); assert.ok(counts.every((r) => r.n === 1), action);
  }
});

test('B-5E2 regression: 0044 preserves 0043 event types, indexes and the customer-return-release trigger', () => {
  const root = new URL('../apps/api/migrations/', import.meta.url); const names = readdirSync(root).filter((n) => /^\d{4}.*\.sql$/.test(n)).sort();
  const build = (limit) => { const db = new DatabaseSync(':memory:'); for (const n of names.filter((n) => n < limit)) db.exec(readFileSync(new URL(n, root), 'utf8')); return db; };
  const before = build('0044'); before.exec(`PRAGMA foreign_keys=ON; INSERT INTO assets(id,asset_code) VALUES('history-asset','MC-HISTORY');
    INSERT INTO asset_events(id,asset_id,event_type,title,source,related_service_case_id) VALUES('history-release','history-asset','customer_return_released','Released','international-customer-return-release',NULL),
      ('history-repair','history-asset','repair_completed','Repaired','international-rma-repair',NULL)`);
  const schema = (db) => db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name<>'asset_events' ORDER BY name").all().map((r) => ({ ...r }));
  const prior = new Map(schema(before).map((r) => [r.name, r.sql])); const rows = before.prepare('SELECT * FROM asset_events ORDER BY id').all();
  before.exec(readFileSync(new URL('0044_rma_replace_execution.sql', root), 'utf8'));
  const after = new Map(schema(before).map((r) => [r.name, r.sql])); for (const [name, sql] of prior) assert.equal(after.get(name), sql, `0043 object preserved: ${name}`);
  assert.deepEqual(before.prepare('SELECT * FROM asset_events ORDER BY id').all(), rows); assert.deepEqual(before.prepare('PRAGMA foreign_key_check').all(), []);
  before.exec("INSERT INTO asset_events(id,asset_id,event_type,title) VALUES('new-release','history-asset','customer_return_released','Still allowed')");
  assert.throws(() => before.exec("INSERT INTO asset_events(id,asset_id,event_type,title) VALUES('bad','history-asset','replacement_delivered','x')"), /CHECK/);
  assert.equal(before.prepare("SELECT COUNT(*) n FROM role_permissions p JOIN roles r ON r.id=p.role_id WHERE p.permission_code='international-rma-replace:execute' AND r.code NOT IN ('super_admin','international_replacement_operator')").get().n, 0);
  assert.equal(before.prepare("SELECT COUNT(*) n FROM user_roles WHERE role_id='role-international-replacement-operator'").get().n, 0);
});

test('replacement candidates match the original product identity and stay inside scope', async () => {
  const f = await replaceFixture(); await f.start(); addUnit(f, { n: 81, version: 'Other Kit' }); addUnit(f, { n: 82, warehouse: 'wh-sg' }); const extra = addUnit(f, { n: 83 });
  const codes = (await f.data()).candidates.map((c) => c.assetCode).sort(); assert.deepEqual(codes, [f.replacement.assetCode, extra.assetCode].sort());
  assert.equal((await f.data()).originalAsset.productName, product.name);
});
