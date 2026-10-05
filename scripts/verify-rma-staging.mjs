import assert from 'node:assert/strict';
import { webcrypto as crypto } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

// Fixed Staging endpoints only. Never use a Production override.
const web = 'https://maxcine-web-staging.pages.dev';
const api = 'https://maxcine-api-staging.maxcine-lab.workers.dev';
const orderId = '44000000-0000-4000-8000-000000000003';
const assetId = '43000000-0000-4000-8000-000000000012';
const unauthorizedOrder = '43000000-0000-4000-8003-000000000012';
const evidence = 'test-results/rma-staging';
await mkdir(evidence, { recursive: true });
async function login(persona) {
  const response = await fetch(`${api}/dev/quick-login`, { method: 'POST', headers: { Origin: web, 'Content-Type': 'application/json' }, body: JSON.stringify({ persona }) });
  assert.equal(response.status, 200, persona);
  const cookie = response.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
  return async (path, body) => fetch(`${api}${path}`, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, Origin: web, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
const uk = await login('UK_FULFILMENT'); const admin = await login('ADMIN');
const get = async (request, path) => { const response = await request(path); assert.equal(response.status, 200, path); return response.json(); };
const beforeOrder = await get(uk, `/international/orders/${orderId}`);
const beforeAsset = await get(admin, `/assets/${assetId}`);
assert.equal(beforeOrder.order.status, 'delivered'); assert.equal(beforeOrder.order.custody, 'CUSTOMER');
const input = { orderId, assetId, reason: 'DEFECTIVE', returnWarehouseId: 'wh-uk', carrier: 'Royal Mail', returnTracking: 'RM-STG-RMA-000012', reasonNote: 'Staging intake verification', idempotencyKey: crypto.randomUUID() };
for (const persona of ['CN_SD_WAREHOUSE', 'CERTIFIED']) {
  const request = await login(persona); assert.equal((await request('/international/rmas', input)).status, 403, persona);
}
assert.equal((await uk('/international/rmas', { ...input, orderId: unauthorizedOrder })).status, 403, 'Unauthorized Sales Account');
assert.equal((await uk('/international/rmas', { ...input, returnWarehouseId: 'wh-cn-sd' })).status, 403, 'Wrong return warehouse scope');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
let rma; let submitted;
try {
  await page.goto(web, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /^英国履约/ }).click();
  await page.locator('.system-main').waitFor(); await page.waitForLoadState('networkidle');
  await page.goto(`${web}/#/system/uk-fulfilment/orders/${orderId}`);
  await page.getByRole('heading', { name: '已送达', exact: true }).waitFor();
  if (!beforeOrder.order.activeRma) {
    await page.getByRole('link', { name: 'Open RMA', exact: true }).click();
    await page.getByLabel('Return Reason', { exact: true }).selectOption('DEFECTIVE');
    await page.getByLabel('Return Warehouse', { exact: true }).selectOption('wh-uk');
    await page.getByLabel('Optional Note', { exact: true }).fill(input.reasonNote);
    await page.getByLabel('Return Carrier', { exact: true }).fill(input.carrier);
    await page.getByLabel('Return Tracking', { exact: true }).fill(input.returnTracking);
    await page.screenshot({ path: `${evidence}/form.png`, fullPage: true });
    const request = page.waitForRequest((request) => request.url() === `${api}/international/rmas` && request.method() === 'POST');
    const response = page.waitForResponse((response) => response.url() === `${api}/international/rmas` && response.request().method() === 'POST');
    await page.getByRole('button', { name: '创建并授权退货', exact: true }).click();
    submitted = (await request).postDataJSON(); const created = await response;
    assert.equal(created.status(), 200, await created.text()); rma = (await created.json()).rma;
  } else {
    rma = (await get(uk, `/international/rmas/${beforeOrder.order.activeRma.id}`)).rma;
    await page.getByRole('link', { name: rma.rmaReference, exact: true }).click();
  }
  await page.getByRole('heading', { name: '退货已授权', exact: true }).waitFor();
  await page.getByText(rma.rmaReference, { exact: true }).waitFor();
  await page.getByText('RETURN_AUTHORIZED', { exact: true }).waitFor();
  await page.getByText('Created At', { exact: true }).waitFor();
  await page.screenshot({ path: `${evidence}/authorized.png`, fullPage: true });
  await page.getByRole('link', { name: '返回 Open RMAs', exact: true }).click();
  await page.getByRole('row').filter({ hasText: rma.rmaReference }).waitFor();
  await page.screenshot({ path: `${evidence}/list.png`, fullPage: true });
} catch (error) {
  await page.screenshot({ path: `${evidence}/failure.png`, fullPage: true });
  await writeFile(`${evidence}/failure-page.txt`, `${page.url()}\n${await page.locator('body').innerText()}`); throw error;
} finally { await browser.close(); }
if (submitted) {
  for (let n = 0; n < 3; n++) {
    const response = await uk('/international/rmas', submitted); assert.equal(response.status, 200); assert.deepEqual((await response.json()).rma, rma);
  }
}
assert.equal((await uk('/international/rmas', input)).status, 409, 'Second active RMA blocked');
assert.equal(rma.businessStatus, 'RETURN_AUTHORIZED'); assert.equal(rma.status, 'open'); assert.equal(rma.returnWarehouseId, 'wh-uk');
assert.match(rma.rmaReference, /^MC-RMA-\d{2}-\d{6}$/); assert.equal(rma.reason, 'DEFECTIVE'); assert.ok(rma.createdAt);
for (const persona of ['CN_SD_WAREHOUSE', 'CERTIFIED']) {
  const request = await login(persona); assert.equal((await request(`/international/rmas/${rma.id}`)).status, 403);
}
const afterOrder = await get(uk, `/international/orders/${orderId}`);
const afterAsset = await get(admin, `/assets/${assetId}`);
assert.equal(afterOrder.order.custody, 'CUSTOMER'); assert.equal(afterOrder.order.locationStatus, 'delivered'); assert.equal(afterOrder.order.warehouseCode, null);
assert.equal(afterOrder.order.deliveredAt, beforeOrder.order.deliveredAt); assert.equal(afterOrder.order.canOpenRma, false);
assert.deepEqual(afterOrder.order.certifiedWarranty, beforeOrder.order.certifiedWarranty);
assert.deepEqual(afterAsset.asset, beforeAsset.asset); assert.deepEqual(afterAsset.publicWarranty, beforeAsset.publicWarranty); assert.deepEqual(afterAsset.publicEntitlements, beforeAsset.publicEntitlements);
const lifecycle = await get(uk, `/international/assets/${assetId}`);
assert.equal(lifecycle.events.filter((event) => event.eventType === 'rma_opened').length, 1);
const list = await get(uk, '/international/rmas'); assert.equal(list.rmas.filter((item) => item.assetId === assetId).length, 1);
const inventory = await get(uk, '/international/warehouses/assets?warehouseId=wh-uk'); assert.ok(!inventory.assets.some((asset) => asset.assetId === assetId));
const report = { environment: 'GitHub Actions cloud / Staging only', browserCreated: Boolean(submitted), rmaReference: rma.rmaReference, rmaId: rma.id, assetCode: rma.assetCode, status: rma.businessStatus, reason: rma.reason, returnWarehouse: rma.returnWarehouse, tracking: rma.returnTracking, createdAt: rma.createdAt, custody: 'CUSTOMER', locationStatus: 'delivered', warrantyUnchanged: true, publicWarrantyUnchanged: true, activeRmas: 1, rmaOpenedEvents: 1, idempotentRetries: submitted ? 3 : 0, scope403: ['CN_SD_WAREHOUSE', 'CERTIFIED', 'unauthorized Sales Account', 'wrong Return Warehouse'], inventoryExcluded: true };
await writeFile(`${evidence}/report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
