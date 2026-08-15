import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

const password = process.env.E2E_PASSWORD;
const persistence = process.env.E2E_D1_PERSISTENCE;
const root = resolve(import.meta.dirname, '..');
const apiBase = 'http://127.0.0.1:8791';
if (!password || !persistence) throw new Error('请设置 E2E_PASSWORD，并通过验收脚本提供隔离数据库。');

function sqlString(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function execute(sql) {
  execFileSync(process.execPath, [join(root, 'node_modules/wrangler/wrangler-dist/cli.js'), 'd1', 'execute', 'maxcine-db', '--local', '--persist-to', persistence, '--config', 'apps/api/wrangler.toml', '--command', sql], { cwd: root, stdio: 'pipe' });
}

async function login(page, email) {
  await page.goto('/#/login');
  await page.getByLabel('AD账号').fill(email);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForFunction(() => location.hash !== '#/login');
}

async function request(page, path, method = 'GET', body) {
  return page.evaluate(async ({ base, path: target, method: requestMethod, body: requestBody }) => {
    const response = await fetch(`${base}${target}`, {
      method: requestMethod,
      credentials: 'include',
      headers: requestBody ? { 'Content-Type': 'application/json' } : undefined,
      body: requestBody ? JSON.stringify(requestBody) : undefined
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, { base: apiBase, path, method, body });
}

test('提交订单资料完整，发货后自动建立 W101 的 GSX 保修资产', async ({ page }) => {
  const unique = Date.now();
  await login(page, '8016sun@maxcine.cn');
  const stores = await request(page, '/stores');
  const inventory = await request(page, '/inventory');
  expect(stores.status).toBe(200);
  expect(inventory.status).toBe(200);
  const product = inventory.body.items.find((item) => item.sku === 'W101' && item.availableQuantity > 0);
  expect(product).toBeTruthy();
  const selectedSn = `E2E-W101-${unique}`;
  execute(`INSERT INTO assets (id, current_sn, original_sn, product_id, product_name_snapshot, version_snapshot, asset_status, data_quality_status, created_at, updated_at)
    VALUES (${sqlString(randomUUID())}, ${sqlString(selectedSn)}, ${sqlString(selectedSn)}, ${sqlString(product.productId)}, ${sqlString(product.name)}, '标准套装', 'active', 'normal', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
  execute(`INSERT INTO serial_numbers (id, product_id, serial_number, state, production_date, warehouse_location, internal_note, created_at, updated_at)
    VALUES (${sqlString(randomUUID())}, ${sqlString(product.productId)}, ${sqlString(selectedSn)}, 'available', '2026-08-01', 'E2E 山东云仓', 'E2E 可售库存 SN', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
  const created = await request(page, '/orders', 'POST', {
    storeId: stores.body.stores[0].id,
    items: [{ productId: product.productId, quantity: 1 }],
    note: '浏览器验收订单备注',
    salePriceCents: 129900,
    shippingAddress: '本地浏览器验收收货地址',
    customerProfile: '专业飞手',
    screenshotDataUrl: 'data:image/png;base64,aGVsbG8='
  });
  expect(created.status).toBe(201);
  const submitted = await request(page, `/orders/${created.body.id}/submit`, 'POST');
  expect(submitted.status).toBe(200);

  await login(page, '9353xuyan@maxcine.cn');
  const approved = await request(page, `/orders/${created.body.id}/review`, 'POST', { approved: true, note: '浏览器验收通过' });
  expect(approved.status).toBe(200);
  const available = await request(page, `/orders/${created.body.id}/available-serials`);
  expect(available.status).toBe(200);
  expect(available.body.groups[0].serials.some((item) => item.serialNumber === selectedSn)).toBe(true);
  const fulfilled = await request(page, `/orders/${created.body.id}/fulfillment`, 'POST', {
    packageMaterials: ['普通纸箱'],
    carrier: '顺丰速运',
    trackingNumber: `SF-E2E-${unique}`,
    allocationMode: 'manual',
    serialNumbers: [selectedSn]
  });
  expect(fulfilled.status).toBe(200);

  await login(page, '8982warehouse@maxcine.cn');
  const warehouseDetail = await request(page, `/orders/${created.body.id}`);
  expect(warehouseDetail.status).toBe(200);
  expect(warehouseDetail.body.order.salePriceCents).toBeNull();
  expect(warehouseDetail.body.order.customerProfile).toBe('');
  expect(warehouseDetail.body.order.screenshotDataUrl).toBe('');
  expect((await request(page, `/orders/${created.body.id}/ship`, 'POST', { carrier: '顺丰速运', trackingNumber: `SF-E2E-${unique}`, serialNumbers: [selectedSn] })).status).toBe(200);

  await login(page, '9353xuyan@maxcine.cn');
  const lookup = await request(page, `/gsx/search?q=${encodeURIComponent(selectedSn)}`);
  expect(lookup.status).toBe(200);
  expect(lookup.body.items).toHaveLength(1);
  const detail = await request(page, `/assets/${lookup.body.items[0].id}`);
  expect(detail.status).toBe(200);
  expect(detail.body.asset.currentSn).toBe(selectedSn);
  expect(detail.body.asset.warrantyStartAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(detail.body.asset.warrantyEndAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(detail.body.publicWarranty.publicWarrantyStartDate).toBe(detail.body.asset.warrantyStartAt);
  expect(detail.body.publicWarranty.publicWarrantyEndDate).toBe(detail.body.asset.warrantyEndAt);
  expect(detail.body.events.some((event) => event.eventType === 'warranty_started' && event.title.includes('90'))).toBe(true);

  const publicLookupWithoutSlider = await request(page, `/public/warranty/${encodeURIComponent(selectedSn)}`);
  expect(publicLookupWithoutSlider.status).toBe(403);
  const challenge = await request(page, '/public/warranty/challenges', 'POST');
  expect(challenge.status).toBe(201);
  const completed = await request(page, `/public/warranty/challenges/${challenge.body.challengeId}/complete`, 'POST', { sliderValue: 100 });
  expect(completed.status).toBe(200);
  const publicLookup = await request(page, `/public/warranty/${encodeURIComponent(selectedSn)}?challengeId=${encodeURIComponent(challenge.body.challengeId)}&token=${encodeURIComponent(completed.body.token)}`);
  expect(publicLookup.status).toBe(200);
  expect(Object.keys(publicLookup.body).sort()).toEqual(['productName', 'productVersion', 'publicNote', 'serialNumber', 'warrantyEndDate', 'warrantyStartDate', 'warrantyStatus'].sort());
  expect(publicLookup.body.serialNumber).toBe(selectedSn);
  expect(publicLookup.body.warrantyStartDate).toBe(detail.body.asset.warrantyStartAt);
  expect(JSON.stringify(publicLookup.body)).not.toMatch(/internal|factory|photo|object_key|dealer|customer|admin_private/i);
  const reusedTokenLookup = await request(page, `/public/warranty/${encodeURIComponent(selectedSn)}?challengeId=${encodeURIComponent(challenge.body.challengeId)}&token=${encodeURIComponent(completed.body.token)}`);
  expect(reusedTokenLookup.status).toBe(403);

  const internalChanged = await request(page, `/admin/assets/${lookup.body.items[0].id}/warranty`, 'PATCH', { warrantyOverrideStatus: 'exception', warrantyOverrideReason: 'E2E 内部保修覆盖' });
  expect(internalChanged.status).toBe(200);
  const afterInternalChange = await request(page, `/assets/${lookup.body.items[0].id}`);
  expect(afterInternalChange.status).toBe(200);
  expect(afterInternalChange.body.asset.warrantyOverrideStatus).toBe('exception');
  expect(afterInternalChange.body.publicWarranty.publicNote).toBe(detail.body.publicWarranty.publicNote);

  const publicChanged = await request(page, `/admin/assets/${lookup.body.items[0].id}/public-warranty`, 'PATCH', {
    publicWarrantyStartDate: detail.body.publicWarranty.publicWarrantyStartDate,
    publicWarrantyEndDate: detail.body.publicWarranty.publicWarrantyEndDate,
    publicWarrantyStatus: 'unknown',
    publicNote: 'E2E 公开保修备注',
    isPublicQueryEnabled: true
  });
  expect(publicChanged.status).toBe(200);
  const afterPublicChange = await request(page, `/assets/${lookup.body.items[0].id}`);
  expect(afterPublicChange.status).toBe(200);
  expect(afterPublicChange.body.publicWarranty.publicNote).toBe('E2E 公开保修备注');
  expect(afterPublicChange.body.asset.warrantyOverrideStatus).toBe('exception');
});
