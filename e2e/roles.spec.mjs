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

test('各角色登录后进入正确工作台，刷新后会话仍有效', async ({ page }) => {
  await login(page, 'yukyinchew@maxcine.cn');
  await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible();
  await page.goto('/#/login');
  await login(page, 'warehouse@maxcine.cn');
  await expect(page.getByRole('heading', { name: '仓库订单' })).toBeVisible();
  await page.goto('/#/login');
  await login(page, 'ziyuesun@maxcine.cn');
  await expect(page.getByRole('heading', { name: '仪表盘' })).toBeVisible();
  await page.getByRole('link', { name: '服务中心工作台' }).click();
  await expect(page.getByText('仅显示已分配给本服务中心的工单。')).toBeVisible();
});

test('前端路由不替代后端权限控制', async ({ page }) => {
  await login(page, 'warehouse@maxcine.cn');
  const result = await page.evaluate(async () => (await fetch('http://127.0.0.1:8791/admin/users', { credentials: 'include' })).status);
  expect([401, 403]).toContain(result);
  await page.goto('/#/system/admin/users');
  await expect(page.getByRole('heading', { name: '仓库订单' })).toBeVisible();
});

test('超级管理员可以切换仓库、服务中心视图，并打开售后工单详情', async ({ page }) => {
  await login(page, 'yukyinchew@maxcine.cn');
  await page.goto('/#/system/warehouse');
  await expect(page.getByRole('heading', { name: '仓库订单' })).toBeVisible();
  await page.goto('/#/system/service-center');
  await expect(page.getByText('仅显示已分配给本服务中心的工单。')).toBeVisible();
  await page.goto('/#/system/admin/after-sales');
  await page.getByRole('button', { name: '查看处理' }).first().click();
  await expect(page.getByText('系统繁忙，请稍后再试')).toHaveCount(0);
  await expect(page.getByLabel('授权服务中心')).toBeVisible();
});
