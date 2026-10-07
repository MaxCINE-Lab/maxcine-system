import assert from 'node:assert/strict';
import { Buffer, File } from 'node:buffer';
import { deliveryFixture } from './deliveryFixture.mjs';
const { FormData } = globalThis;

export const product = { id: 'product-replace-fixture', name: 'Synthetic Replace Fixture Drone', version: 'Standard Kit' };
export const original = { assetId: '43000000-0000-4000-8000-000000000099', assetCode: 'MC-26-TEST-000099', orderId: 'order-test', sn: 'STG-REPLACE-ORIGINAL-099' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5XcAAAAASUVORK5CYII=', 'base64');
const returnItems = ['IDENTITY', 'EXTERIOR', 'DISPLAY', 'LENS_CAMERA', 'POWER', 'FUNCTIONAL', 'ACCESSORIES', 'RETURN_REASON'];

// Synthetic unit in a warehouse. Certification facts are fixture inputs, not edits to issued history.
export function addUnit(f, { n, code = `MC-26-REPL-${String(n).padStart(6, '0')}`, warehouse = 'wh-uk', status = 'on_hand', custody = 'WAREHOUSE',
  inventory = 'NORMAL', productId = product.id, name = product.name, version = product.version, cert = 'certified', finalQc = 1, grade = 'A', result = 'PASS' } = {}) {
  const assetId = `45000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  f.sqlite.prepare(`INSERT INTO assets(id,asset_code,asset_status,product_id,product_name_snapshot,version_snapshot,inventory_status,original_sn,current_sn) VALUES(?,?,'active',?,?,?,?,?,?)`)
    .run(assetId, code, productId, name, version, inventory, `SN-${code}`, `SN-${code}`);
  f.sqlite.prepare('INSERT INTO asset_locations(asset_id,warehouse_id,status,custody) VALUES(?,?,?,?)').run(assetId, warehouse, status, custody);
  if (cert) {
    f.sqlite.prepare(`INSERT INTO asset_inspection_tasks(id,asset_id,assigned_to,status,result,grade,final_qc) VALUES(?,?,'cert','completed',?,?,?)`).run(`task-${assetId}`, assetId, result, grade, finalQc);
    f.sqlite.prepare(`INSERT INTO asset_certifications(id,asset_id,inspection_task_id,grade,inspection_result,final_qc,verification_code_hash,certification_status,certification_date)
      VALUES(?,?,?,?,?,?,'test-only',?,'2026-01-01')`).run(`cert-${assetId}`, assetId, `task-${assetId}`, grade, result, finalQc, cert);
  }
  return { assetId, assetCode: code };
}

// Canonical delivery -> RMA -> return -> inspection -> resolution chain through the real API.
export async function openRma(f, unit, resolution = 'REPLACE') {
  const { assetId, assetCode, orderId } = unit;
  assert.equal((await f.request('uk', `/international/orders/${orderId}/bind-asset`, { assetId })).status, 200);
  assert.equal((await f.request('uk', `/international/orders/${orderId}/ship`, { assetCode, carrier: 'Royal Mail', trackingNumber: `RM-${assetCode}` })).status, 200);
  assert.equal((await f.request('uk', `/international/orders/${orderId}/deliver`, {})).status, 200);
  const rma = (await (await f.request('uk', '/international/rmas', { assetId, orderId, reason: 'DEFECTIVE', returnWarehouseId: 'wh-uk' })).json()).rma;
  const base = `/international/rmas/${rma.id}`;
  assert.equal((await f.request('uk', `${base}/return-shipment`, { carrier: 'Royal Mail', returnTracking: `RET-${assetCode}` })).status, 200);
  assert.equal((await f.request('uk', `${base}/receive-return`, { assetCode })).status, 200);
  const inspection = (await (await f.request('uk', `${base}/inspection/start`, { assetCode })).json()).inspection;
  const form = new FormData(); form.set('category', 'OVERALL_CONDITION'); form.set('file', new File([png], 'synthetic-return.png', { type: 'image/png' }));
  assert.equal((await f.request('uk', `${base}/inspection/evidence`, form)).status, 201);
  assert.equal((await f.request('uk', `${base}/inspection/complete`, { assetCode, observedSn: unit.sn, snVerification: 'MATCH',
    checklist: returnItems.map((item) => ({ item, result: 'PASS', notes: 'Synthetic return facts' })),
    findings: { issueReproduced: 'YES', conditionAssessment: 'FUNCTIONAL_DEFECT', inspectorNotes: 'Synthetic only; not a physical inspection' } })).status, 200);
  assert.equal((await f.request('admin', `${base}/resolution`, { inspectionId: inspection.id, resolutionType: resolution, decisionReason: 'Synthetic decision only', decisionNotes: '' })).status, 200);
  return { rma, base: `${base}/replacement-execution` };
}

export async function replaceFixture({ resolution = 'REPLACE', prepare } = {}) {
  const objects = new Map();
  const assets = { async put(key, value) { objects.set(key, value); }, async get(key) { return objects.has(key) ? { body: objects.get(key) } : null; }, async delete(key) { objects.delete(key); } };
  const f = await deliveryFixture({ assets });
  // Canonical product record: compatibility requires a non-null, equal product_id.
  f.sqlite.prepare('INSERT INTO products(id,sku,name,unit_price_cents) VALUES(?,?,?,1)').run(product.id, 'SKU-REPLACE-FIXTURE', product.name);
  f.sqlite.prepare('UPDATE assets SET original_sn=?,current_sn=?,product_id=?,product_name_snapshot=?,version_snapshot=? WHERE id=?').run(original.sn, original.sn, product.id, product.name, product.version, original.assetId);
  f.certify(); prepare?.(f);
  const { rma, base } = await openRma(f, original, resolution);
  const replacement = addUnit(f, { n: 1 });
  const grant = (user, role = 'role-international-replacement-operator') => f.sqlite.prepare('INSERT OR IGNORE INTO user_roles(user_id,role_id) VALUES(?,?)').run(user, role);
  const detail = (user = 'admin') => f.request(user, base);
  const data = async (user = 'admin') => { const response = await detail(user); assert.equal(response.status, 200); return response.json(); };
  const start = (user = 'admin') => f.request(user, `${base}/start`, {});
  const select = (user = 'admin', code = replacement.assetCode, path = base) => f.request(user, `${path}/replacement-asset`, { replacementAssetCode: code });
  const complete = (user = 'admin', code = replacement.assetCode, notes = 'Synthetic replacement prepared; no physical customer replacement', path = base) =>
    f.request(user, `${path}/complete`, { replacementAssetCode: code, executionNotes: notes });
  // Second independent original Asset / Order / RMA for cross-RMA races.
  const second = async () => {
    const unit = { ...addUnit(f, { n: 900, code: 'MC-26-TEST-000900' }), orderId: 'order-test-2', sn: 'SN-MC-26-TEST-000900' };
    f.sqlite.exec(`INSERT INTO orders (id, order_no, dealer_id, store_id, created_by, status, channel_id, sales_account_id, fulfilment_warehouse_id, external_order_id)
      VALUES ('order-test-2', 'TEST-DELIVERY-2', 'dealer', 'store', 'uk', 'approved', 'channel-ebay-uk', 'account-test', 'wh-uk', 'EXT-DELIVERY-2')`);
    return { ...unit, ...(await openRma(f, unit)) };
  };
  return { ...f, rma, base, objects, replacement, grant, detail, data, start, select, complete, second };
}
