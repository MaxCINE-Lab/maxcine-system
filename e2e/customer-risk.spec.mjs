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

async function searchRisk(page, value) {
  await page.goto('/#/system/customer-risk');
  await expect(page.getByRole('heading', { name: 'Customer Risk Center' })).toBeVisible();
  await page.locator('.risk-spotlight input').fill(value);
  await page.keyboard.press('Enter');
  await expect(page.locator('.risk-profile')).toBeVisible();
}

test('Customer Risk Center supports fast lookup, consultation append and duplicate guard', async ({ page }) => {
  await login(page, 'ziyuesun@maxcine.cn');
  await page.goto('/#/system/customer-risk');
  await expect(page.getByRole('button', { name: '模糊查询' })).toBeVisible();
  await expect(page.getByRole('button', { name: '新建黑名单' })).toBeVisible();
  await expect(page.locator('.risk-spotlight input')).toBeVisible();
  await expect(page.getByText('当前仅适用于 MaxCINE Mavic 4 Pro 增广镜。')).toBeVisible();

  await page.locator('.risk-spotlight input').fill('91xpa');
  await expect(page.getByRole('button', { name: '使用 tbNick_91xpa 查询' })).toBeVisible();
  await page.getByRole('button', { name: '使用 tbNick_91xpa 查询' }).click();
  await expect(page.locator('.risk-profile')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'tbNick_91xpa' })).toBeVisible();
  await expect(page.getByRole('button', { name: '编辑档案' })).toHaveCount(0);

  await searchRisk(page, '18191316611');
  await expect(page.getByRole('heading', { name: 'tbNick_91xpa' })).toBeVisible();
  await searchRisk(page, '陕西省');
  await expect(page.getByRole('heading', { name: 'tbNick_91xpa' })).toBeVisible();

  await page.getByRole('button', { name: '新增' }).click();
  await page.locator('.risk-compact-form').getByLabel('反复砍价').check();
  await page.locator('.risk-compact-form textarea').fill('浏览器验收追加咨询记录。');
  await page.getByRole('button', { name: '保存咨询记录' }).click();
  await expect(page.getByText('浏览器验收追加咨询记录。')).toBeVisible();

  await page.getByRole('button', { name: '新建黑名单' }).click();
  await page.locator('.risk-spotlight textarea').fill('tbNick_91xpa\n何满堂\n18191316611\n陕西省渭南市大荔县城关街道东大街21号\nIP：陕西省');
  await page.getByRole('button', { name: '自动识别' }).click();
  await expect(page.getByText('发现现有客户档案')).toBeVisible();
  await expect(page.getByRole('button', { name: '创建黑名单档案' })).toBeDisabled();

  await page.goto('/#/login');
  await login(page, 'yukyinchew@maxcine.cn');
  await searchRisk(page, 'tbNick_91xpa');
  await expect(page.getByRole('button', { name: '编辑档案' })).toBeVisible();
  await page.getByRole('button', { name: '编辑档案' }).click();
  await page.getByLabel('管理员备注').fill('浏览器验收管理员备注');
  await page.getByRole('button', { name: '保存档案' }).click();
  await expect(page.getByText('客户档案已更新。')).toBeVisible();
  await expect(page.getByText('浏览器验收管理员备注')).toBeVisible();
});
