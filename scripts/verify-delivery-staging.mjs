import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

// Deliberately fixed to Staging; never accept a Production URL override.
const web = 'https://maxcine-web-staging.pages.dev';
const api = 'https://maxcine-api-staging.maxcine-lab.workers.dev';
const orderId = '44000000-0000-4000-8000-000000000003';
const assetId = '43000000-0000-4000-8000-000000000012';
const unauthorizedOrder = '43000000-0000-4000-8003-000000000012';
const assetCode = 'MC-26-P12A-000012';
await mkdir('test-results/delivery-staging', { recursive: true });

async function login(persona) {
  const response = await fetch(`${api}/dev/quick-login`, { method: 'POST', headers: { Origin: web, 'Content-Type': 'application/json' }, body: JSON.stringify({ persona }) });
  assert.equal(response.status, 200, `Staging login ${persona}`);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, 'Staging session cookie');
  return async (path, body) => fetch(`${api}${path}`, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, Origin: web, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
const uk = await login('UK_FULFILMENT');
const admin = await login('ADMIN');
const get = async (request, path) => { const response = await request(path); assert.equal(response.status, 200, path); return response.json(); };
const before = await get(uk, `/international/orders/${orderId}`);
assert.ok(['shipped', 'delivered'].includes(before.order.status), 'Use the normal B-3 shipment fixture only');
const beforeAsset = await get(admin, `/assets/${assetId}`);
const publicWarrantySnapshot = (data) => data.publicWarranty;
for (const persona of ['CN_SD_WAREHOUSE', 'CERTIFIED']) {
  const request = await login(persona);
  assert.equal((await request(`/international/orders/${orderId}/deliver`, {})).status, 403, persona);
}
assert.equal((await uk(`/international/orders/${unauthorizedOrder}/deliver`, {})).status, 403, 'Unauthorized Sales Account');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
try {
  await page.goto(web, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /^英国履约/ }).click();
  // Quick-role login reloads the document; await authenticated UI before routing.
  await page.locator('.system-main').waitFor();
  await page.waitForLoadState('networkidle');
  if (before.order.status === 'shipped') {
    await page.goto(`${web}/#/system/uk-fulfilment/deliveries`);
    const row = page.getByRole('row').filter({ hasText: orderId });
    await row.getByRole('link', { name: '打开', exact: true }).click();
    const deliveredButton = page.getByRole('button', { name: '标记已送达', exact: true });
    await deliveredButton.waitFor();
    await page.screenshot({ path: 'test-results/delivery-staging/before.png', fullPage: true });
    await deliveredButton.click();
  } else {
    await page.goto(`${web}/#/system/uk-fulfilment/orders/${orderId}`);
    if (before.order.canRecoverWarranty) await page.getByRole('button', { name: '补齐内部保修评估', exact: true }).click();
  }
  await page.getByRole('heading', { name: '已送达', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '标记已送达', exact: true }).count(), 0);
  await page.getByText('Delivered At', { exact: true }).waitFor();
  await page.getByRole('heading', { name: 'MaxCINE Certified Warranty', exact: true }).waitFor();
  await page.getByText('Active', { exact: true }).waitFor();
  await page.screenshot({ path: 'test-results/delivery-staging/delivered.png', fullPage: true });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '已送达', exact: true }).waitFor();
} catch (error) {
  await page.screenshot({ path: 'test-results/delivery-staging/failure.png', fullPage: true });
  await writeFile('test-results/delivery-staging/failure-page.txt', `${page.url()}\n${await page.locator('body').innerText()}`);
  throw error;
} finally { await browser.close(); }

const delivered = await get(uk, `/international/orders/${orderId}`);
assert.equal(delivered.order.status, 'delivered');
assert.equal(delivered.order.assetCode, assetCode);
assert.equal(delivered.order.custody, 'CUSTOMER');
assert.equal(delivered.order.locationStatus, 'delivered');
assert.equal(delivered.order.warehouseCode, null);
assert.ok(delivered.order.deliveredAt);
if (before.order.status === 'delivered') assert.equal(delivered.order.deliveredAt, before.order.deliveredAt);
const warranty = delivered.order.certifiedWarranty;
assert.equal(warranty.status, 'active'); assert.equal(warranty.policyCode, 'MAXCINE_CERTIFIED_STANDARD_12M');
assert.equal(warranty.start, delivered.order.deliveredAt); assert.equal(warranty.sourceOrderId, orderId);
assert.equal(warranty.marketRegion, 'UK'); assert.equal(warranty.activationSource, 'sale_delivery'); assert.ok(warranty.activatedAt);
const anniversary = new Date(warranty.start); anniversary.setUTCFullYear(anniversary.getUTCFullYear() + 1);
assert.equal(warranty.end, anniversary.toISOString());
assert.equal(delivered.order.allocationStatus, 'fulfilled');
for (let i = 0; i < 3; i++) {
  const response = await uk(`/international/orders/${orderId}/deliver`, {});
  assert.equal(response.status, 200);
  const repeat = await response.json();
  assert.equal(repeat.deliveredAt, delivered.order.deliveredAt);
  assert.deepEqual(repeat.certifiedWarranty, warranty);
}
const inventory = await get(uk, '/international/warehouses/assets?warehouseId=wh-uk');
assert.ok(!inventory.assets.some((asset) => asset.assetId === assetId));
for (const path of ['/international/orders', '/international/orders?view=delivery']) {
  const result = await get(uk, path); assert.ok(!result.orders.some((order) => order.id === orderId));
}
const asset = await get(uk, `/international/assets/${assetId}`);
assert.equal(asset.asset.custody, 'CUSTOMER');
assert.equal(asset.asset.locationStatus, 'delivered');
assert.equal(asset.events.filter((event) => event.eventType === 'customer_delivered').length, 1);
assert.equal(asset.events.filter((event) => event.eventType === 'warranty_activated' && event.source === 'certified-sale-delivery').length, 1);
const finalInternal = await get(admin, `/assets/${assetId}`);
assert.equal(finalInternal.asset.warrantyStartAt, warranty.start); assert.equal(finalInternal.asset.warrantyEndAt, warranty.end);
assert.deepEqual(publicWarrantySnapshot(finalInternal), publicWarrantySnapshot(beforeAsset), 'Internal activation must not change Public Warranty');
const report = { environment: 'GitHub Actions cloud / Staging only', orderId, assetCode, initialStatus: before.order.status, deliveredAt: delivered.order.deliveredAt, status: delivered.order.status, custody: delivered.order.custody, locationStatus: delivered.order.locationStatus, allocationStatus: delivered.order.allocationStatus, lifecycle: 'customer_delivered x1 / warranty_activated x1', warranty, idempotentRetries: 3, scope403: ['CN_SD_WAREHOUSE', 'CERTIFIED', 'unauthorized Sales Account'], inventoryExcluded: true, publicWarrantyUnchanged: true };
await writeFile('test-results/delivery-staging/report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
