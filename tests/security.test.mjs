import assert from 'node:assert/strict';
import test from 'node:test';
import { PERMISSIONS, can, canAccessStore, canReadOrder, canTransitionOrder, createAfterSalesSchema, createOrderSchema, loginSchema, normalizeHistoricalWarrantyRecords, parseHistoricalDate, parseHistoricalPayment, parseHistoricalPrice, shipmentWarrantyDates, shipmentWarrantyRule, warrantyDisplayStatus } from '../packages/shared/dist/index.js';

function user({ id, permissions = [], storeIds = [], serviceCenterIds = [], roles = [] }) {
  return { id, email: `${id}@example.test`, name: id, permissions, storeIds, serviceCenterIds, roles, dealerIds: [] };
}

const dealerA = user({ id: 'dealer-a', roles: ['dealer'], storeIds: ['store-a'], permissions: ['order:read', 'order:create', 'order:submit', 'after-sales:create', 'after-sales:read', 'notifications:read'] });
const dealerB = user({ id: 'dealer-b', roles: ['dealer'], storeIds: ['store-b'], permissions: ['order:read', 'order:create', 'order:submit', 'after-sales:create', 'after-sales:read', 'notifications:read'] });
const warehouse = user({ id: 'warehouse', roles: ['warehouse_manager'], permissions: ['order:warehouse-read', 'order:fulfill', 'inventory:read', 'inventory:warehouse-manage', 'notifications:read'] });
const superAdmin = user({ id: 'super-admin', roles: ['super_admin'], permissions: ['data:read:all', 'user:manage', 'audit:read', 'after-sales:approve'] });
const serviceCenter = user({ id: 'service-center', roles: ['authorized_service_center'], serviceCenterIds: ['center-a'], permissions: ['after-sales:read', 'after-sales:receive', 'after-sales:damage-assess', 'after-sales:recommend'] });

test('dealer data isolation is based on store assignment rather than email or name', () => {
  assert.equal(canReadOrder(dealerA, { storeId: 'store-b', status: 'submitted' }), false);
  assert.equal(canReadOrder(dealerB, { storeId: 'store-b', status: 'submitted' }), true);
  assert.equal(canReadOrder(superAdmin, { storeId: 'store-b', status: 'submitted' }), true);
  assert.equal(canAccessStore(dealerA, 'store-a'), true);
  assert.equal(canAccessStore(dealerA, 'store-b'), false);
});

test('warehouse can only read orders after they enter the warehouse flow', () => {
  assert.equal(canReadOrder(warehouse, { storeId: 'store-a', status: 'draft' }), false);
  assert.equal(canReadOrder(warehouse, { storeId: 'store-a', status: 'submitted' }), false);
  assert.equal(canReadOrder(warehouse, { storeId: 'store-a', status: 'approved' }), true);
});

test('privileged operations require an effective permission relation', () => {
  assert.equal(can(dealerA, 'user:manage'), false);
  assert.equal(can(warehouse, 'inventory:manage'), false);
  assert.equal(can(warehouse, 'after-sales:read'), false);
  assert.equal(can(serviceCenter, 'after-sales:approve'), false);
  assert.equal(can(superAdmin, 'audit:read'), true);
});

test('order transitions are enforced by permissions, not a single role field', () => {
  assert.equal(canTransitionOrder(dealerA, 'draft', 'submitted'), true);
  assert.equal(canTransitionOrder(dealerA, 'submitted', 'approved'), false);
  assert.equal(canTransitionOrder(warehouse, 'approved', 'picking'), true);
  assert.equal(canTransitionOrder(warehouse, 'packed', 'shipped'), true);
  assert.equal(canTransitionOrder(warehouse, 'draft', 'picking'), false);
});

test('input normalizes account emails to lowercase', () => {
  assert.equal(loginSchema.parse({ email: 'YUKYINCHEW@MAXCINE.CN', password: 'DemoOnly-ChangeMe-2026' }).email, 'yukyinchew@maxcine.cn');
});

test('order and after-sales schemas allow local demo data without contact details', () => {
  const valid = createOrderSchema.parse({ storeId: '30000000-0000-4000-8000-000000000001', items: [{ productId: '40000000-0000-4000-8000-000000000001', quantity: 1 }] });
  assert.equal(valid.note, '');
  assert.equal(createOrderSchema.safeParse({ storeId: valid.storeId, items: [{ productId: valid.items[0].productId, quantity: 0 }] }).success, false);
  assert.equal(createAfterSalesSchema.safeParse({ storeId: valid.storeId, caseType: '产品异常', subject: '本地演示问题', description: '这是满足最短长度的本地演示问题描述。' }).success, true);
});

test('submitted-order fields accept bounded image data and reject unsafe screenshot text', () => {
  const input = createOrderSchema.parse({
    storeId: '30000000-0000-4000-8000-000000000001',
    items: [{ productId: '40000000-0000-4000-8000-000000000001', quantity: 1 }],
    salePriceCents: 129900,
    shippingAddress: '本地演示收货地址',
    customerProfile: '专业飞手',
    screenshotDataUrl: 'data:image/png;base64,aGVsbG8='
  });
  assert.equal(input.salePriceCents, 129900);
  assert.equal(createOrderSchema.safeParse({ ...input, screenshotDataUrl: 'data:text/html;base64,PHNjcmlwdD4=' }).success, false);
});

test('super administrators receive the same effective workflow permissions as warehouse and service center roles', () => {
  const fullSuperAdmin = user({ id: 'full-super-admin', roles: ['super_admin'], permissions: [...PERMISSIONS] });
  assert.equal(can(fullSuperAdmin, 'order:fulfill'), true);
  assert.equal(can(fullSuperAdmin, 'after-sales:receive'), true);
  assert.equal(can(fullSuperAdmin, 'after-sales:damage-assess'), true);
  assert.equal(canTransitionOrder(fullSuperAdmin, 'approved', 'picking'), true);
  assert.equal(canTransitionOrder(fullSuperAdmin, 'packed', 'shipped'), true);
});

test('shipment warranty rules use the confirmed SKU durations only', () => {
  assert.equal(shipmentWarrantyRule('W101')?.durationDays, 90);
  assert.equal(shipmentWarrantyRule('W113')?.durationDays, 90);
  assert.equal(shipmentWarrantyRule('W102')?.durationDays, 180);
  assert.equal(shipmentWarrantyRule('W103')?.durationDays, 365);
  assert.equal(shipmentWarrantyRule('W124')?.durationDays, 90);
  assert.equal(shipmentWarrantyRule('W114'), null);
  assert.deepEqual(shipmentWarrantyDates('2026-07-27 08:00:00', 90), { startAt: '2026-07-27', endAt: '2026-10-24' });
});

test('historical warranty records preserve warnings without rejecting a whole batch', () => {
  const rows = normalizeHistoricalWarrantyRecords([
    { rowNumber: 5, values: { '序号': 1, '销售渠道': '官方店', '版本': '标准版', '购买日期': '2025 11 18（23）', '购买价格': '129x15=1935', SN: 'SF0123456789012', '保修状态': '过保', '发出单号': 'SF0123456789012', '发货仓库': '淄博', '用户画像': '内部标签', '到账状态': '已到账578', '保修开始': '2025 11 20', '保修结束': '2026 11 20', '维修记录1': '序列号更换为6901649532999', '备注1': '历史说明' } },
    { rowNumber: 6, values: { '序号': 2, '销售渠道': '官方店', '版本': '标准版', SN: '6901649532888', '保修状态': '无保修', '保修开始': '无保修', '保修结束': '无保修', '到账状态': '已发货' } },
    { rowNumber: 7, values: { '序号': 3, '销售渠道': '官方店', '版本': '标准版', SN: '6901649532888', '保修状态': '拒保', '保修开始': '不得保修！', '保修结束': '不得保修！' } }
  ]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].currentSn, '6901649532999');
  assert.equal(rows[0].issues.some((issue) => issue.code === 'tracking_as_sn'), true);
  assert.equal(rows[0].purchaseDateAnnotation, '23');
  assert.equal(rows[0].unitPriceCents, 12900);
  assert.equal(rows[0].quantity, 15);
  assert.equal(rows[0].totalPriceCents, 193500);
  assert.equal(rows[0].paymentAmountCents, 57800);
  assert.equal(rows[0].notes.some((note) => note.category === 'private_admin' && note.visibility === 'admin_private'), true);
  assert.equal(rows[0].events.filter((event) => event.eventType === 'sn_changed').length, 1);
  assert.equal(rows[1].warrantyOverrideStatus, 'no_warranty');
  assert.equal(rows[2].warrantyOverrideStatus, 'denied');
  assert.equal(rows[1].issues.some((issue) => issue.code === 'duplicate_sn'), true);
  assert.equal(rows[2].issues.some((issue) => issue.code === 'duplicate_sn'), true);
});

test('warranty parsing and display favor manual status over dates', () => {
  assert.deepEqual(parseHistoricalDate('2025 7 25'), { date: '2025-07-25', annotation: '', special: 'none', invalid: false });
  assert.equal(parseHistoricalPrice('129x15=1935').totalPriceCents, 193500);
  assert.equal(parseHistoricalPayment('已发货').status, 'shipped');
  assert.equal(warrantyDisplayStatus({ warrantyStartAt: '2025-01-01', warrantyEndAt: '2028-01-01', warrantyOverrideStatus: 'denied' }), '拒保');
  assert.equal(warrantyDisplayStatus({ warrantyStartAt: null, warrantyEndAt: null, warrantyOverrideStatus: null }), '无有效日期');
});
