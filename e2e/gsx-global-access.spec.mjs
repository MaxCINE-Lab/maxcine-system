import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from '@playwright/test';
import * as XLSX from 'xlsx';

const password = process.env.E2E_PASSWORD;
const persistence = process.env.E2E_D1_PERSISTENCE;
const root = resolve(import.meta.dirname, '..');
const apiBase = 'http://127.0.0.1:8791';
const superAdminRoleId = '21000000-0000-4000-8000-000000000001';
if (!password || !persistence) throw new Error('请通过浏览器验收脚本提供隔离数据库和演示账户密码。');

function fixture() {
  const rows = [
    ['序号', '销售渠道', '版本', '购买日期', '购买价格', 'SN', '保修状态', '发出单号', '发货仓库', '用户画像', '到账状态', '保修开始', '保修结束', '维修记录1', '维修记录2', '维修记录3', '维修记录4', '备注1', '备注2', '备注3', '备注4', '备注5'],
    [1, '无关联历史渠道', '早期标准版', '2025 11 18', 599, 'SF1123456789012', '在保', 'SF0123456789012', '淄博', '仅限超级管理员查看', '已到账578', '2025 11 20', '2026 11 20', '序列号更换为6900000000101', null, null, null, '早期产品以运单号作为历史标识', null, null, null, null]
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  const file = join(tmpdir(), 'maxcine-gsx-global-access.xlsx');
  XLSX.writeFile(workbook, file);
  return file;
}

function execute(sql) {
  execFileSync(process.execPath, [join(root, 'node_modules/wrangler/wrangler-dist/cli.js'), 'd1', 'execute', 'maxcine-db', '--local', '--persist-to', persistence, '--config', 'apps/api/wrangler.toml', '--command', sql], { cwd: root, stdio: 'pipe' });
}

async function login(page) {
  await page.goto('/#/login');
  await page.getByLabel('AD账号').fill('9353xuyan@maxcine.cn');
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForFunction(() => location.hash !== '#/login');
}

test('超级管理员通过全局权限读取未关联的历史 GSX 资产', async ({ page }) => {
  const source = fixture();
  try {
    await login(page);
    await page.goto('/#/system/admin/assets/import');
    await page.locator('input[type=file]').setInputFiles(source);
    await expect(page.getByText('预检查完成，请查看警告和错误后确认导入。')).toBeVisible();
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: '确认导入' }).click();
    await expect(page.getByText('导入完成：已导入 1 条，跳过 0 条。')).toBeVisible();

    const imported = await page.evaluate(async (base) => {
      const response = await fetch(`${base}/gsx/search?q=6900000000101`, { credentials: 'include' });
      return { status: response.status, body: await response.json() };
    }, apiBase);
    expect(imported.status).toBe(200);
    const assetId = imported.body.items[0].id;

    // Reproduce the historical permission shape: the role retains global data
    // access but has no asset-specific grant. This must still allow GSX reads.
    execute(`DELETE FROM role_permissions WHERE role_id = '${superAdminRoleId}' AND permission_code IN ('asset:read', 'asset:warehouse-read')`);

    const result = await page.evaluate(async ({ base, id }) => {
      const current = await fetch(`${base}/gsx/search?q=6900000000101`, { credentials: 'include' });
      const tracking = await fetch(`${base}/gsx/search?q=SF0123456789012`, { credentials: 'include' });
      const detail = await fetch(`${base}/assets/${id}`, { credentials: 'include' });
      const detailBody = await detail.json();
      const original = await fetch(`${base}/gsx/search?q=${encodeURIComponent(detailBody.asset.originalSn)}`, { credentials: 'include' });
      const noMatch = await fetch(`${base}/gsx/search?q=9999999999999`, { credentials: 'include' });
      const unauthenticated = await fetch(`${base}/gsx/search?q=6900000000101`, { credentials: 'omit' });
      return {
        current: { status: current.status, body: await current.json() },
        original: { status: original.status, body: await original.json() },
        tracking: { status: tracking.status, body: await tracking.json() },
        detail: { status: detail.status, body: detailBody },
        noMatch: { status: noMatch.status, body: await noMatch.json() },
        unauthenticated: unauthenticated.status
      };
    }, { base: apiBase, id: assetId });

    expect(result.current.status).toBe(200);
    expect(result.current.body.items.some((item) => item.id === assetId)).toBe(true);
    expect(result.original.status).toBe(200);
    expect(result.original.body.items.some((item) => item.id === assetId)).toBe(true);
    expect(result.tracking.status).toBe(200);
    expect(result.tracking.body.items.some((item) => item.id === assetId)).toBe(true);
    expect(result.detail.status).toBe(200);
    expect(result.detail.body.asset.dealerName).toBeNull();
    expect(result.detail.body.asset.storeName).toBeNull();
    expect(result.detail.body.identifiers.some((identifier) => identifier.identifierValue === result.detail.body.asset.originalSn)).toBe(true);
    expect(result.detail.body.notes.some((note) => note.visibility === 'admin_private')).toBe(true);
    expect(result.noMatch.status).toBe(200);
    expect(result.noMatch.body.items).toEqual([]);
    expect(result.unauthenticated).toBe(401);

    await page.goto('/#/system/admin/assets');
    await page.getByLabel('SN 或资产标识').fill('6900000000101');
    await page.getByRole('button', { name: '查询' }).click();
    await expect(page.getByRole('heading', { name: '资产详情' })).toBeVisible();
    await expect(page.getByText('当前 SN：6900000000101')).toBeVisible();
    await expect(page.getByRole('heading', { name: /MaxCINE MAVIC 4 Pro 增广镜/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: '生命周期' })).toBeVisible();
    await expect(page.getByText('你没有权限查看该资产。')).toHaveCount(0);

    await page.goto('/#/system/admin/assets/00000000-0000-4000-8000-000000000099');
    await expect(page.getByText('未找到相关资产。')).toBeVisible();
    await expect(page.getByText('你没有权限查看该资产。')).toHaveCount(0);
  } finally {
    execute(`INSERT OR IGNORE INTO role_permissions (role_id, permission_code) VALUES ('${superAdminRoleId}', 'asset:read'), ('${superAdminRoleId}', 'asset:warehouse-read')`);
  }
});
