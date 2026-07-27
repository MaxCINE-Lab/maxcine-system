import { expect, test } from '@playwright/test';

const password = process.env.E2E_PASSWORD;
const apiBase = 'http://127.0.0.1:8791';
if (!password) throw new Error('请设置 E2E_PASSWORD 后再运行浏览器端验收。');

async function login(page, email) {
  await page.goto('/#/login');
  await page.getByLabel('邮箱').fill(email);
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
  await login(page, 'ziyuesun@maxcine.cn');
  const stores = await request(page, '/stores');
  const inventory = await request(page, '/inventory');
  expect(stores.status).toBe(200);
  expect(inventory.status).toBe(200);
  const product = inventory.body.items.find((item) => item.sku === 'W101' && item.availableQuantity > 0);
  expect(product).toBeTruthy();
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

  await login(page, 'yukyinchew@maxcine.cn');
  const approved = await request(page, `/orders/${created.body.id}/review`, 'POST', { approved: true, note: '浏览器验收通过' });
  expect(approved.status).toBe(200);

  await login(page, 'warehouse@maxcine.cn');
  const warehouseDetail = await request(page, `/orders/${created.body.id}`);
  expect(warehouseDetail.status).toBe(200);
  expect(warehouseDetail.body.order.salePriceCents).toBeNull();
  expect(warehouseDetail.body.order.customerProfile).toBe('');
  expect(warehouseDetail.body.order.screenshotDataUrl).toBe('');
  expect((await request(page, `/orders/${created.body.id}/picking`, 'POST')).status).toBe(200);
  expect((await request(page, `/orders/${created.body.id}/serials`, 'POST', { productId: product.productId, serialNumber: `E2E-W101-${unique}` })).status).toBe(201);
  expect((await request(page, `/orders/${created.body.id}/pack`, 'POST')).status).toBe(200);
  expect((await request(page, `/orders/${created.body.id}/ship`, 'POST', { carrier: '顺丰速运', trackingNumber: `SF-E2E-${unique}` })).status).toBe(200);

  await login(page, 'yukyinchew@maxcine.cn');
  const lookup = await request(page, `/gsx/search?q=E2E-W101-${unique}`);
  expect(lookup.status).toBe(200);
  expect(lookup.body.items).toHaveLength(1);
  const detail = await request(page, `/assets/${lookup.body.items[0].id}`);
  expect(detail.status).toBe(200);
  expect(detail.body.asset.currentSn).toBe(`E2E-W101-${unique}`);
  expect(detail.body.asset.warrantyStartAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(detail.body.asset.warrantyEndAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(detail.body.events.some((event) => event.eventType === 'warranty_started' && event.title.includes('90'))).toBe(true);
});
