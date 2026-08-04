import { expect, test } from '@playwright/test';

const password = process.env.E2E_PASSWORD;
if (!password) throw new Error('请设置 E2E_PASSWORD 后再运行浏览器端验收。');

async function login(page, email) {
  await page.goto('/#/login');
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForFunction(() => location.hash !== '#/login');
}

async function expectStandardField(field, minimumHeight = '44px') {
  await expect(field).toHaveCSS('background-color', /rgba?\(255, 255, 255/);
  await expect(field).toHaveCSS('color', /rgb\((17, 24, 39|21, 24, 33)\)/);
  await expect(field).toHaveCSS('min-height', minimumHeight);
}

test('设计系统：后台表单、导航与移动布局保持统一', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1040 });
  await login(page, 'yukyinchew@maxcine.cn');
  await page.goto('/#/system/admin/products');
  await expect(page.getByRole('heading', { name: '产品管理' })).toBeVisible();
  await expectStandardField(page.getByPlaceholder('搜索产品名称或 SKU'));
  await expectStandardField(page.getByLabel('产品名称'));
  await expectStandardField(page.getByLabel('产品简介'), '112px');
  await page.getByLabel('产品名称').focus();
  await expect(page.getByLabel('产品名称')).toHaveCSS('border-color', /rgba?\(82, 102, 125/);
  await page.getByRole('button', { name: '保存' }).hover();
  await expect(page.getByRole('button', { name: '保存' })).toHaveCSS('background-color', /rgb\((31, 34, 39|32, 35, 40|38, 42, 47)\)/);
  await expect(page.locator('.system-nav')).toHaveCSS('background-image', /linear-gradient/);
  await page.screenshot({ path: testInfo.outputPath('admin-products-desktop.png'), fullPage: true });

  await page.goto('/#/system/admin/assets');
  await expect(page.getByRole('heading', { name: 'SN 查询' })).toBeVisible();
  await expectStandardField(page.getByLabel('SN 或资产标识'));
  await expect(page.getByText('输入完整或部分 SN，快速打开资产详情。')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('admin-gsx-desktop.png'), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/system/admin/products');
  await expect(page.getByRole('heading', { name: '产品管理' })).toBeVisible();
  await expect(page.getByPlaceholder('搜索产品名称或 SKU')).toBeVisible();
  await page.getByRole('button', { name: '菜单' }).click();
  await expect(page.locator('.system-nav')).toHaveClass(/is-open/);
  await expect(page.locator('.system-nav')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  await page.screenshot({ path: testInfo.outputPath('admin-products-mobile-menu.png') });
});

test('设计系统：经销商、仓库与服务中心使用一致的系统外壳', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 980 });
  await login(page, 'ziyuesun@maxcine.cn');
  await expect(page.getByRole('heading', { name: '仪表盘' })).toBeVisible();
  await expect(page.getByRole('link', { name: '打开订单查询' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('dealer-dashboard-desktop.png'), fullPage: true });

  await page.getByRole('link', { name: '服务中心工单' }).click();
  await expect(page.getByText('只显示分配给本服务中心或由你提交的售后工单。')).toBeVisible();
  await expect(page.getByRole('link', { name: '打开 SN 查询' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('service-center-desktop.png'), fullPage: true });

  await page.goto('/#/login');
  await login(page, 'warehouse@maxcine.cn');
  await expect(page.getByRole('heading', { name: '发货' })).toBeVisible();
  await expect(page.getByRole('link', { name: '搜索待发货订单' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('warehouse-desktop.png'), fullPage: true });
});
