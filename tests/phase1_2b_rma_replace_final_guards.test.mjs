import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { URL } from 'node:url';
import { addUnit, original, replaceFixture } from './helpers/replaceFixture.mjs';

// B-5F1 final guards (0046): completion revalidates the original sales chain and
// a committed replacement unit's asset_status is frozen. Direct SQL proves the
// database, not the API, is the final authority.
const status = async (response, expected, label) => { const body = await response.text(); assert.equal(response.status, expected, `${label ?? ''} ${body}`); return body ? JSON.parse(body) : null; };
const executionRow = (f) => f.sqlite.prepare('SELECT * FROM rma_replace_executions').get();
const locationStatus = (f, id) => f.sqlite.prepare('SELECT status FROM asset_locations WHERE asset_id=?').get(id).status;
const assetStatus = (f, id) => f.sqlite.prepare('SELECT asset_status FROM assets WHERE id=?').get(id).asset_status;
const count = (f, table, where) => f.sqlite.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`).get().n;
const directComplete = (f) => f.sqlite.prepare(`UPDATE rma_replace_executions SET status='REPLACEMENT_COMPLETED',completed_by='admin',completed_at='2099-01-01T00:00:00Z',
  execution_notes='direct',completion_fingerprint='direct' WHERE rma_id=?`).run(f.rma.id);
const ready = async (f) => { await status(await f.start(), 200, 'start'); await status(await f.select(), 200, 'select'); };
const conflicting = ['in_service', 'scrapped', 'unknown', 'refurbished', 'returned_to_inventory', 'resold'];

const assertNoPartialCompletion = (f, label) => {
  const e = executionRow(f); assert.equal(e.status, 'REPLACEMENT_IN_PROGRESS', label); assert.equal(e.completed_at, null, label); assert.equal(e.replacement_asset_id, f.replacement.assetId, label);
  assert.equal(locationStatus(f, f.replacement.assetId), 'reserved', label);
  assert.equal(f.sqlite.prepare('SELECT service_stage FROM after_sales_cases WHERE id=?').get(f.rma.id).service_stage, 'REPLACEMENT_IN_PROGRESS', label);
  assert.equal(count(f, 'asset_events', "event_type='replacement_execution_completed'"), 0, label);
};

test('A: original Order moved off delivered blocks direct DB and API completion without partial state', async () => {
  for (const next of ['shipped', 'cancelled', 'approved']) {
    const f = await replaceFixture(); await ready(f);
    f.sqlite.prepare("UPDATE orders SET status=? WHERE id='order-test'").run(next);
    assert.throws(() => directComplete(f), /Invalid replacement completion/, next); assertNoPartialCompletion(f, next);
    await status(await f.complete(), 409, next); assertNoPartialCompletion(f, next);
  }
});

test('A2: original Order Sales Account or market drift blocks completion', async () => {
  for (const [label, mutate] of [
    ['sales account mismatch', (f) => f.sqlite.exec("INSERT OR IGNORE INTO sales_accounts(id,channel_id,account_name,market_region) VALUES('account-sg','channel-ebay-uk','SG account','SG'); UPDATE orders SET sales_account_id='account-sg' WHERE id='order-test'")],
    ['account market mismatch', (f) => f.sqlite.exec("UPDATE sales_accounts SET market_region='SG' WHERE id='account-test'")],
    ['fulfilment warehouse changed', (f) => f.sqlite.exec("UPDATE orders SET fulfilment_warehouse_id='wh-sg' WHERE id='order-test'")]]) {
    const f = await replaceFixture(); await ready(f); mutate(f);
    assert.throws(() => directComplete(f), /Invalid replacement completion/, label); assertNoPartialCompletion(f, label);
  }
});

test('B: fulfilled Allocation released or cancelled blocks completion; stale non-fulfilled rows never count', async () => {
  for (const next of ['released', 'cancelled']) {
    const f = await replaceFixture(); await ready(f);
    f.sqlite.prepare("UPDATE international_asset_allocations SET status=? WHERE order_id='order-test' AND asset_id=?").run(next, original.assetId);
    // An old released row alongside must not make the chain look valid.
    f.sqlite.prepare("INSERT INTO international_asset_allocations(allocation_id,order_id,asset_id,status) VALUES('stale','order-test',?,'released')").run(original.assetId);
    assert.throws(() => directComplete(f), /Invalid replacement completion/, next); assertNoPartialCompletion(f, next);
    await status(await f.complete(), 409, next); assertNoPartialCompletion(f, next);
  }
  const f = await replaceFixture(); await ready(f);
  f.sqlite.prepare("INSERT INTO international_asset_allocations(allocation_id,order_id,asset_id,status) VALUES('dup','order-test',?,'fulfilled')").run(original.assetId);
  assert.throws(() => directComplete(f), /Invalid replacement completion/, 'duplicate fulfilled Allocation is not the single valid relationship'); assertNoPartialCompletion(f, 'duplicate');
});

test('C: deleting the fulfilled Allocation blocks completion', async () => {
  const f = await replaceFixture(); await ready(f);
  f.sqlite.prepare("DELETE FROM international_asset_allocations WHERE order_id='order-test' AND asset_id=?").run(original.assetId);
  assert.equal(count(f, 'international_asset_allocations', `asset_id='${original.assetId}'`), 0, 'schema permits the delete; the completion guard must catch it');
  assert.throws(() => directComplete(f), /Invalid replacement completion/); assertNoPartialCompletion(f, 'deleted allocation');
  await status(await f.complete(), 409);
});

test('D: the intact delivered sales chain still completes, both directly and via the API', async () => {
  const api = await replaceFixture(); await ready(api);
  const done = await status(await api.complete(), 200); assert.equal(done.executionStatus, 'REPLACEMENT_COMPLETED'); assert.equal(locationStatus(api, api.replacement.assetId), 'reserved');
  const direct = await replaceFixture(); await ready(direct); directComplete(direct); assert.equal(executionRow(direct).status, 'REPLACEMENT_COMPLETED');
});

test('asset_status of a committed replacement is frozen while in progress and after completion (API 409 + DB abort)', async () => {
  const f = await replaceFixture(); await ready(f); const unit = f.replacement.assetId; assert.equal(assetStatus(f, unit), 'active');
  const check = async (phase) => {
    for (const next of conflicting) {
      await status(await f.request('admin', `/admin/assets/${unit}`, { assetStatus: next }, 'PATCH'), 409, `${phase} API -> ${next}`);
      assert.throws(() => f.sqlite.prepare('UPDATE assets SET asset_status=? WHERE id=?').run(next, unit), /critical field change forbidden/, `${phase} DB -> ${next}`);
      assert.equal(assetStatus(f, unit), 'active', `${phase} ${next}`);
    }
    // Harmless fields stay editable; a no-op status write is not a change.
    await status(await f.request('admin', `/admin/assets/${unit}`, { warrantyOverrideReason: `note ${phase}`, assetStatus: 'active' }, 'PATCH'), 200, `${phase} harmless`);
    f.sqlite.prepare("UPDATE assets SET asset_status='active' WHERE id=?").run(unit);
  };
  await check('in progress');
  await status(await f.complete(), 200, 'complete'); assert.equal(executionRow(f).status, 'REPLACEMENT_COMPLETED');
  await check('completed');
});

test('asset_status guard does not touch unrelated or uncommitted Assets', async () => {
  const f = await replaceFixture(); await ready(f); const free = addUnit(f, { n: 140 });
  for (const next of conflicting) {
    f.sqlite.prepare('UPDATE assets SET asset_status=? WHERE id=?').run(next, free.assetId); assert.equal(assetStatus(f, free.assetId), next);
  }
  await status(await f.request('admin', `/admin/assets/${free.assetId}`, { assetStatus: 'refurbished' }, 'PATCH'), 200, 'unrelated API edit');
  assert.equal(assetStatus(f, free.assetId), 'refurbished');
  // Before commitment the candidate itself is unaffected too.
  const g = await replaceFixture(); await status(await g.start(), 200);
  await status(await g.request('admin', `/admin/assets/${g.replacement.assetId}`, { assetStatus: 'refurbished' }, 'PATCH'), 200, 'uncommitted candidate');
});

test('0046 only adds guards and preserves every earlier object and row', () => {
  const root = new URL('../apps/api/migrations/', import.meta.url); const names = readdirSync(root).filter((n) => /^\d{4}.*\.sql$/.test(n)).sort();
  assert.equal(names.at(-1), '0046_rma_replace_execution_final_guards.sql');
  const migration = readFileSync(new URL('0046_rma_replace_execution_final_guards.sql', root), 'utf8');
  assert.doesNotMatch(migration, /\bDROP\b|\bALTER\b|\bINSERT\b|\bDELETE\b|UPDATE\s+\w+\s+SET/i, 'no destructive or data-changing statements');
  const db = new DatabaseSync(':memory:'); for (const n of names.filter((n) => n < '0046')) db.exec(readFileSync(new URL(n, root), 'utf8'));
  db.exec("INSERT INTO assets(id,asset_code) VALUES('history-asset','MC-HISTORY'); INSERT INTO asset_events(id,asset_id,event_type,title,source) VALUES('h1','history-asset','replacement_asset_committed','Committed','international-rma-replace')");
  const schema = () => new Map(db.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all().map((r) => [r.name, r.sql]));
  const before = schema(), rows = db.prepare('SELECT * FROM asset_events ORDER BY id').all();
  db.exec(migration); const after = schema();
  for (const [name, sql] of before) assert.equal(after.get(name), sql, `preserved: ${name}`);
  assert.deepEqual([...after.keys()].filter((n) => !before.has(n)).sort(), ['trg_replace_commit_asset_status', 'trg_rma_replace_complete_sales_chain']);
  assert.deepEqual(db.prepare('SELECT * FROM asset_events ORDER BY id').all(), rows);
});
