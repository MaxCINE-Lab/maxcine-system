import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

// Fixed Staging only. Synthetic Staging replacement execution acceptance data.
// No physical customer replacement represented; no shipment is created.
// Seed first: scripts/fixtures/b5f1-replace-staging-fixture.sql. Never touches MC-RMA-26-000001.
// Pair 2 (B5F1-000003/000004) carries a canonical product_id as required by 0045.
// Pair 1 (B5F1-000001/000002) is completed history and is only read here.
const api = 'https://maxcine-api-staging.maxcine-lab.workers.dev', web = 'https://maxcine-web-staging.pages.dev';
const orderId = '42000000-0000-4000-8000-0000000b5f02';
const originalAsset = { id: '43000000-0000-4000-8000-0000000b5f03', code: 'MC-26-B5F1-000003', sn: 'STG-B5F1-ORIGINAL-000003' };
const replacementAsset = { id: '43000000-0000-4000-8000-0000000b5f04', code: 'MC-26-B5F1-000004' };
const firstPair = { original: 'MC-26-B5F1-000001', replacement: 'MC-26-B5F1-000002' };
const repairCase = 'MC-RMA-26-000001';
const synthetic = 'Synthetic Staging replacement execution acceptance data. No physical customer replacement represented.';
const directory = 'test-results/rma-replace-staging'; await mkdir(directory, { recursive: true });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5XcAAAAASUVORK5CYII=', 'base64');

async function login(persona) {
  const response = await fetch(`${api}/dev/quick-login`, { method: 'POST', headers: { Origin: web, 'Content-Type': 'application/json' }, body: JSON.stringify({ persona }), signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, persona); const cookie = response.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
  return (path, body) => fetch(`${api}${path}`, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, Origin: web, ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) },
    ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
}
const expect = async (request, path, body, status) => { const response = await request(path, body); const text = await response.text(); assert.equal(response.status, status, `${path} ${text}`); return text ? JSON.parse(text) : null; };
const get = (request, path) => expect(request, path, undefined, 200);
const admin = await login('ADMIN'), uk = await login('UK_FULFILMENT');
const repairBefore = (await get(admin, '/international/rmas')).rmas.find((r) => r.rmaReference === repairCase);

// Canonical sale chain for the synthetic original unit (resumable).
// An approved order has no detail view until an Asset is bound (409), which means "not yet bound".
const unbound = (await uk(`/international/orders/${orderId}`)).status === 409;
let order = unbound ? { status: 'approved' } : (await get(uk, `/international/orders/${orderId}`)).order;
if (order.status === 'approved') { await expect(uk, `/international/orders/${orderId}/bind-asset`, { assetId: originalAsset.id }, 200);
  await expect(uk, `/international/orders/${orderId}/ship`, { assetCode: originalAsset.code, carrier: 'Synthetic Staging', trackingNumber: 'STG-B5F1-NOT-A-REAL-SHIPMENT' }, 200); }
order = (await get(uk, `/international/orders/${orderId}`)).order;
if (order.status === 'shipped') await expect(uk, `/international/orders/${orderId}/deliver`, {}, 200);
// Canonical reverse chain up to an explicit REPLACE decision (resumable).
let rma = (await get(admin, '/international/rmas')).rmas.find((r) => r.assetCode === originalAsset.code);
if (!rma) rma = (await expect(uk, '/international/rmas', { assetId: originalAsset.id, orderId, reason: 'DEFECTIVE', reasonNote: synthetic, returnWarehouseId: 'wh-uk' }, 200)).rma;
const base = `/international/rmas/${rma.id}`, replace = `${base}/replacement-execution`;
const stage = async () => (await get(admin, base)).rma.businessStatus;
if (await stage() === 'RETURN_AUTHORIZED') await expect(uk, `${base}/return-shipment`, { carrier: 'Synthetic Staging', returnTracking: 'STG-B5F1-RETURN-NOT-REAL' }, 200);
if (await stage() === 'RETURN_IN_TRANSIT') await expect(uk, `${base}/receive-return`, { assetCode: originalAsset.code }, 200);
if (['RECEIVED', 'INSPECTION_IN_PROGRESS'].includes(await stage())) {
  let inspection = (await get(uk, `${base}/inspection`)).inspection;
  if (!inspection) inspection = (await expect(uk, `${base}/inspection/start`, { assetCode: originalAsset.code }, 200)).inspection;
  if (!inspection.evidence?.length) { const form = new FormData(); form.set('category', 'OVERALL_CONDITION'); form.set('file', new File([png], 'STAGING-SYNTHETIC-NOT-PHYSICAL.png', { type: 'image/png' })); await expect(uk, `${base}/inspection/evidence`, form, 201); }
  await expect(uk, `${base}/inspection/complete`, { assetCode: originalAsset.code, observedSn: originalAsset.sn, snVerification: 'MATCH',
    checklist: ['IDENTITY', 'EXTERIOR', 'DISPLAY', 'LENS_CAMERA', 'POWER', 'FUNCTIONAL', 'ACCESSORIES', 'RETURN_REASON'].map((item) => ({ item, result: 'PASS', notes: synthetic })),
    findings: { issueReproduced: 'YES', conditionAssessment: 'FUNCTIONAL_DEFECT', inspectorNotes: synthetic } }, 200);
}
if (await stage() === 'INSPECTION_COMPLETED') {
  const inspection = (await get(admin, `${base}/inspection`)).inspection;
  await expect(admin, `${base}/resolution`, { inspectionId: inspection.id, resolutionType: 'REPLACE', decisionReason: synthetic, decisionNotes: '' }, 200);
}
const initial = await get(admin, replace); assert.equal(initial.resolutionType, 'REPLACE');
const warrantyBefore = await get(admin, `/assets/${originalAsset.id}`), orderBefore = (await get(uk, `/international/orders/${orderId}`)).order;
const replacementBefore = await get(admin, `/assets/${replacementAsset.id}`);

// Explicit authority only.
const denied = [];
for (const persona of ['UK_FULFILMENT', 'CN_SD_WAREHOUSE', 'CERTIFIED', 'INTERNATIONAL']) {
  const request = persona === 'UK_FULFILMENT' ? uk : await login(persona);
  for (const [path, body] of [[`${replace}/start`, {}], [`${replace}/replacement-asset`, { replacementAssetCode: replacementAsset.code }], [`${replace}/complete`, { replacementAssetCode: replacementAsset.code, executionNotes: synthetic }]])
    assert.equal((await request(path, body)).status, 403, `${persona} ${path}`);
  denied.push(persona);
}

const browser = await chromium.launch({ headless: true }), page = await browser.newPage({ viewport: { width: 1440, height: 1150 } }); page.setDefaultTimeout(30000);
let browserStarted = false, wrongAssetRejected = false, browserCommitted = false, browserCompleted = false;
try {
  await page.goto(web, { waitUntil: 'networkidle' }); await page.getByRole('button', { name: /^管理员/ }).click(); await page.locator('.system-main').waitFor(); await page.waitForLoadState('networkidle');
  await page.goto(`${web}/#/system/international/rmas/${rma.id}`); const panel = page.getByTestId('rma-replacement'); await panel.waitFor();
  if ((await get(admin, replace)).executionStatus === 'NOT_STARTED') { await panel.getByRole('button', { name: 'Start Replacement Execution', exact: true }).click(); await panel.getByLabel('Replacement Asset Code', { exact: true }).waitFor(); browserStarted = true; }
  if (!(await get(admin, replace)).execution.replacementAssetCode) {
    for (const wrong of [originalAsset.code, 'MC-26-P12A-000012', firstPair.replacement]) {
      await panel.getByLabel('Replacement Asset Code', { exact: true }).fill(wrong); await panel.getByRole('button', { name: 'Commit Replacement Asset', exact: true }).click();
      await panel.getByRole('alert').waitFor(); assert.equal((await get(admin, replace)).execution.replacementAssetCode, null);
    }
    wrongAssetRejected = true; await page.screenshot({ path: `${directory}/ineligible-replacement-rejected.png`, fullPage: true });
    await panel.getByLabel('Replacement Asset Code', { exact: true }).fill(replacementAsset.code); await panel.getByRole('button', { name: 'Commit Replacement Asset', exact: true }).click();
    await panel.getByTestId('replacement-asset').waitFor(); browserCommitted = true; await page.screenshot({ path: `${directory}/replacement-committed.png`, fullPage: true });
  }
  if ((await get(admin, replace)).executionStatus === 'REPLACEMENT_IN_PROGRESS') {
    const submit = panel.getByRole('button', { name: 'Complete Replacement Execution', exact: true }); assert.equal(await submit.isDisabled(), true, 'explicit confirmation required');
    await panel.getByLabel('Confirm Replacement Asset Code', { exact: true }).fill(replacementAsset.code); await panel.getByLabel('Replacement Execution Notes', { exact: true }).fill(synthetic);
    assert.equal(await submit.isDisabled(), true, 'checkbox confirmation required'); await panel.getByLabel('Confirm Replacement Preparation', { exact: true }).check();
    await submit.click(); browserCompleted = true;
  }
  await panel.getByText(/Replacement prepared — shipment pending/).first().waitFor(); assert.equal(await panel.getByRole('button', { name: /Start|Commit|Complete/ }).count(), 0);
  await page.screenshot({ path: `${directory}/replacement-prepared-shipment-pending.png`, fullPage: true });
  await page.reload({ waitUntil: 'networkidle' }); await panel.getByText(/Replacement prepared — shipment pending/).first().waitFor();
} catch (error) { await page.screenshot({ path: `${directory}/failure.png`, fullPage: true }); await writeFile(`${directory}/failure-page.txt`, `${page.url()}\n${await page.locator('body').innerText()}`); throw error; } finally { await browser.close(); }

const final = await get(admin, replace);
assert.equal(final.executionStatus, 'REPLACEMENT_COMPLETED'); assert.equal(final.shipmentPending, true); assert.equal(final.rmaOpen, true);
assert.equal(final.execution.replacementAssetCode, replacementAsset.code); assert.equal(final.execution.executionNotes, synthetic);
// Exact retries are reads; conflicting retries are 409.
for (let n = 0; n < 3; n++) { await expect(admin, `${replace}/replacement-asset`, { replacementAssetCode: replacementAsset.code }, 200); await expect(admin, `${replace}/complete`, { replacementAssetCode: replacementAsset.code, executionNotes: synthetic }, 200); }
await expect(admin, `${replace}/start`, {}, 409); await expect(admin, `${replace}/complete`, { replacementAssetCode: replacementAsset.code, executionNotes: 'Different notes' }, 409);
await expect(admin, `${replace}/replacement-asset`, { replacementAssetCode: 'MC-26-P12A-000012' }, 409);
assert.deepEqual(await get(admin, replace), final);
// Original unit: still quarantined, warranty / order unchanged. Replacement: separate, reserved, not sellable.
const originalNow = await get(admin, `/international/assets/${originalAsset.id}`), replacementNow = await get(admin, `/international/assets/${replacementAsset.id}`);
assert.equal(originalNow.asset.inventoryStatus, 'QUARANTINED'); assert.equal(originalNow.asset.custody, 'WAREHOUSE');
assert.equal(replacementNow.asset.custody, 'WAREHOUSE'); assert.equal(replacementNow.asset.locationStatus, 'reserved'); assert.equal(replacementNow.asset.inventoryStatus, 'NORMAL');
assert.equal(replacementNow.events.filter((e) => /shipped|delivered|sold/.test(e.eventType)).length, 0);
const warrantyNow = await get(admin, `/assets/${originalAsset.id}`), replacementWarranty = await get(admin, `/assets/${replacementAsset.id}`);
for (const key of ['certifiedWarranty', 'publicWarranty']) { assert.deepEqual(warrantyNow[key], warrantyBefore[key], key); assert.deepEqual(replacementWarranty[key], replacementBefore[key], `replacement ${key}`); }
for (const key of ['warrantyStartAt', 'warrantyEndAt', 'warrantyOverrideStatus', 'currentSn', 'originalSn']) { assert.equal(warrantyNow.asset[key], warrantyBefore.asset[key], key); assert.equal(replacementWarranty.asset[key], replacementBefore.asset[key], key); }
const orderNow = (await get(uk, `/international/orders/${orderId}`)).order;
for (const key of ['status', 'allocationStatus', 'assetCode', 'deliveredAt', 'trackingNumber']) assert.equal(orderNow[key], orderBefore[key], key);
assert.equal((await get(uk, '/international/warehouses/assets?warehouseId=wh-uk')).assets.some((a) => a.assetId === replacementAsset.id), false);
assert.equal((await get(admin, base)).rma.businessStatus, 'REPLACEMENT_COMPLETED');
const repairAfter = (await get(admin, '/international/rmas')).rmas.find((r) => r.rmaReference === repairCase);
assert.equal(repairAfter.businessStatus, repairBefore.businessStatus, 'REPAIR acceptance case untouched'); assert.equal(repairAfter.inventoryStatus, repairBefore.inventoryStatus);
const events = ['replacement_execution_started', 'replacement_asset_committed', 'replacement_execution_completed'];
const counts = Object.fromEntries(events.map((e) => [e, [originalNow.events.filter((x) => x.eventType === e).length, replacementNow.events.filter((x) => x.eventType === e).length]]));
assert.deepEqual(counts, { replacement_execution_started: [1, 0], replacement_asset_committed: [1, 1], replacement_execution_completed: [1, 1] });
// The first, already completed execution still reads unchanged after 0045.
const firstRma = (await get(admin, '/international/rmas')).rmas.find((r) => r.assetCode === firstPair.original);
const first = firstRma ? await get(admin, `/international/rmas/${firstRma.id}/replacement-execution`) : null;
if (first) { assert.equal(first.executionStatus, 'REPLACEMENT_COMPLETED'); assert.equal(first.replacementAsset.assetCode, firstPair.replacement); assert.equal(first.replacementAsset.locationStatus, 'reserved'); }
const report = { environment: 'Staging only', firstPair: first ? { rma: firstRma.rmaReference, status: first.executionStatus, replacement: first.replacementAsset.assetCode } : null, synthetic, rma: rma.rmaReference, originalAsset: originalAsset.code, replacementAsset: replacementAsset.code, browserStarted, wrongAssetRejected, browserCommitted, browserCompleted,
  denied, execution: final.execution, original: originalNow.asset, replacement: replacementNow.asset, lifecycleCounts: counts, orderUnchanged: true, warrantyUnchanged: true, shipmentCreated: false, repairCaseUntouched: repairAfter.businessStatus };
await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
