import { expect, test } from '@playwright/test';

const password = process.env.E2E_PASSWORD;
if (!password) throw new Error('请设置 E2E_PASSWORD 后再运行浏览器端验收。');

async function login(page, email, nextPassword = password) {
  await page.goto('/#/login');
  await page.getByLabel('AD账号').fill(email);
  await page.getByLabel('密码').fill(nextPassword);
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForFunction(() => location.hash !== '#/login');
}

test('售后阶段页面只开放当前阶段操作，旧阶段 API 被拒绝', async ({ page }) => {
  await login(page, '9353xuyan@maxcine.cn');
  await page.goto('/#/system/admin/after-sales');
  await page.getByRole('row').filter({ hasText: 'CAS-00002' }).getByRole('button', { name: '查看处理' }).click();
  const phaseNav = page.getByRole('navigation', { name: '售后阶段页面' });
  await expect(phaseNav).toBeVisible();
  await expect(phaseNav.getByRole('button', { name: '总览' })).toBeVisible();
  await expect(phaseNav.getByRole('button', { name: '客户寄修' })).toBeDisabled();
  await expect(phaseNav.getByRole('button', { name: '服务中心检测' })).toBeDisabled();

  const staleWriteStatus = await page.evaluate(async () => {
    const response = await fetch('http://127.0.0.1:8791/after-sales/a0000000-0000-4000-8000-000000000002/inbound-shipment', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ carrier: '顺丰速运', trackingNumber: 'SF-STAGE-STALE', note: '不应在待审核阶段录入' })
    });
    return response.status;
  });
  expect(staleWriteStatus).toBe(409);
});

test('管理员重置密码后用户必须先修改临时密码', async ({ page }) => {
  await login(page, '9353xuyan@maxcine.cn');
  const resetStatus = await page.evaluate(async () => {
    const response = await fetch('http://127.0.0.1:8791/admin/users/20000000-0000-4000-8000-000000000005/reset-password', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nextPassword: 'TempMaxCINE2026!' })
    });
    return response.status;
  });
  expect(resetStatus).toBe(200);

  await page.evaluate(async () => { await fetch('http://127.0.0.1:8791/auth/logout', { method: 'POST', credentials: 'include' }); });
  await login(page, '9527rui@maxcine.cn', 'TempMaxCINE2026!');
  await expect(page.getByRole('heading', { name: '请先修改密码' })).toBeVisible();
  await page.getByLabel('当前临时密码').fill('TempMaxCINE2026!');
  await page.getByLabel('新密码', { exact: true }).fill(password);
  await page.getByLabel('确认新密码').fill(password);
  await page.getByRole('button', { name: '修改密码并进入后台' }).click();
  await expect(page.getByRole('heading', { name: '仪表盘' })).toBeVisible();
});
