import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { assetId, postRepairFixture } from './helpers/postRepairFixture.mjs';
import { original, replaceFixture } from './helpers/replaceFixture.mjs';

// Cross-feature regression for B-5E2 (Customer Return Release) and B-5F1 (REPLACE Execution) on one tree.
const { hasInternationalAccess } = await import('../apps/web/src/internationalAccess.ts');
const releaseReason = 'Synthetic integration customer-return release. No physical shipment represented.';
const count = (f, table, where = '1=1') => f.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get().n;
const warrantyRows = (f) => ['asset_public_warranties', 'asset_public_warranty_entitlements'].map((t) => f.sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all());
const caseRow = (f) => ({ ...f.sqlite.prepare('SELECT status,service_stage,cross_border_resolution,outbound_shipped_at FROM after_sales_cases WHERE id=?').get(f.rma.id) });

test('REPAIR path: release stays valid only while the latest Certification holds and never falls back', async () => {
  for (const status of ['revoked', 'suspended']) {
    const f = await postRepairFixture(); await f.inspected(); assert.equal((await f.decide()).status, 200);
    const warranty = warrantyRows(f), endpoint = `${f.base}/customer-return-release`, replace = `${f.base}/replacement-execution`;
    assert.equal((await f.request('admin', endpoint, { reason: releaseReason })).status, 200);
    let body = await (await f.request('admin', endpoint)).json();
    assert.equal(body.state, 'CUSTOMER_RETURN_RELEASED'); assert.equal(body.releaseCurrentlyValid, true); assert.equal(body.inventory.inventoryStatus, 'QUARANTINED'); assert.equal(body.inventory.sellable, false);
    // A released REPAIR case is never a replacement case.
    const replacement = await f.request('admin', replace); assert.equal(replacement.status, 200); assert.equal((await replacement.json()).canStart, false);
    assert.equal((await f.request('admin', `${replace}/start`, {})).status, 409); assert.equal(count(f, 'rma_replace_executions'), 0);
    const recorded = f.sqlite.prepare('SELECT * FROM rma_customer_return_releases').get();
    f.sqlite.prepare('UPDATE asset_certifications SET certification_status=? WHERE id=(SELECT id FROM current_asset_certifications WHERE asset_id=?)').run(status, assetId);
    body = await (await f.request('admin', endpoint)).json();
    assert.equal(body.state, 'CUSTOMER_RETURN_RELEASED'); assert.equal(body.releaseCurrentlyValid, false, status); assert.match(body.releaseBlockingReason, /Certification/);
    assert.equal(body.certification.version, 2, 'latest version reported; no fallback to v1'); assert.equal(body.certification.status, status);
    assert.deepEqual(f.sqlite.prepare('SELECT * FROM rma_customer_return_releases').get(), recorded);
    assert.deepEqual(caseRow(f), { status: 'in_progress', service_stage: 'REPAIR_COMPLETED', cross_border_resolution: 'REPAIR', outbound_shipped_at: null });
    assert.deepEqual(warrantyRows(f), warranty);
  }
});

test('REPLACE path: completed replacement cannot be customer-return released and keeps both Assets out of sale', async () => {
  const f = await replaceFixture(); const warranty = warrantyRows(f), endpoint = `/international/rmas/${f.rma.id}/customer-return-release`;
  assert.equal((await f.start()).status, 200); assert.equal((await f.select()).status, 200); assert.equal((await f.complete()).status, 200);
  const d = await f.data(); assert.equal(d.executionStatus, 'REPLACEMENT_COMPLETED'); assert.equal(d.shipmentPending, true); assert.equal(d.warrantyChanged, false); assert.equal(d.rmaOpen, true);
  const release = await (await f.request('admin', endpoint)).json();
  assert.equal(release.state, 'NOT_RELEASED'); assert.equal(release.canRelease, false); assert.equal(release.releaseCurrentlyValid, null);
  assert.equal(release.inventory.inventoryStatus, 'QUARANTINED'); assert.equal(release.inventory.sellable, false, 'shared operational-state helper keeps the original unsellable');
  assert.equal((await f.request('admin', endpoint, { reason: releaseReason })).status, 409); assert.equal(count(f, 'rma_customer_return_releases'), 0);
  assert.equal(f.sqlite.prepare('SELECT inventory_status FROM assets WHERE id=?').get(original.assetId).inventory_status, 'QUARANTINED');
  assert.deepEqual({ ...f.sqlite.prepare('SELECT inventory_status FROM assets WHERE id=?').get(f.replacement.assetId) }, { inventory_status: 'NORMAL' });
  assert.equal(f.sqlite.prepare('SELECT status FROM asset_locations WHERE asset_id=?').get(f.replacement.assetId).status, 'reserved');
  const inventory = (await (await f.request('uk', '/international/warehouses/assets?warehouseId=wh-uk')).json()).assets.map((a) => a.assetId);
  assert.equal(inventory.includes(f.replacement.assetId), false); assert.equal(inventory.includes(original.assetId), false);
  assert.deepEqual(caseRow(f), { status: 'in_progress', service_stage: 'REPLACEMENT_COMPLETED', cross_border_resolution: 'REPLACE', outbound_shipped_at: null });
  assert.deepEqual(warrantyRows(f), warranty);
});

test('merged International UI access: both dedicated roles enter; no other persona gains an entry', async () => {
  const f = await replaceFixture();
  const permissionsOf = (role) => f.sqlite.prepare('SELECT permission_code AS code FROM role_permissions WHERE role_id=(SELECT id FROM roles WHERE code=?)').all(role).map((r) => r.code);
  for (const [role, permission] of [['international_customer_return_manager', 'international-customer-return:release'], ['international_replacement_operator', 'international-rma-replace:execute']]) {
    const permissions = permissionsOf(role); assert.ok(permissions.includes(permission), role);
    assert.equal(hasInternationalAccess({ roles: [role], permissions }), true, role);
    assert.equal(hasInternationalAccess({ roles: [], permissions: [permission] }), true, permission);
  }
  // Pre-integration (5c0e953) entry set: personas holding neither new permission must resolve exactly as before.
  const before = ['marketplace:manage', 'transfer:manage', 'international-after-sales:decide', 'international-repair:execute', 'post-repair:read', 'post-repair:inspect', 'post-repair:decide'];
  for (const { code } of f.sqlite.prepare('SELECT code FROM roles').all()) {
    const permissions = permissionsOf(code); if (permissions.includes('international-customer-return:release') || permissions.includes('international-rma-replace:execute')) continue;
    assert.equal(hasInternationalAccess({ roles: [code], permissions }), code === 'international_operator' || before.some((p) => permissions.includes(p)), code);
  }
  for (const role of ['certified_operator', 'warehouse_manager', 'dealer', 'authorized_service_center', 'online_product_consultant'])
    assert.equal(hasInternationalAccess({ roles: [role], permissions: permissionsOf(role) }), false, role);
  assert.equal(hasInternationalAccess({ roles: ['uk_fulfilment_operator'], permissions: ['warehouse:international-read', 'international-order:manage'] }), false, 'UK Fulfilment-only');
  assert.equal(hasInternationalAccess({ roles: [], permissions: ['international-after-sales:read', 'warehouse:international-read', 'international-order:manage', 'certified:read'] }), false);
  const nav = readFileSync(new URL('../apps/web/src/systemNavigation.tsx', import.meta.url), 'utf8');
  assert.match(nav, /import \{ hasInternationalAccess \} from '\.\/internationalAccess';/); assert.match(nav, /export \{ hasInternationalAccess \};/);
  assert.doesNotMatch(nav, /function hasInternationalAccess/, 'single access helper, no divergent copy');
});
