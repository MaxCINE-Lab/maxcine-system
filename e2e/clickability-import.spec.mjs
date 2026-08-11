import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from '@playwright/test';
import * as XLSX from 'xlsx';

const password = process.env.E2E_PASSWORD;
const persistence = process.env.E2E_D1_PERSISTENCE;
const root = resolve(import.meta.dirname, '..');
const apiBase = 'http://127.0.0.1:8791';
const historicalColumns = ['序号', '销售渠道', '版本', '购买日期', '购买价格', 'SN', '保修状态', '发出单号', '发货仓库', '用户画像', '到账状态', '保修开始', '保修结束', '维修记录1', '维修记录2', '维修记录3', '维修记录4', '备注1', '备注2', '备注3', '备注4', '备注5'];
if (!password || !persistence) throw new Error('请通过浏览器验收脚本提供隔离数据库和演示账户密码。');

async function login(page, email) {
  await page.goto('/#/login');
  await page.getByLabel('AD账号').fill(email);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForFunction(() => location.hash !== '#/login');
}

async function logout(page) {
  await page.evaluate((base) => fetch(`${base}/auth/logout`, { method: 'POST', credentials: 'include' }), apiBase);
}

function fixtureWorkbook() {
  const rows = [
    ['MaxCINE 历史保修测试表'],
    [],
    [],
    historicalColumns,
    [1, '官方店', '标准版', '2025 7 25', 599, '6901649533304', '在保', 'SF1234567890123', '淄博', '仅限管理员查看', '已到账599', '2025 7 28', '2025 10 25', '首次检测正常', '', '', '', '普通备注', '', '', '', ''],
    [2, '官方店', '标准版', '2025 7 26', 599, '6901649533304', '在保', 'SF1234567890124', '淄博', '', '已到账', '2025 7 29', '2025 10 26', '', '', '', '', '重复 SN 测试', '', '', '', ''],
    [3, '官方店', '早期标准版', '2025 7 27', '129x15=1935', 'SF0285803529430', '异常', 'SF0285803529430', '淄博', '不要向外展示', '已到账578', '2025 7 30', '2025 10 27', '序列号更换为6901649532486', '', '', '', '', '', '', '', ''],
    [4, '官方店', '标准版', '2025 7 28', 599, '', '在保', 'SF1234567890125', '淄博', '', '已到账', '2025 7 31', '2025 10 28', '', '', '', '', '缺失 SN 测试', '', '', '', '']
  ];
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 2, c: 21 } }];
  XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  const file = join(tmpdir(), `maxcine-clickability-import-${Date.now()}.xlsx`);
  XLSX.writeFile(workbook, file);
  return file;
}

function tableCount(table) {
  const output = execFileSync(process.execPath, [join(root, 'node_modules/wrangler/wrangler-dist/cli.js'), 'd1', 'execute', 'maxcine-db', '--local', '--persist-to', persistence, '--config', 'apps/api/wrangler.toml', '--command', `SELECT COUNT(*) AS count FROM ${table};`, '--json'], { cwd: root, encoding: 'utf8' });
  const parsed = JSON.parse(output);
  return Number(parsed[0].results[0].count);
}

function precheckPayload() {
  return {
    sourceFilename: 'permission-check.xlsx',
    sourceSheet: 'Sheet1',
    sourceFileFingerprint: `permission-${Date.now()}`,
    headers: historicalColumns,
    records: [{ rowNumber: 5, values: Object.fromEntries(historicalColumns.map((column) => [column, ''])) }]
  };
}

function watchUnexpectedBrowserErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error' && !text.includes('status of 401 (Unauthorized)')) errors.push(text);
  });
  page.on('response', (response) => {
    const url = response.url();
    if (url.startsWith(apiBase) && response.status() >= 500) errors.push(`${response.status()} ${url}`);
  });
  return errors;
}

test('核心导航可进入且没有明显空路由或未捕获异常', async ({ page }) => {
  const errors = watchUnexpectedBrowserErrors(page);
  const accounts = ['9353xuyan@maxcine.cn', '8016sun@maxcine.cn', '8982warehouse@maxcine.cn'];
  for (const email of accounts) {
    await login(page, email);
    const hrefs = await page.locator('.system-nav a[href^="#/system"]').evaluateAll((links) => Array.from(new Set(links.map((link) => link.getAttribute('href')).filter(Boolean))));
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      await page.goto(`/${href}`);
      await expect(page.locator('.system-main')).toBeVisible();
      await expect(page.getByText('页面未找到。')).toHaveCount(0);
      const inertControls = await page.evaluate(() => Array.from(document.querySelectorAll('a, button')).filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        if (rect.width === 0 || rect.height === 0 || style.visibility === 'hidden' || style.display === 'none') return false;
        const label = (element.getAttribute('aria-label') || element.textContent || '').trim();
        if (!label) return true;
        if (element instanceof HTMLAnchorElement) {
          const hrefValue = element.getAttribute('href') || '';
          return hrefValue === '#' || hrefValue === '';
        }
        return false;
      }).map((element) => element.textContent?.trim() || element.getAttribute('aria-label') || element.outerHTML.slice(0, 80)));
      expect(inertControls).toEqual([]);
    }
    await logout(page);
  }
  expect(errors).toEqual([]);
});

test('历史保修 Excel 只进入预检查，不写入正式资产或 SN 数据', async ({ page }) => {
  const source = fixtureWorkbook();
  expect(existsSync(source)).toBe(true);
  const before = {
    serialNumbers: tableCount('serial_numbers'),
    assets: tableCount('assets'),
    identifiers: tableCount('asset_identifiers'),
    events: tableCount('asset_events'),
    notes: tableCount('asset_notes')
  };

  await login(page, '9353xuyan@maxcine.cn');
  await page.goto('/#/system/admin/assets/import');
  await page.locator('input[type=file]').setInputFiles(source);
  await expect(page.getByText('预检查完成，请查看警告和错误后确认导入。')).toBeVisible();
  await expect(page.getByRole('heading', { name: '字段映射' })).toBeVisible();
  await expect(page.getByText('维修记录1～4')).toBeVisible();
  await expect(page.getByText('仅显示异常行')).toBeVisible();
  await page.getByPlaceholder('搜索 SN、序号、版本或检查结果').fill('6901649533304');
  await expect(page.getByText('当前显示')).toBeVisible();
  await page.getByLabel('仅显示异常行').check();
  await expect(page.getByRole('button', { name: '下载异常行' })).toBeVisible();
  await page.getByRole('button', { name: '取消本次预检查' }).click();
  await expect(page.getByText('已取消本次预检查，未写入正式资产数据。')).toBeVisible();

  const after = {
    serialNumbers: tableCount('serial_numbers'),
    assets: tableCount('assets'),
    identifiers: tableCount('asset_identifiers'),
    events: tableCount('asset_events'),
    notes: tableCount('asset_notes')
  };
  expect(after).toEqual(before);

  await page.locator('input[type=file]').setInputFiles(source);
  await expect(page.getByText(/该文件已有预检查记录|预检查完成/)).toBeVisible();
  await logout(page);

  await login(page, '8016sun@maxcine.cn');
  const dealerResponse = await page.evaluate(async ({ base, body }) => {
    const response = await fetch(`${base}/admin/gsx/imports/precheck`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return response.status;
  }, { base: apiBase, body: precheckPayload() });
  expect(dealerResponse).toBe(403);
  await logout(page);

  await login(page, '8982warehouse@maxcine.cn');
  const warehouseResponse = await page.evaluate(async ({ base, body }) => {
    const response = await fetch(`${base}/admin/gsx/imports/precheck`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return response.status;
  }, { base: apiBase, body: precheckPayload() });
  expect(warehouseResponse).toBe(403);
});
