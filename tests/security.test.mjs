import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import { PERMISSIONS, can, canAccessStore, canReadOrder, canTransitionOrder, confirmQuoteSendSchema, createAfterSalesSchema, createCustomerRiskRecordSchema, createOrderSchema, loginSchema, normalizeHistoricalWarrantyRecords, parseHistoricalDate, parseHistoricalPayment, parseHistoricalPrice, quoteDraftSchema, shipmentSchema, shipmentWarrantyDates, shipmentWarrantyRule, updateCustomerRiskEventSchema, updateCustomerRiskProfileSchema, updateWatermarkPreferenceSchema, warrantyDisplayStatus } from '../packages/shared/dist/index.js';

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
  assert.equal(loginSchema.parse({ email: '9353XUYAN@MAXCINE.CN', password: 'MaxCINE2026!' }).email, '9353xuyan@maxcine.cn');
});

test('watermark preference only accepts an explicit boolean switch', () => {
  assert.equal(updateWatermarkPreferenceSchema.parse({ enabled: false }).enabled, false);
  assert.equal(updateWatermarkPreferenceSchema.safeParse({ enabled: 'false' }).success, false);
});

test('customer risk center keeps dealer flow create-only and accepts IP location', () => {
  assert.equal(PERMISSIONS.includes('customer-risk:read'), true);
  assert.equal(PERMISSIONS.includes('customer-risk:manage'), true);
  const riskDealer = user({ id: 'risk-dealer', roles: ['dealer'], permissions: ['customer-risk:read', 'customer-risk:create'] });
  assert.equal(can(riskDealer, 'customer-risk:create'), true);
  assert.equal(can(riskDealer, 'customer-risk:manage'), false);
  const record = createCustomerRiskRecordSchema.parse({
    customer: { phone: '18191316611', name: '何满堂', city: '渭南', platformNickname: 'tbNick_91xpa', ipLocation: '陕西省' },
    status: 'blacklist',
    riskLevel: 'high',
    riskReasons: ['反复砍价', '其他'],
    otherReason: '验收补充原因',
    consultationResult: '未成交',
    note: '只记录本次咨询，不覆盖其他经销商记录。'
  });
  assert.equal(record.productScope, 'MAVIC_4_PRO_ANAMORPHIC');
  assert.equal(record.customer.ipLocation, '陕西省');
  assert.equal(createCustomerRiskRecordSchema.safeParse({ customer: { phone: '13800000000' }, riskReasons: ['其他'] }).success, false);
  assert.equal(updateCustomerRiskEventSchema.safeParse({ status: 'watchlist', riskLevel: 'medium', riskReasons: ['大量询价未购买'], consultationResult: '跟进中', note: '更新本人记录' }).success, true);
  assert.equal(updateCustomerRiskProfileSchema.parse({ customer: { platformNickname: 'tbNick_91xpa', ipLocation: '陕西省' }, status: 'blacklist' }).customer.ipLocation, '陕西省');
});

test('quote workflow requires explicit preview state and a unique send idempotency key', () => {
  const quote = quoteDraftSchema.parse({
    inspectionSummary: '验收检测结论',
    finalDecision: '保外收费维修',
    validUntil: '2026-08-05',
    items: [{ itemName: '验收服务费', itemType: '服务费', quantity: 1, unitPriceCents: 8000 }],
    workflowStatus: 'READY_FOR_REVIEW'
  });
  assert.equal(quote.workflowStatus, 'READY_FOR_REVIEW');
  assert.equal(confirmQuoteSendSchema.safeParse({ idempotencyKey: 'not-a-uuid' }).success, false);
  assert.equal(confirmQuoteSendSchema.safeParse({ idempotencyKey: 'd83cd945-7474-4fa9-a38b-375c1015e2db' }).success, true);
});

test('quote delivery uses a locked snapshot, notification sender and support reply address', () => {
  const source = readFileSync(new URL('../apps/api/src/index.ts', import.meta.url), 'utf8');
  const emailSource = readFileSync(new URL('../apps/api/src/email.ts', import.meta.url), 'utf8');
  const dbSource = readFileSync(new URL('../apps/api/src/db.ts', import.meta.url), 'utf8');
  const adminUiSource = readFileSync(new URL('../apps/web/src/AdminManagementPortal.tsx', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../apps/api/migrations/0012_quote_review_and_delivery.sql', import.meta.url), 'utf8');
  assert.match(source, /\/after-sales-quotes\/:quoteId\/confirm-send/);
  assert.match(source, /workflow_status = 'SENDING'/);
  assert.match(source, /notification@maxcine\.cn/);
  assert.match(source, /support@maxcine\.cn/);
  assert.match(source, /function escapeHtml/);
  assert.match(source, /escapeHtml\(snapshot\.customerDescription/);
  assert.match(source, /sendViaMailCenter/);
  assert.match(source, /mailSubject\('after_sales_quote'/);
  assert.match(source, /此邮件为系统自动发送，请勿直接回复/);
  assert.match(source, /https:\/\/qr\.alipay\.com\/fkx13048tsi5aspx4dbzq72/);
  assert.match(source, /使用支付宝付款/);
  assert.match(source, /请您付款时添加备注您的案例号/);
  assert.match(source, /snapshot\.grandTotalCents > 0/);
  assert.match(source, /ensurePaidQuotePaymentAction/);
  assert.match(dbSource, /CAS-\$\{token\.slice\(0, 5\)\}-\$\{token\.slice\(5, 10\)\}/);
  assert.doesNotMatch(adminUiSource, /打印 \/ 保存 PDF/);
  assert.doesNotMatch(adminUiSource, /PDF 附件/);
  assert.match(emailSource, /Idempotency-Key/);
  assert.match(emailSource, /reply_to/);
  assert.match(emailSource, /邮件服务未配置/);
  assert.match(emailSource, /【STAGING】/);
  assert.match(source, /【请勿回复】MaxCINE 服务中心/);
  assert.match(migration, /READY_FOR_REVIEW/);
  assert.match(migration, /SEND_FAILED/);
  assert.match(migration, /idx_after_sales_quote_email_idempotency/);
});

test('order schema accepts drafts while after-sales allows optional notes and contact snapshot', () => {
  const valid = createOrderSchema.parse({ storeId: '30000000-0000-4000-8000-000000000001', items: [{ productId: '40000000-0000-4000-8000-000000000001', quantity: 1 }] });
  assert.equal(valid.note, '');
  assert.equal(createOrderSchema.safeParse({ storeId: valid.storeId, items: [{ productId: valid.items[0].productId, quantity: 0 }] }).success, false);
  assert.equal(createAfterSalesSchema.safeParse({ storeId: valid.storeId, caseType: '产品异常', subject: '验收问题', description: '这是满足最短长度的验收问题描述。' }).success, false);
  assert.equal(createAfterSalesSchema.safeParse({
    assetId: '99000000-0000-4000-8000-000000000001',
    caseType: 'QUALITY_ISSUE'
  }).success, true);
  assert.equal(createAfterSalesSchema.safeParse({
    assetId: '99000000-0000-4000-8000-000000000001',
    storeId: valid.storeId,
    caseType: 'QUALITY_ISSUE',
    subject: '验收问题',
    description: '这是满足最短长度的验收问题描述。',
    contactName: '验收客户',
    contactPhone: '13800000000',
    contactEmail: 'local-test@example.test',
    contactAddress: '验收地址，不是真实客户资料'
  }).success, true);
});

test('submitted-order fields accept bounded image data and reject unsafe screenshot text', () => {
  const input = createOrderSchema.parse({
    storeId: '30000000-0000-4000-8000-000000000001',
    items: [{ productId: '40000000-0000-4000-8000-000000000001', quantity: 1 }],
    salePriceCents: 129900,
    shippingAddress: '验收收货地址',
    customerProfile: '专业飞手',
    screenshotDataUrl: 'data:image/png;base64,aGVsbG8='
  });
  assert.equal(input.salePriceCents, 129900);
  assert.equal(createOrderSchema.safeParse({ ...input, screenshotDataUrl: 'data:text/html;base64,PHNjcmlwdD4=' }).success, false);
});

test('shipment confirmation accepts optional categorized outbound photos and still rejects unsafe image data', () => {
  const parsed = shipmentSchema.parse({
    carrier: '顺丰速运',
    trackingNumber: 'SF1234567890',
    serialNumbers: ['STAGE-GSX-W101-0102'],
    photos: [
      { category: 'box_sn', originalFilename: 'box-sn.jpg', contentType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,aGVsbG8=' },
      { category: 'packed_photo_1', originalFilename: 'packed-1.jpg', contentType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,aGVsbG8=' },
      { category: 'packed_photo_2', originalFilename: 'packed-2.jpg', contentType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,aGVsbG8=' }
    ]
  });
  assert.equal(parsed.photos.length, 3);
  assert.equal(shipmentSchema.safeParse({ ...parsed, photos: [{ ...parsed.photos[0], dataUrl: 'data:text/html;base64,PHNjcmlwdD4=' }] }).success, false);
  assert.equal(shipmentSchema.parse({ carrier: '顺丰速运', serialNumbers: ['STAGE-GSX-W101-0102'] }).photos.length, 0);
  const source = readFileSync(new URL('../apps/api/src/index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /确认发货前请上传/);
  assert.match(source, /shipment_photos/);
});

test('MaxCINE Intelligence is a disabled coming-soon entry without AI provider calls', () => {
  const appSource = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
  const navSource = readFileSync(new URL('../apps/web/src/systemNavigation.tsx', import.meta.url), 'utf8');
  const pageSource = readFileSync(new URL('../apps/web/src/IntelligencePortal.tsx', import.meta.url), 'utf8');
  const config = readFileSync(new URL('../apps/api/wrangler.toml', import.meta.url), 'utf8');
  const combined = `${appSource}\n${navSource}\n${pageSource}`;
  assert.match(navSource, /MaxCINE Intelligence/);
  assert.match(navSource, /function hasIntelligenceAccess/);
  assert.match(navSource, /return hasAdminAccess\(user\) \|\| hasDealerAccess\(user\)/);
  assert.doesNotMatch(navSource, /hasWarehouseAccess\(user\).*MaxCINE Intelligence/s);
  assert.doesNotMatch(navSource, /hasServiceCenterAccess\(user\).*MaxCINE Intelligence/s);
  assert.match(appSource, /\/system\/intelligence/);
  assert.match(pageSource, /Coming Soon/);
  assert.match(pageSource, /IN DEVELOPMENT/);
  assert.doesNotMatch(pageSource, /textarea|发送|button[^>]*发送/i);
  assert.match(config, /AI_PROVIDER = "disabled"/);
  assert.doesNotMatch(combined, /deepseek|hunyuan|混元|api\.openai\.com|api\.deepseek\.com/i);
});

test('after-sales stages hide obsolete actions and backend rejects stale stage writes', () => {
  const apiSource = readFileSync(new URL('../apps/api/src/index.ts', import.meta.url), 'utf8');
  const adminUiSource = readFileSync(new URL('../apps/web/src/AdminManagementPortal.tsx', import.meta.url), 'utf8');
  assert.match(adminUiSource, /after-sales-phase-nav/);
  assert.match(adminUiSource, /data-phase=\{detailPhase\}/);
  assert.match(adminUiSource, /尚未到达该阶段/);
  assert.match(apiSource, /该工单当前不能录入寄修单号/);
  assert.match(apiSource, /\['WAITING_CUSTOMER_SHIPMENT', 'WAITING_SERVICE_CENTER_RECEIPT'\]\.includes\(serviceCase\.serviceStage\)/);
  assert.match(apiSource, /该工单当前不能提交检测结果/);
  assert.match(apiSource, /该工单当前不需要确认收款/);
  assert.match(apiSource, /该工单当前还不能发货/);
});

test('global toast and forced password change use a viewport-fixed notification path', () => {
  const appSource = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
  const toastSource = readFileSync(new URL('../apps/web/src/Toast.tsx', import.meta.url), 'utf8');
  const cssSource = readFileSync(new URL('../apps/web/src/design-system.css', import.meta.url), 'utf8');
  const apiSource = readFileSync(new URL('../apps/api/src/index.ts', import.meta.url), 'utf8');
  const authSource = readFileSync(new URL('../apps/api/src/auth.ts', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../apps/api/migrations/0023_password_reset_and_dealer_notifications.sql', import.meta.url), 'utf8');
  assert.match(appSource, /ToastProvider/);
  assert.match(appSource, /\/system\/change-password/);
  assert.match(appSource, /user\.mustChangePassword/);
  assert.match(toastSource, /ToastProvider/);
  assert.match(toastSource, /useToast/);
  assert.match(cssSource, /\.toast-stack/);
  assert.match(cssSource, /position: fixed/);
  assert.match(apiSource, /must_change_password = 1/);
  assert.match(apiSource, /session_version = session_version \+ 1/);
  assert.match(apiSource, /user\.change_password/);
  assert.match(authSource, /mustChangePassword/);
  assert.match(migration, /must_change_password/);
  assert.match(apiSource, /after: \{ sessionRevoked: true, mustChangePassword: true \}/);
  assert.match(apiSource, /after: \{ mustChangePassword: false \}/);
});

test('dealer shipment notifications use dealer notification email and never roll back shipment on mail failure', () => {
  const apiSource = readFileSync(new URL('../apps/api/src/index.ts', import.meta.url), 'utf8');
  const schemasSource = readFileSync(new URL('../packages/shared/src/schemas.ts', import.meta.url), 'utf8');
  const adminUiSource = readFileSync(new URL('../apps/web/src/AdminManagementPortal.tsx', import.meta.url), 'utf8');
  const operationsUiSource = readFileSync(new URL('../apps/web/src/OperationsPortal.tsx', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../apps/api/migrations/0023_password_reset_and_dealer_notifications.sql', import.meta.url), 'utf8');
  assert.match(schemasSource, /notificationEmail/);
  assert.match(adminUiSource, /通知邮箱/);
  assert.match(migration, /notification_email/);
  assert.match(apiSource, /SELECT name, notification_email AS notificationEmail FROM dealers/);
  assert.match(apiSource, /dealer-shipment-notification:\$\{order\.id\}:\$\{shipmentId\}/);
  assert.match(apiSource, /NO_RECIPIENT/);
  assert.match(apiSource, /template: 'shipment_notice'/);
  assert.match(apiSource, /订单已发货/);
  assert.match(apiSource, /return c\.json\(\{ id: order\.id, status: 'shipped'/);
  assert.match(operationsUiSource, /通知邮件发送失败/);
  assert.doesNotMatch(apiSource, /throw conflict\('邮件发送失败|throw badRequest\('邮件发送失败/);
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
  assert.deepEqual(shipmentWarrantyDates('2026-07-27 08:00:00', 90), { startAt: '2026-07-30', endAt: '2026-10-27' });
  assert.deepEqual(shipmentWarrantyDates('2026-08-12 16:30:00', 90), { startAt: '2026-08-15', endAt: '2026-11-12' });
  assert.deepEqual(shipmentWarrantyDates('2026-08-31 23:59:00', 90), { startAt: '2026-09-03', endAt: '2026-12-01' });
  assert.deepEqual(shipmentWarrantyDates('2026-12-31 23:59:00', 90), { startAt: '2027-01-03', endAt: '2027-04-02' });
  assert.deepEqual(shipmentWarrantyDates('2026-08-12T16:30:00+08:00', 90), { startAt: '2026-08-15', endAt: '2026-11-12' });
  assert.deepEqual(shipmentWarrantyDates(new Date('2026-08-12T15:59:59.000Z'), 180), { startAt: '2026-08-15', endAt: '2027-02-10' });
});

test('public warranty API uses slider token, Fujian edge check and an explicit safe DTO', () => {
  const source = readFileSync(new URL('../apps/api/src/index.ts', import.meta.url), 'utf8');
  const config = readFileSync(new URL('../apps/api/wrangler.toml', import.meta.url), 'utf8');
  assert.match(source, /\/public\/warranty\/challenges/);
  assert.match(source, /sliderValue < 98/);
  assert.match(source, /consumePublicWarrantyToken/);
  assert.match(source, /used_at = CURRENT_TIMESTAMP/);
  assert.match(source, /isPublicPath\(pathname\) && isFujianRequest/);
  assert.ok(source.includes("cf?.country !== 'CN'"));
  assert.match(source, /'fujian', '福建', '福建省'/);
  assert.match(source, /'fj', 'cn-fj'/);
  assert.ok(source.includes('serialNumber: row.serialNumber'));
  assert.ok(source.includes('productName: row.productName'));
  assert.match(source, /warrantyStatus: publicWarrantyStatus/);
  const publicWarrantyRoute = source.slice(source.indexOf("app.get('/public/warranty/:sn'"), source.indexOf("app.get('/repair-materials'"));
  assert.ok(publicWarrantyRoute.length > 0);
  assert.doesNotMatch(publicWarrantyRoute, /SELECT \*/);
  assert.doesNotMatch(publicWarrantyRoute, /object_key AS objectKey/);
  assert.doesNotMatch(publicWarrantyRoute, /factory/i);
  assert.ok(config.includes('PUBLIC_ORIGIN = "https://maxcine-website-staging.pages.dev"'));
});

test('public and internal warranties are initialized together but edited independently', () => {
  const source = readFileSync(new URL('../apps/api/src/index.ts', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../apps/api/migrations/0021_public_warranty_and_factory_photos.sql', import.meta.url), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS asset_public_warranties/);
  assert.match(migration, /UNIQUE REFERENCES assets/);
  assert.match(source, /INSERT OR IGNORE INTO asset_public_warranties/);
  assert.match(source, /shouldInitializeInternalWarranty/);
  assert.ok(source.includes('asset.public_warranty_update'));
  const publicWarrantyUpdateRoute = source.slice(source.indexOf("app.patch('/admin/assets/:id/public-warranty'"), source.indexOf("app.post('/admin/assets/:id/factory-photos'"));
  const internalWarrantyUpdateRoute = source.slice(source.indexOf("app.patch('/admin/assets/:id/warranty'"), source.indexOf("app.patch('/admin/assets/:id/public-warranty'"));
  assert.doesNotMatch(publicWarrantyUpdateRoute, /UPDATE assets SET warranty_/);
  assert.doesNotMatch(internalWarrantyUpdateRoute, /asset_public_warranties/);
});

test('factory photos are internal R2-only metadata and never exposed by public warranty', () => {
  const source = readFileSync(new URL('../apps/api/src/index.ts', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../apps/api/migrations/0021_public_warranty_and_factory_photos.sql', import.meta.url), 'utf8');
  const multiPhotoMigration = readFileSync(new URL('../apps/api/migrations/0022_factory_photos_multi_upload.sql', import.meta.url), 'utf8');
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(migration, /CREATE TABLE IF NOT EXISTS asset_factory_photos/);
  assert.match(migration, /object_key TEXT NOT NULL/);
  assert.match(multiPhotoMigration, /asset_factory_photos_v2/);
  assert.doesNotMatch(multiPhotoMigration, /UNIQUE\(asset_id, photo_type\)/);
  assert.match(source, /图片存储尚未启用/);
  assert.match(source, /form\.getAll\('files'\)/);
  assert.ok(source.includes('c.env.ASSETS.put'));
  assert.match(source, /factory-photos\/photo_\$\{Date\.now\(\)\}_\$\{randomParts\}\.\$\{extension\}/);
  assert.doesNotMatch(source, /factory-photos-\$\{asset\.id\}-\$\{Date\.now\(\)\}/);
  assert.doesNotMatch(source, /factory-photos\/p_\$\{photoId/);
  assert.match(packageJson.devDependencies.wrangler, /\^4\.(12[3-9]|1[3-9]\d|[2-9]\d{2,})\./);
  assert.doesNotMatch(source, /ON CONFLICT\(asset_id, photo_type\)/);
  assert.doesNotMatch(migration, /data_url/);
  assert.doesNotMatch(source, /asset_factory_photos[\\s\\S]*data_url/);
  const publicWarrantyRoute = source.slice(source.indexOf("app.get('/public/warranty/:sn'"), source.indexOf("app.get('/repair-materials'"));
  assert.doesNotMatch(publicWarrantyRoute, /factoryPhotos/);
});

test('factory photo deletion verifies the exact R2 object before removing D1 metadata', () => {
  const source = readFileSync(new URL('../apps/api/src/index.ts', import.meta.url), 'utf8');
  const deleteRoute = source.slice(source.indexOf("app.delete('/admin/assets/:id/factory-photos/:photoId'"), source.indexOf("app.get('/admin/audit-logs'"));
  assert.match(deleteRoute, /object_key AS objectKey/);
  assert.match(deleteRoute, /ASSETS\.head\(photo\.objectKey\)/);
  assert.match(deleteRoute, /ASSETS\.get\(photo\.objectKey\)/);
  assert.match(deleteRoute, /ASSETS\.delete\(photo\.objectKey\)/);
  assert.match(deleteRoute, /ASSETS\.list\(\{\s*prefix: photo\.objectKey/);
  assert.match(deleteRoute, /R2 图片对象删除失败/);
  assert.match(deleteRoute, /deleteSafetyDelayMs = 6500/);
  assert.ok(deleteRoute.indexOf('ASSETS.delete(photo.objectKey)') < deleteRoute.indexOf("DELETE FROM asset_factory_photos"));
});

test('website keeps the original static architecture while warranty query uses the public API', () => {
  const warrantyJs = readFileSync(new URL('../apps/website/warranty.js', import.meta.url), 'utf8');
  const middleware = readFileSync(new URL('../apps/website/functions/_middleware.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../apps/website/warranty.html', import.meta.url), 'utf8');
  assert.match(warrantyJs, /MAXCINE_PUBLIC_API_BASE/);
  assert.ok(warrantyJs.includes('/public/warranty/challenges'));
  assert.ok(warrantyJs.includes('/public/warranty/${encodeURIComponent(normalized)}'));
  assert.ok(!warrantyJs.includes('/data/'));
  assert.match(html, /slider-input/);
  assert.match(middleware, /request\.cf/);
  assert.match(middleware, /您访问的页面不存在/);
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
