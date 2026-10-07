import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { URL } from 'node:url';
import { addUnit, original, product, replaceFixture } from './helpers/replaceFixture.mjs';

// B-5F1 blocking fixes: database-level invariants added by 0045 and the
// matching API guards. Direct SQL is used deliberately to prove the database,
// not the API, is the final authority.
const status = async (response, expected, label) => { const body = await response.text(); assert.equal(response.status, expected, `${label ?? ''} ${body}`); return body ? JSON.parse(body) : null; };
const location = (f, id) => ({ ...f.sqlite.prepare('SELECT warehouse_id,status,custody FROM asset_locations WHERE asset_id=?').get(id) });
const executionRow = (f) => f.sqlite.prepare('SELECT * FROM rma_replace_executions').get();
const certificationOf = (f, assetId) => f.sqlite.prepare('SELECT id FROM current_asset_certifications WHERE asset_id=?').get(assetId).id;
// Commitment written directly, without touching asset_locations.
const directCommit = (f, unit, at = '2026-10-07T01:00:00.000Z') => f.sqlite.prepare(`UPDATE rma_replace_executions SET replacement_asset_id=?,replacement_asset_code=?,replacement_warehouse_id='wh-uk',
  replacement_certification_id=?,replacement_selected_by='admin',replacement_selected_at=?,selection_fingerprint='direct',updated_at=? WHERE rma_id=?`)
  .run(unit.assetId, unit.assetCode, certificationOf(f, unit.assetId), at, at, f.rma.id);
const directComplete = (f) => f.sqlite.prepare(`UPDATE rma_replace_executions SET status='REPLACEMENT_COMPLETED',completed_by='admin',completed_at='2099-01-01T00:00:00Z',
  execution_notes='direct',completion_fingerprint='direct' WHERE rma_id=?`).run(f.rma.id);
const directStart = (f) => f.sqlite.prepare(`INSERT INTO rma_replace_executions(id,rma_id,original_asset_id,order_id,resolution_reference,resolution_decided_at,inspection_id,status,started_by,started_at,created_at,updated_at)
  SELECT 'forced',id,asset_id,order_id,id,resolution_decided_at,resolution_inspection_id,'REPLACEMENT_IN_PROGRESS','admin','2026-10-07T00:00:00Z','2026-10-07T00:00:00Z','2026-10-07T00:00:00Z' FROM after_sales_cases WHERE id=?`).run(f.rma.id);
const ready = async (f, user = 'admin') => { await status(await f.start(user), 200, 'start'); await status(await f.select(user), 200, 'select'); };

test('H1: a direct commitment reserves the unit atomically inside the same write', async () => {
  const f = await replaceFixture(); await status(await f.start(), 200);
  assert.equal(location(f, f.replacement.assetId).status, 'on_hand');
  directCommit(f, f.replacement);
  assert.deepEqual(location(f, f.replacement.assetId), { warehouse_id: 'wh-uk', status: 'reserved', custody: 'WAREHOUSE' }, 'reservation formed by the database');
  assert.equal(executionRow(f).replacement_asset_id, f.replacement.assetId);
  const d = await f.data(); assert.equal(d.replacementAsset.committed, true); assert.deepEqual(d.replacementAsset.blockers, []); assert.equal(d.canComplete, true);
  await status(await f.complete(), 200, 'API completes a database-formed commitment');
});

test('H1: no partial commitment is possible in either direction', async () => {
  // Already-reserved unit: selection guard aborts the commitment and nothing changes.
  const f = await replaceFixture(); await f.start(); const held = addUnit(f, { n: 101, status: 'reserved' });
  assert.throws(() => directCommit(f, held), /Invalid replacement asset/); assert.equal(executionRow(f).replacement_asset_id, null); assert.equal(location(f, held.assetId).status, 'reserved');
  // Even with the selection guard missing, a reservation that cannot happen aborts the commitment.
  const g = await replaceFixture(); await g.start(); g.sqlite.exec('DROP TRIGGER trg_rma_replace_select');
  const elsewhere = addUnit(g, { n: 102, warehouse: 'wh-sg' });
  assert.throws(() => directCommit(g, elsewhere), /Replacement reservation failed/);
  assert.equal(executionRow(g).replacement_asset_id, null, 'execution never references an unreserved unit'); assert.equal(location(g, elsewhere.assetId).status, 'on_hand');
  // Reverse: a committed unit's reservation cannot be removed, replaced or deleted while the execution exists.
  const h = await replaceFixture(); await ready(h);
  for (const sql of [`UPDATE asset_locations SET status='on_hand' WHERE asset_id='${h.replacement.assetId}'`,
    `DELETE FROM asset_locations WHERE asset_id='${h.replacement.assetId}'`,
    `INSERT OR REPLACE INTO asset_locations(asset_id,warehouse_id,status,custody) VALUES('${h.replacement.assetId}','wh-uk','on_hand','WAREHOUSE')`])
    assert.throws(() => h.sqlite.exec(sql), /RMA replacement/, sql);
  assert.throws(() => h.sqlite.exec('UPDATE rma_replace_executions SET replacement_asset_id=NULL'), /immutable|CHECK/);
  assert.equal(location(h, h.replacement.assetId).status, 'reserved'); assert.equal(executionRow(h).replacement_asset_id, h.replacement.assetId);
});

test('H1: the API selection no longer issues its own reservation write', () => {
  const source = readFileSync(new URL('../apps/api/src/rmaReplace.ts', import.meta.url), 'utf8');
  assert.equal(/UPDATE asset_locations/.test(source), false);
});

test('H2: a committed unit cannot get a new active after-sales case via API or direct SQL', async () => {
  const f = await replaceFixture(); await ready(f);
  // after-sales:create comes from the application seed, not migrations; supply it in this isolated fixture only.
  f.sqlite.exec("INSERT OR IGNORE INTO permissions(code,name) VALUES('after-sales:create','Create after-sales'); INSERT OR IGNORE INTO role_permissions(role_id,permission_code) VALUES('role-test-admin','after-sales:create')");
  const body = await status(await f.request('admin', `/assets/${f.replacement.assetId}/after-sales`, { storeId: '30000000-0000-4000-8000-000000000001', caseType: '产品异常', subject: 'Synthetic legacy case', description: 'Synthetic bypass attempt only' }), 409, 'legacy after-sales');
  assert.equal(body.error.code, 'CONFLICT');
  const insert = (id, state) => f.sqlite.exec(`INSERT INTO after_sales_cases(id,case_no,dealer_id,subject,description,status,created_by,asset_id) VALUES('${id}','CASE-${id}','dealer','Direct','Synthetic','${state}','admin','${f.replacement.assetId}')`);
  for (const state of ['open', 'in_progress']) assert.throws(() => insert(`direct-${state}`, state), /after-sales case forbidden/, state);
  insert('direct-closed', 'closed');
  assert.throws(() => f.sqlite.exec("UPDATE after_sales_cases SET status='open' WHERE id='direct-closed'"), /after-sales case forbidden/, 'reopen');
  f.sqlite.exec(`INSERT INTO after_sales_cases(id,case_no,dealer_id,subject,description,status,created_by,asset_id) VALUES('elsewhere','CASE-ELSEWHERE','dealer','Other','Synthetic','open','admin',NULL)`);
  assert.throws(() => f.sqlite.exec(`UPDATE after_sales_cases SET asset_id='${f.replacement.assetId}' WHERE id='elsewhere'`), /after-sales case forbidden/, 're-point');
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM after_sales_cases WHERE asset_id=? AND status IN ('open','in_progress')").get(f.replacement.assetId).n, 0);
  await status(await f.complete(), 200, 'execution itself is unaffected');
});

test('H3: replacement stock requires warehouse AND Sales Account scope on both candidate and Asset Code paths', async () => {
  // Unit in the operator's UK warehouse but with canonical affinity to another Sales Account.
  const foreignAffinity = (f, n) => {
    const unit = addUnit(f, { n }); f.sqlite.exec(`INSERT OR IGNORE INTO sales_accounts(id,channel_id,account_name,market_region) VALUES('account-other','channel-ebay-uk','Other account','UK');
      INSERT INTO orders (id,order_no,dealer_id,store_id,created_by,status,channel_id,sales_account_id,fulfilment_warehouse_id,external_order_id) VALUES ('order-b-${n}','TEST-B-${n}','dealer','store','admin','cancelled','channel-ebay-uk','account-other','wh-uk','EXT-B-${n}');
      INSERT INTO international_asset_allocations(allocation_id,order_id,asset_id,status) VALUES('alloc-b-${n}','order-b-${n}','${unit.assetId}','released')`);
    return unit;
  };
  const f = await replaceFixture(); f.grant('uk'); await status(await f.start('uk'), 200); const foreign = foreignAffinity(f, 111);
  const codes = (await f.data('uk')).candidates.map((c) => c.assetCode); assert.ok(codes.includes(f.replacement.assetCode)); assert.equal(codes.includes(foreign.assetCode), false, 'not a candidate');
  await status(await f.select('uk', foreign.assetCode), 403, 'direct Asset Code'); assert.equal(executionRow(f).replacement_asset_id, null); assert.equal(location(f, foreign.assetId).status, 'on_hand');
  assert.ok((await f.data('admin')).candidates.some((c) => c.assetCode === foreign.assetCode), 'otherwise eligible: global scope sees it');
  // GET detail IDOR: RMA scope does not expose a replacement unit outside the caller's scope.
  const g = await replaceFixture(); g.grant('uk'); await g.start(); const bound = foreignAffinity(g, 112);
  await status(await g.select('admin', bound.assetCode), 200, 'admin commits');
  const denied = await status(await g.detail('uk'), 403, 'detail'); const text = JSON.stringify(denied);
  for (const leak of [bound.assetCode, bound.assetId, certificationOf(g, bound.assetId)]) assert.equal(text.includes(leak), false, leak);
  await status(await g.complete('uk', bound.assetCode), 403, 'complete'); await status(await g.select('uk', bound.assetCode), 403, 'repeat select');
  assert.equal((await g.data('admin')).replacementAsset.assetCode, bound.assetCode);
  // Same-scope unit stays readable for the in-scope operator.
  const h = await replaceFixture(); h.grant('uk'); await ready(h, 'uk'); assert.equal((await h.data('uk')).replacementAsset.assetCode, h.replacement.assetCode);
});

test('H4: product compatibility fails closed on missing or empty canonical data', async () => {
  for (const [label, prepare] of [
    ['original product_id NULL', (f) => f.sqlite.prepare('UPDATE assets SET product_id=NULL WHERE id=?').run(original.assetId)],
    ['original empty version', (f) => f.sqlite.prepare("UPDATE assets SET version_snapshot='' WHERE id=?").run(original.assetId)],
    ['original empty name', (f) => f.sqlite.prepare("UPDATE assets SET product_name_snapshot='  ' WHERE id=?").run(original.assetId)]]) {
    const f = await replaceFixture({ prepare }); const d = await f.data();
    assert.equal(d.canStart, false, label); assert.equal(d.blockerCode, 'MODEL_COMPATIBILITY_DATA_INSUFFICIENT', label);
    const body = await status(await f.start(), 409, label); assert.equal(body.error.code, 'MODEL_COMPATIBILITY_DATA_INSUFFICIENT', label);
    assert.throws(() => directStart(f), /Invalid replacement start/, label); assert.equal(executionRow(f), undefined, label);
  }
  // Original valid; replacement lacks canonical data or only matches by generic name.
  for (const [label, unit] of [
    ['replacement product_id NULL, same generic name', (f) => addUnit(f, { n: 121, productId: null })],
    ['replacement empty version', (f) => addUnit(f, { n: 122, version: '' })],
    ['replacement empty name', (f) => addUnit(f, { n: 123, name: '' })]]) {
    const f = await replaceFixture(); await f.start(); const u = unit(f);
    assert.equal((await f.data()).candidates.some((c) => c.assetCode === u.assetCode), false, label);
    await status(await f.select('admin', u.assetCode), 409, label); assert.throws(() => directCommit(f, u), /Invalid replacement asset/, label);
    assert.equal(executionRow(f).replacement_asset_id, null, label); assert.equal(location(f, u.assetId).status, 'on_hand', label);
  }
  // Both NULL product_id with identical name/version is still not proof (selection trigger checked directly).
  const both = await replaceFixture(); await both.start(); const nullUnit = addUnit(both, { n: 124, productId: null });
  both.sqlite.exec('DROP TRIGGER trg_replace_commit_asset_update'); both.sqlite.prepare('UPDATE assets SET product_id=NULL WHERE id=?').run(original.assetId);
  assert.throws(() => directCommit(both, nullUnit), /Invalid replacement asset/, 'NULL == NULL is not compatible');
  // Valid, equal, non-null product_id passes; name/version comparison is normalized.
  const ok = await replaceFixture(); await ok.start(); const normalized = addUnit(ok, { n: 125, name: `  ${product.name.toUpperCase()} `, version: product.version.toLowerCase() });
  await status(await ok.select('admin', normalized.assetCode), 200, 'normalized match'); assert.equal(location(ok, normalized.assetId).status, 'reserved');
});

test('M1: completion revalidates canonical eligibility at the database even if consumer guards were bypassed', async () => {
  const cases = [
    ['active after-sales case', 'trg_replace_commit_case_insert', (f) => f.sqlite.exec(`INSERT INTO after_sales_cases(id,case_no,dealer_id,subject,description,status,created_by,asset_id) VALUES('bypass','CASE-BYPASS','dealer','x','x','open','admin','${f.replacement.assetId}')`)],
    ['draft listing', 'trg_replace_commit_listing_insert', (f) => f.sqlite.exec(`INSERT INTO marketplace_listings(id,asset_id,channel_id,sales_account_id,title,price_minor,currency,status,created_by) VALUES('bypass','${f.replacement.assetId}','channel-ebay-uk','account-test','x',1,'GBP','draft','admin')`)],
    ['transfer', 'trg_replace_commit_transfer_insert', (f) => f.sqlite.exec(`INSERT INTO asset_transfers(id,asset_id,from_warehouse_id,to_warehouse_id,status,created_by) VALUES('bypass','${f.replacement.assetId}','wh-uk','wh-sg','created','admin')`)],
    ['fulfilled allocation', 'trg_replace_commit_allocation_insert', (f) => f.sqlite.exec(`INSERT INTO international_asset_allocations(allocation_id,order_id,asset_id,status) VALUES('bypass','order-test','${f.replacement.assetId}','fulfilled')`)],
    ['product changed', 'trg_replace_commit_asset_update', (f) => f.sqlite.prepare("UPDATE assets SET version_snapshot='Other Kit' WHERE id=?").run(f.replacement.assetId)],
    ['quarantined', 'trg_replace_commit_asset_update', (f) => f.sqlite.prepare("UPDATE assets SET inventory_status='QUARANTINED' WHERE id=?").run(f.replacement.assetId)],
    ['location released', 'trg_replace_commit_location_update', (f) => f.sqlite.prepare("UPDATE asset_locations SET status='on_hand' WHERE asset_id=?").run(f.replacement.assetId)],
    ['custody changed', 'trg_replace_commit_location_update', (f) => f.sqlite.prepare("UPDATE asset_locations SET custody='SERVICE_CENTER' WHERE asset_id=?").run(f.replacement.assetId)],
    ['warehouse inactive', null, (f) => f.sqlite.exec("UPDATE warehouses SET status='inactive' WHERE id='wh-uk'")],
    ['original left quarantine area', null, (f) => f.sqlite.prepare("UPDATE asset_locations SET custody='SERVICE_CENTER' WHERE asset_id=?").run(original.assetId)],
    ['another open case on original', 'trg_rma_intake_active_insert', (f) => f.sqlite.exec(`INSERT INTO after_sales_cases(id,case_no,dealer_id,subject,description,status,created_by,asset_id) VALUES('bypass-original','CASE-BYPASS-O','dealer','x','x','open','admin','${original.assetId}')`)]];
  for (const [label, guard, mutate] of cases) {
    const f = await replaceFixture(); await ready(f); if (guard) f.sqlite.exec(`DROP TRIGGER ${guard}`); mutate(f);
    assert.throws(() => directComplete(f), /Invalid replacement completion/, label);
    await status(await f.complete(), 409, label); assert.equal(executionRow(f).status, 'REPLACEMENT_IN_PROGRESS', label);
  }
});

test('M3: Start requires the original delivered sale chain at the database', async () => {
  for (const [label, mutate] of [
    ['order not delivered', (f) => { f.sqlite.exec("UPDATE orders SET status='shipped' WHERE id='order-test'"); }],
    ['allocation not fulfilled', (f) => f.sqlite.exec("UPDATE international_asset_allocations SET status='released' WHERE order_id='order-test'")],
    ['duplicate fulfilled allocation', (f) => f.sqlite.exec(`INSERT INTO international_asset_allocations(allocation_id,order_id,asset_id,status) VALUES('dup','order-test','${original.assetId}','fulfilled')`)],
    ['sales account mismatch', (f) => f.sqlite.exec("INSERT OR IGNORE INTO sales_accounts(id,channel_id,account_name,market_region) VALUES('account-sg','channel-ebay-uk','SG account','SG'); UPDATE orders SET sales_account_id='account-sg' WHERE id='order-test'")],
    ['account market mismatch', (f) => f.sqlite.exec("UPDATE sales_accounts SET market_region='SG' WHERE id='account-test'")],
    ['return not received', (f) => f.sqlite.exec(`UPDATE after_sales_cases SET return_received_at=NULL WHERE id='${f.rma.id}'`)]]) {
    const f = await replaceFixture(); mutate(f);
    assert.throws(() => directStart(f), /Invalid replacement start/, label); assert.equal(executionRow(f), undefined, label);
    await status(await f.start(), 409, label); assert.equal(executionRow(f), undefined, label);
  }
});

test('M4: consumers cannot re-activate transfers, listings, allocations or critical Asset state of a committed unit', async () => {
  const f = await replaceFixture(); await f.start();
  f.sqlite.exec(`INSERT INTO asset_transfers(id,asset_id,from_warehouse_id,to_warehouse_id,status,created_by) VALUES('old-transfer','${f.replacement.assetId}','wh-uk','wh-sg','cancelled','admin');
    INSERT INTO marketplace_listings(id,asset_id,channel_id,sales_account_id,title,price_minor,currency,status,created_by) VALUES('old-listing','${f.replacement.assetId}','channel-ebay-uk','account-test','Old',1,'GBP','cancelled','admin')`);
  await status(await f.select(), 200);
  for (const next of ['created', 'shipped', 'received']) assert.throws(() => f.sqlite.exec(`UPDATE asset_transfers SET status='${next}' WHERE id='old-transfer'`), /transfer forbidden/, `transfer -> ${next}`);
  for (const next of ['draft', 'active', 'paused', 'reserved', 'sold']) assert.throws(() => f.sqlite.exec(`UPDATE marketplace_listings SET status='${next}' WHERE id='old-listing'`), /listing forbidden/, `listing -> ${next}`);
  f.sqlite.exec("UPDATE marketplace_listings SET status='ended' WHERE id='old-listing'");
  // A draft that slipped past the insert guard still cannot be sold.
  f.sqlite.exec(`DROP TRIGGER trg_replace_commit_listing_insert; INSERT INTO marketplace_listings(id,asset_id,channel_id,sales_account_id,title,price_minor,currency,status,created_by) VALUES('slipped','${f.replacement.assetId}','channel-ebay-uk','account-test','Draft',1,'GBP','draft','admin')`);
  assert.throws(() => f.sqlite.exec("UPDATE marketplace_listings SET status='sold' WHERE id='slipped'"), /listing forbidden/, 'draft -> sold');
  f.sqlite.exec("UPDATE marketplace_listings SET status='cancelled' WHERE id='slipped'");
  for (const state of ['reserved', 'fulfilled']) assert.throws(() => f.sqlite.exec(`INSERT INTO international_asset_allocations(allocation_id,order_id,asset_id,status) VALUES('a-${state}','order-test','${f.replacement.assetId}','${state}')`), /allocation forbidden/, state);
  for (const sql of ["current_sn='CHANGED'", "original_sn='CHANGED'", "product_id='product-other'", "product_name_snapshot='Other'", "version_snapshot='Other'", "inventory_status='QUARANTINED'"])
    assert.throws(() => f.sqlite.exec(`UPDATE assets SET ${sql} WHERE id='${f.replacement.assetId}'`), /critical field change forbidden/, sql);
  assert.throws(() => f.sqlite.exec(`UPDATE assets SET asset_code='MC-CHANGED' WHERE id='${f.replacement.assetId}'`), /immutable/);
  f.sqlite.exec(`UPDATE assets SET warranty_override_reason='non-critical note' WHERE id='${f.replacement.assetId}'`);
  await status(await f.request('admin', `/admin/assets/${f.replacement.assetId}`, { currentSn: 'CHANGED-SN' }, 'PATCH'), 409, 'admin SN edit');
  assert.equal(f.sqlite.prepare('SELECT current_sn FROM assets WHERE id=?').get(f.replacement.assetId).current_sn, `SN-${f.replacement.assetCode}`);
  await status(await f.complete(), 200, 'terminal listings and cancelled transfers do not block completion');
  assert.deepEqual(location(f, f.replacement.assetId), { warehouse_id: 'wh-uk', status: 'reserved', custody: 'WAREHOUSE' });
  assert.equal(f.sqlite.prepare('SELECT inventory_status FROM assets WHERE id=?').get(f.replacement.assetId).inventory_status, 'NORMAL');
  // Guards do not freeze unrelated Assets.
  const free = addUnit(f, { n: 131 }); f.sqlite.exec(`UPDATE assets SET version_snapshot='Other Kit' WHERE id='${free.assetId}'; UPDATE asset_locations SET status='reserved' WHERE asset_id='${free.assetId}'`);
});

test('L1: candidate filtering happens before LIMIT', async () => {
  const f = await replaceFixture(); await f.start();
  for (let n = 0; n < 60; n++) addUnit(f, { n: 200 + n, code: `MC-26-AAAA-${String(n).padStart(6, '0')}`, version: 'Other Kit' });
  const late = addUnit(f, { n: 300, code: 'MC-26-ZZZZ-000300' });
  const codes = (await f.data()).candidates.map((c) => c.assetCode); assert.ok(codes.includes(late.assetCode)); assert.ok(codes.includes(f.replacement.assetCode));
  assert.equal(codes.some((c) => c.startsWith('MC-26-AAAA')), false);
});

test('L2: free-text notes stay out of Asset lifecycle metadata', async () => {
  const f = await replaceFixture(); await ready(f); const notes = 'Synthetic free text — must not spread to Asset lifecycle';
  await status(await f.complete('admin', f.replacement.assetCode, notes), 200);
  const metadata = f.sqlite.prepare("SELECT new_value_json,description FROM asset_events WHERE source='international-rma-replace'").all().map((r) => `${r.new_value_json} ${r.description}`).join(' ');
  assert.equal(metadata.includes(notes), false); assert.equal(metadata.includes('execution_notes'), false);
  assert.ok(f.sqlite.prepare("SELECT after_json FROM audit_logs WHERE action='international.rma.replacement_execution_completed'").get().after_json.includes(notes), 'kept in the protected audit record');
  assert.equal(executionRow(f).execution_notes, notes);
});

test('0045 preserves 0043/0044 objects, events and B-5E2 behaviour', () => {
  const root = new URL('../apps/api/migrations/', import.meta.url); const names = readdirSync(root).filter((n) => /^\d{4}.*\.sql$/.test(n)).sort();
  const db = new DatabaseSync(':memory:'); for (const n of names.filter((n) => n < '0045')) db.exec(readFileSync(new URL(n, root), 'utf8'));
  db.exec(`INSERT INTO assets(id,asset_code) VALUES('history-asset','MC-HISTORY');
    INSERT INTO asset_events(id,asset_id,event_type,title,source) VALUES('h1','history-asset','customer_return_released','Released','international-customer-return-release'),
      ('h2','history-asset','replacement_asset_committed','Committed','international-rma-replace')`);
  const migration = readFileSync(new URL('0045_rma_replace_execution_hardening.sql', root), 'utf8');
  const replaced = new Set([...migration.matchAll(/DROP TRIGGER (\w+)/g)].map((m) => m[1]));
  const schema = () => new Map(db.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all().map((r) => [r.name, r.sql]));
  const before = schema(); const rows = db.prepare('SELECT * FROM asset_events ORDER BY id').all();
  db.exec(migration); const after = schema();
  for (const [name, sql] of before) if (!replaced.has(name)) assert.equal(after.get(name), sql, `preserved: ${name}`);
  for (const name of replaced) assert.ok(after.has(name), `recreated: ${name}`);
  for (const name of ['trg_customer_return_release_valid', 'idx_customer_return_release_event', 'idx_rma_replace_events', 'idx_rma_replace_committed_asset']) assert.ok(after.has(name), name);
  assert.deepEqual(db.prepare('SELECT * FROM asset_events ORDER BY id').all(), rows);
  for (const type of ['customer_return_released', 'replacement_execution_started', 'replacement_asset_committed', 'replacement_execution_completed'])
    db.exec(`INSERT INTO asset_events(id,asset_id,event_type,title) VALUES('new-${type}','history-asset','${type}','ok')`);
});
