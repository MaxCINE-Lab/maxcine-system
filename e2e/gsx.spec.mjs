import { expect, test } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as XLSX from 'xlsx';

const password = process.env.E2E_PASSWORD;
if (!password) throw new Error('请设置 E2E_PASSWORD 后再运行浏览器端验收。');
const apiBase = 'http://127.0.0.1:8791';
const columns = ['序号', '销售渠道', '版本', '购买日期', '购买价格', 'SN', '保修状态', '发出单号', '发货仓库', '用户画像', '到账状态', '保修开始', '保修结束', '维修记录1', '维修记录2', '维修记录3', '维修记录4', '备注1', '备注2', '备注3', '备注4', '备注5'];

function createFixture() {
  const rows = [
    columns,
    [1, '官方店', '标准版', '2025 11 18（23）', '129x15=1935', '6900000000001', '在保', 'SF0123456789001', '淄博', '仅限内部查看', '已到账578', '2025 11 20', '2026 11 20', null, null, null, null, null, null, null, null, null],
    [2, '官方店', '标准版', '2025 11 18', 599, '6900000000001', '在保', 'SF0123456789002', '淄博', null, '已到账', '2025 11 20', '2026 11 20', null, null, null, null, null, null, null, null, null],
    [3, '官方店', '增强版', '2025 7 25', 699, 'SF0123456789012', '无保修', 'SF0123456789012', '淄博', '仅限内部查看', '已发货', '无保修', '无保修', '序列号更换为6900000000002', null, null, null, '历史维修说明', null, null, null, null]
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  const file = join(tmpdir(), 'maxcine-gsx-e2e.xlsx');
  XLSX.writeFile(workbook, file);
  return file;
}

async function login(page, email) {
  await page.goto('/#/login');
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForFunction(() => location.hash !== '#/login');
}

test('GSX 历史导入、SN 查询、生命周期、售后关联和权限隔离', async ({ page }) => {
  const fixture = createFixture();
  await login(page, 'yukyinchew@maxcine.cn');
  await page.goto('/#/system/admin/assets/import');
  await expect(page.getByRole('heading', { name: '历史数据导入' })).toBeVisible();
  await page.locator('input[type=file]').setInputFiles(fixture);
  await expect(page.getByText('预检查完成，请查看警告和错误后确认导入。')).toBeVisible();
  await expect(page.getByText('SN 字段疑似顺丰单号，已保留为错误标签，不作为当前 SN。')).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '确认导入' }).click();
  await expect(page.getByText('导入完成：已导入 3 条，跳过 0 条。')).toBeVisible();

  await page.goto('/#/system/admin/assets');
  await page.getByLabel('SN 或资产标识').fill('SF0123456789012');
  await page.getByRole('button', { name: '查询' }).click();
  const assetRow = page.getByRole('row', { name: /6900000000002/ });
  await expect(assetRow).toBeVisible();
  await assetRow.getByRole('link', { name: '查看' }).click();
  await expect(page.getByRole('heading', { name: '资产详情' })).toBeVisible();
  await expect(page.getByText('当前 SN：6900000000002')).toBeVisible();
  await expect(page.getByRole('heading', { name: '生命周期' })).toBeVisible();
  await expect(page.getByText('历史维修记录')).toBeVisible();

  const assetId = await page.evaluate(async (base) => {
    const response = await fetch(`${base}/gsx/search?q=6900000000002`, { credentials: 'include' });
    return (await response.json()).items[0].id;
  }, apiBase);
  await expect(page.getByRole('heading', { name: '售后信息' })).toBeVisible();

  const assigned = await page.evaluate(async ({ base, id }) => {
    const serviceCenters = await (await fetch(`${base}/admin/options`, { credentials: 'include' })).json();
    const response = await fetch(`${base}/after-sales`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assetId: id,
        caseType: 'QUALITY_ISSUE',
        description: '用于验证资产查询后创建售后工单的浏览器端流程。',
        customerNote: '',
        internalNote: 'GSX E2E',
        contactName: '本地测试客户',
        contactPhone: '13800000000',
        contactEmail: 'customer@example.test',
        contactAddress: '本地测试地址'
      })
    });
    const created = await response.json();
    const liaisoningCenter = serviceCenters.serviceCenters.find((item) => item.province === '辽宁省');
    const assign = await fetch(`${base}/after-sales/${created.id}/assign`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serviceCenterId: liaisoningCenter.id }) });
    return { status: assign.status, assetId: id };
  }, { base: apiBase, id: assetId });
  expect(assigned.status).toBe(200);

  await page.goto('/#/login');
  await login(page, 'ziyuesun@maxcine.cn');
  const serviceView = await page.evaluate(async ({ base, id }) => {
    const response = await fetch(`${base}/assets/${id}`, { credentials: 'include' });
    return { status: response.status, body: await response.json() };
  }, { base: apiBase, id: assetId });
  expect(serviceView.status).toBe(200);
  expect(serviceView.body.notes).toEqual([]);
  expect(serviceView.body.events.some((event) => event.visibility === 'admin_private')).toBe(false);

  await page.goto('/#/login');
  await login(page, 'ericzhu@maxcine.cn');
  const dealerSearch = await page.evaluate(async (base) => {
    const response = await fetch(`${base}/gsx/search?q=6900000000002`, { credentials: 'include' });
    const body = await response.json();
    return { status: response.status, count: body.items?.length ?? 0 };
  }, apiBase);
  expect([200, 403]).toContain(dealerSearch.status);
  expect(dealerSearch.count).toBe(0);

  await page.goto('/#/login');
  await login(page, 'warehouse@maxcine.cn');
  const warehouseSearch = await page.evaluate(async (base) => {
    const response = await fetch(`${base}/gsx/search?q=6900000000002`, { credentials: 'include' });
    const body = await response.json();
    return { status: response.status, count: body.items?.length ?? 0 };
  }, apiBase);
  expect([200, 403]).toContain(warehouseSearch.status);
  expect(warehouseSearch.count).toBe(0);

  await page.goto('/#/login');
  await login(page, 'yukyinchew@maxcine.cn');
  await page.goto('/#/system/admin/assets/import');
  await page.locator('input[type=file]').setInputFiles(fixture);
  await expect(page.getByText('该文件已有预检查记录，可继续确认导入。')).toBeVisible();
  const duplicates = await page.evaluate(async (base) => (await (await fetch(`${base}/assets?search=6900000000001`, { credentials: 'include' })).json()).pagination.total, apiBase);
  expect(duplicates).toBe(2);
});
