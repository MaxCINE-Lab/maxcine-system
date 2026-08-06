import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().email().max(254).transform((value) => value.toLowerCase().trim()),
  password: z.string().min(8).max(128)
});

export const createOrderSchema = z.object({
  storeId: z.string().uuid(),
  items: z.array(z.object({ productId: z.string().uuid(), quantity: z.number().int().min(1).max(999) })).min(1).max(100),
  note: z.string().trim().max(500).default(''),
  salePriceCents: z.number().int().min(0).max(999999999).nullable().default(null),
  shippingAddress: z.string().trim().max(500).default(''),
  customerProfile: z.string().trim().max(120).default(''),
  screenshotDataUrl: z.string().max(750000).refine(
    (value) => value === '' || /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value),
    '订单截图仅支持 PNG、JPG 或 WebP 图片'
  ).default('')
});

export const updateOrderSchema = createOrderSchema;

export const reviewOrderSchema = z.object({
  approved: z.boolean(),
  note: z.string().trim().max(1000).default('')
}).superRefine((value, ctx) => {
  if (!value.approved && !value.note) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['note'], message: '审核不通过时必须填写原因' });
});

export const scanSerialSchema = z.object({
  productId: z.string().uuid(),
  serialNumber: z.string().trim().min(3).max(100).regex(/^[A-Za-z0-9._\-/]+$/, 'SN 只能包含字母、数字和常用连接符')
});

const serialInputSchema = z.string().transform((value) => value.replace(/[\r\n\t]/g, '').trim().toUpperCase()).pipe(
  z.string().min(3, '请输入产品 SN').max(100).regex(/^[A-Z0-9._\-/]+$/, 'SN 只能包含字母、数字和常用连接符')
);

const optionalTrackingSchema = z.string().trim().max(80).refine((value) => value === '' || /^[A-Za-z0-9._\-/]+$/.test(value), '运单号只能包含字母、数字和常用连接符');
const optionalUuidSchema = z.string().uuid().nullable().optional();
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');
const afterSalesCaseTypeSchema = z.enum([
  'OUT_OF_WARRANTY_REPAIR',
  'INSTALLATION_ISSUE',
  'QUALITY_ISSUE',
  'IMAGE_QUALITY_ISSUE',
  'MISSING_ACCESSORY',
  'PART_PURCHASE'
]);

export const shipmentSchema = z.object({
  carrier: z.string().trim().min(2).max(40).default('顺丰速运'),
  trackingNumber: optionalTrackingSchema.default(''),
  serialNumbers: z.array(serialInputSchema).min(1, '确认发货前必须录入产品 SN').max(100),
  photos: z.array(z.object({
    category: z.enum(['box_sn', 'packed_photo_1', 'packed_photo_2']),
    originalFilename: z.string().trim().min(1).max(180),
    contentType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    dataUrl: z.string().max(750000).refine(
      (value) => /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value),
      '出库照片仅支持 PNG、JPG 或 WebP 图片'
    )
  })).max(3).default([])
});

export const orderFulfillmentSchema = z.object({
  packageMaterials: z.array(z.enum(['顺丰f1纸箱', '顺丰f2纸箱', '普通纸箱', '定制纸箱', '防水袋', '文件袋', '葫芦泡（白色普通）', '葫芦泡（蓝色加强）'])).max(8).default([]),
  carrier: z.string().trim().min(2).max(40).default('顺丰速运'),
  trackingNumber: optionalTrackingSchema.default(''),
  allocationMode: z.enum(['none', 'random', 'manual']).default('none'),
  serialNumbers: z.array(serialInputSchema).max(100).default([])
}).superRefine((value, context) => {
  if (value.allocationMode === 'manual' && !value.serialNumbers.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ['serialNumbers'], message: '手动指定 SN 时必须填写产品 SN' });
});

export const createAfterSalesSchema = z.object({
  assetId: z.string().uuid(),
  storeId: optionalUuidSchema,
  dealerId: optionalUuidSchema,
  serviceCenterId: optionalUuidSchema,
  orderId: optionalUuidSchema,
  productId: optionalUuidSchema,
  serialNumber: z.string().trim().max(100).optional().nullable(),
  caseType: afterSalesCaseTypeSchema,
  subject: z.string().trim().min(2).max(160).optional().default('售后申请'),
  description: z.string().trim().max(5000).default(''),
  customerNote: z.string().trim().max(1000).default(''),
  internalNote: z.string().trim().max(2000).default(''),
  contactName: z.string().trim().max(80).default(''),
  contactPhone: z.string().trim().max(32).default(''),
  contactEmail: z.string().trim().max(254).transform((value) => value.toLowerCase()).default(''),
  contactAddress: z.string().trim().max(500).default(''),
  isProxySubmission: z.boolean().default(false)
});

export const createProductSchema = z.object({
  sku: z.string().trim().min(2).max(64).regex(/^[A-Z0-9._-]+$/, 'SKU 只能使用大写字母、数字和常用连接符'),
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().max(2000).default(''),
  unitPriceCents: z.number().int().min(0).max(999999999),
  productVersion: z.string().trim().max(80).default(''),
  specification: z.string().trim().max(160).default(''),
  reorderLevel: z.number().int().min(0).max(999999).default(0)
});

export const updateProductSchema = createProductSchema.extend({
  isActive: z.boolean().default(true)
});

export const adjustInventorySchema = z.object({
  quantityDelta: z.number().int().min(-999999).max(999999).refine((value) => value !== 0, '调整数量不能为零'),
  note: z.string().trim().min(3).max(500)
});

export const createDealerSchema = z.object({
  code: z.string().trim().min(2).max(32).regex(/^[A-Z0-9-]+$/, '经销商编码只能使用大写字母、数字和连字符'),
  name: z.string().trim().min(2).max(160),
  province: z.string().trim().max(64).default(''),
  authorizationType: z.string().trim().min(2).max(80).default('授权经销商'),
  serviceCenterId: z.string().uuid().nullable().default(null),
  contactName: z.string().trim().max(80).default('')
});

export const updateDealerSchema = createDealerSchema.omit({ code: true }).extend({
  code: z.string().trim().min(2).max(32).regex(/^[A-Z0-9-]+$/, '经销商编码只能使用大写字母、数字和连字符'),
  status: z.enum(['active', 'inactive'])
});

export const createStoreSchema = z.object({
  dealerId: z.string().uuid(),
  code: z.string().trim().min(2).max(32).regex(/^[A-Z0-9-]+$/, '店铺编码只能使用大写字母、数字和连字符'),
  name: z.string().trim().min(2).max(160),
  platform: z.string().trim().min(2).max(64),
  ownerUserId: z.string().uuid()
});

export const updateStoreSchema = z.object({
  dealerId: z.string().uuid(),
  code: z.string().trim().min(2).max(32).regex(/^[A-Z0-9-]+$/, '店铺编码只能使用大写字母、数字和连字符'),
  name: z.string().trim().min(2).max(160),
  platform: z.enum(['闲鱼', '淘宝', '官方渠道', '线下门店', '其他']),
  ownerUserId: z.string().uuid().nullable(),
  status: z.enum(['active', 'inactive'])
});

export const createUserSchema = z.object({
  email: z.string().email().max(254).transform((value) => value.toLowerCase().trim()),
  name: z.string().trim().min(2).max(120),
  password: z.string().min(12).max(128),
  roleIds: z.array(z.string().uuid()).min(1).max(10),
  dealerIds: z.array(z.string().uuid()).max(20).default([]),
  serviceCenterIds: z.array(z.string().uuid()).max(20).default([]),
  storeIds: z.array(z.string().uuid()).max(100).default([])
});

export const updateUserSchema = z.object({
  name: z.string().trim().min(2).max(120),
  roleIds: z.array(z.string().uuid()).min(1).max(10),
  dealerIds: z.array(z.string().uuid()).max(20).optional(),
  serviceCenterIds: z.array(z.string().uuid()).max(20).optional(),
  storeIds: z.array(z.string().uuid()).max(100).optional(),
  isActive: z.boolean()
});

export const updateWatermarkPreferenceSchema = z.object({
  enabled: z.boolean()
});

export const customerRiskStatusSchema = z.enum(['normal', 'watchlist', 'risk', 'blacklist']);
export const customerRiskLevelSchema = z.enum(['low', 'medium', 'high']);
export const customerRiskReasonSchema = z.enum([
  '反复砍价',
  '乐龄人士',
  '大量询价未购买',
  '智力低下',
  '多家询价砍价',
  '恶意骚扰',
  '频繁退款',
  '辱骂客服',
  '要求超出售后政策',
  '反复修改需求',
  '疑似同行调研',
  '有骗保记录',
  '其他'
]);
export const customerRiskResultSchema = z.enum(['成交', '未成交', '跟进中', '未知']);
export const customerRiskProductScopeSchema = z.enum(['MAVIC_4_PRO_ANAMORPHIC', 'POCKET', 'ND', 'OTHER']);

const customerRiskCustomerSchema = z.object({
  name: z.string().trim().max(80).default(''),
  phone: z.string().trim().max(40).default(''),
  recipientName: z.string().trim().max(80).default(''),
  platformNickname: z.string().trim().max(120).default(''),
  wechatNickname: z.string().trim().max(120).default(''),
  qqNickname: z.string().trim().max(120).default(''),
  telegram: z.string().trim().max(120).default(''),
  whatsapp: z.string().trim().max(120).default(''),
  shippingAddress: z.string().trim().max(500).default(''),
  city: z.string().trim().max(80).default(''),
  ipLocation: z.string().trim().max(120).default(''),
  keyword: z.string().trim().max(160).default(''),
  note: z.string().trim().max(1000).default('')
});

export const createCustomerRiskRecordSchema = z.object({
  customerId: z.string().uuid().optional(),
  dealerId: z.string().uuid().optional().nullable(),
  storeId: z.string().uuid().optional().nullable(),
  customer: customerRiskCustomerSchema,
  status: customerRiskStatusSchema.default('watchlist'),
  riskLevel: customerRiskLevelSchema.default('medium'),
  riskReasons: z.array(customerRiskReasonSchema).max(12).default([]),
  otherReason: z.string().trim().max(300).default(''),
  consultationResult: customerRiskResultSchema.default('未成交'),
  productScope: customerRiskProductScopeSchema.default('MAVIC_4_PRO_ANAMORPHIC'),
  happenedAt: z.string().trim().max(32).default(''),
  note: z.string().trim().max(2000).default('')
}).superRefine((value, context) => {
  const hasCustomerSignal = Object.values(value.customer).some((item) => String(item).trim().length > 0);
  if (!value.customerId && !hasCustomerSignal) context.addIssue({ code: z.ZodIssueCode.custom, path: ['customer'], message: '请至少填写一项客户信息' });
  if (value.riskReasons.includes('其他') && !value.otherReason) context.addIssue({ code: z.ZodIssueCode.custom, path: ['otherReason'], message: '选择其他原因时请填写说明' });
});

export const updateCustomerRiskEventSchema = z.object({
  status: customerRiskStatusSchema,
  riskLevel: customerRiskLevelSchema,
  riskReasons: z.array(customerRiskReasonSchema).max(12).default([]),
  otherReason: z.string().trim().max(300).default(''),
  consultationResult: customerRiskResultSchema,
  happenedAt: z.string().trim().max(32).default(''),
  note: z.string().trim().max(2000).default('')
}).superRefine((value, context) => {
  if (value.riskReasons.includes('其他') && !value.otherReason) context.addIssue({ code: z.ZodIssueCode.custom, path: ['otherReason'], message: '选择其他原因时请填写说明' });
});

export const updateCustomerRiskProfileSchema = z.object({
  customer: customerRiskCustomerSchema.partial().default({}),
  status: customerRiskStatusSchema.optional(),
  riskLevel: customerRiskLevelSchema.optional(),
  riskReasons: z.array(customerRiskReasonSchema).max(12).optional(),
  otherReason: z.string().trim().max(300).optional()
}).superRefine((value, context) => {
  if (value.riskReasons?.includes('其他') && !value.otherReason) context.addIssue({ code: z.ZodIssueCode.custom, path: ['otherReason'], message: '选择其他原因时请填写说明' });
});

export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(8).max(128),
  nextPassword: z.string().min(12).max(128)
});

export const passwordResetSchema = z.object({ nextPassword: z.string().min(12).max(128) });

export const updateAfterSalesSchema = z.object({
  outcome: z.enum(['approved', 'rejected']),
  resolution: z.enum(['维修', '换货', '补发配件', '退款建议', '拒绝保修', '其他处理']).optional(),
  note: z.string().trim().min(2).max(1000)
});

export const adminReviewAfterSalesSchema = z.object({
  accepted: z.boolean(),
  reasonCode: z.enum(['MISSING_INFORMATION', 'SN_UNVERIFIED', 'DUPLICATE_CASE', 'OUT_OF_SCOPE', 'PURCHASE_CONSULTATION', 'OTHER']).optional(),
  reason: z.string().trim().max(1000).default(''),
  serviceCenterId: z.string().uuid().optional().nullable(),
  requiresShipment: z.boolean().default(true),
  internalNote: z.string().trim().max(2000).default('')
}).superRefine((value, context) => {
  if (!value.accepted && !value.reason) context.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: '不受理时必须填写原因' });
  if (value.accepted && value.requiresShipment && !value.serviceCenterId) context.addIssue({ code: z.ZodIssueCode.custom, path: ['serviceCenterId'], message: '需要寄修时必须分配授权服务中心' });
});

export const inboundShipmentSchema = z.object({
  carrier: z.string().trim().min(2).max(40),
  trackingNumber: z.string().trim().min(3).max(80).regex(/^[A-Za-z0-9._\-/]+$/, '寄修单号只能包含字母、数字和常用连接符'),
  note: z.string().trim().max(500).default('')
});

export const receiptSchema = z.object({
  packagingIntact: z.boolean().default(true),
  packagingNote: z.string().trim().max(1000).default(''),
  receivedItems: z.array(z.enum(['产品主体', '安装配件', '包装盒', '保护盒', '配重模块', '其他附件', '其他'])).default([]),
  itemsMatch: z.boolean().default(true),
  missingItemsNote: z.string().trim().max(1000).default(''),
  receiptNote: z.string().trim().max(1000).default('')
});

export const inspectionSchema = z.object({
  faultReproduced: z.enum(['yes', 'no', 'uncertain']),
  reproductionStatus: z.enum(['REPRODUCED', 'INTERMITTENT', 'NOT_REPRODUCED', 'INSUFFICIENT_CONDITIONS', 'INCONSISTENT_WITH_CUSTOMER']).optional().default('REPRODUCED'),
  reproductionCondition: z.string().trim().max(1000).default(''),
  reproductionProcess: z.string().trim().max(2000).default(''),
  testResult: z.string().trim().max(2000).default(''),
  faultParts: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  damageTypes: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  derivedSymptoms: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  conclusion: z.string().trim().max(1000).default(''),
  faultCause: z.string().trim().max(1000).default(''),
  affectedParts: z.string().trim().max(500).default(''),
  suggestedAction: z.enum(['无故障', '使用指导', '重新安装', '清洁处理', '维修', '更换部件', '整机更换建议', '拒绝保修建议', '单独销售部件', '无法维修', '其他']),
  suggestedParts: z.string().trim().max(1000).default(''),
  recommendWarranty: z.boolean(),
  recommendCharge: z.boolean(),
  engineerNote: z.string().trim().max(2000).default(''),
  difficulty: z.string().trim().max(80).default(''),
  estimatedDays: z.string().trim().max(80).default(''),
  accidentalDamage: z.boolean(),
  accidentalDamageType: z.enum(['跌落或碰撞', '挤压变形', '进水或受潮', '非正常拆装', '胶水或非官方维修痕迹', '严重划伤', '部件缺失', '其他']).optional(),
  accidentalDamageNote: z.string().trim().max(2000).default(''),
  faultChains: z.array(z.object({
    faultPart: z.string().trim().min(1).max(80),
    damageType: z.string().trim().min(1).max(80),
    causeType: z.enum(['产品质量', '安装异常', '正常磨损', '外力碰撞', '跌落', '挤压', '进水或受潮', '非官方拆装', '错误使用', '包装或运输损坏', '原因不明', '其他']),
    derivedSymptoms: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
    evidence: z.string().trim().max(2000).default(''),
    relatedPhotoIds: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
    severity: z.enum(['轻微', '一般', '严重', '无法继续使用', '存在安全风险']),
    repairability: z.enum(['无需维修', '可现场处理', '可更换部件修复', '建议整体组件更换', '建议全套更换', '无法维修', '待管理员判断']),
    recommendedAction: z.enum(['无故障', '使用指导', '重新安装', '清洁处理', '维修', '更换部件', '整机更换建议', '拒绝保修建议', '单独销售部件', '无法维修', '其他']),
    engineerNote: z.string().trim().max(2000).default('')
  })).max(20).default([]),
  repairMaterials: z.array(z.object({
    materialId: z.string().trim().min(1).max(120),
    quantity: z.number().int().min(1).max(99),
    handlingMethod: z.enum(['更换', '维修', '重新粘合', '重新安装', '清洁', '调整', '利旧', '补发', '单独销售', '整体更换', '其他']),
    useNew: z.boolean().default(true),
    reuseExisting: z.boolean().default(false),
    repairOnly: z.boolean().default(false),
    recommendCharge: z.boolean().default(true),
    compatibilityOverrideReason: z.string().trim().max(500).default(''),
    engineerNote: z.string().trim().max(1000).default('')
  })).max(50).default([])
});

export const inspectionReviewSchema = z.object({
  approved: z.boolean(),
  note: z.string().trim().max(1000).default(''),
  finalDecision: z.enum(['保修内免费处理', '保外收费维修', '收费更换部件', '单独销售部件', '无故障退回', '拒绝保修', '整机更换', '其他']).optional()
}).superRefine((value, context) => {
  if (!value.approved && !value.note) context.addIssue({ code: z.ZodIssueCode.custom, path: ['note'], message: '退回补充时必须填写原因' });
  if (value.approved && !value.finalDecision) context.addIssue({ code: z.ZodIssueCode.custom, path: ['finalDecision'], message: '审核通过时必须选择最终处理方案' });
});

export const quoteSchema = z.object({
  inspectionSummary: z.string().trim().min(2).max(2000),
  finalDecision: z.enum(['保修内免费处理', '保外收费维修', '收费更换部件', '单独销售部件', '无故障退回', '拒绝保修', '整机更换', '其他']),
  currency: z.enum(['CNY']).default('CNY'),
  validUntil: isoDateSchema,
  estimatedCycle: z.string().trim().max(120).default(''),
  paymentInstructions: z.string().trim().max(1000).default(''),
  note: z.string().trim().max(1000).default(''),
  items: z.array(z.object({
    itemName: z.string().trim().min(1).max(160),
    itemType: z.enum(['维修物料', '更换组件', '服务费', '检测费', '维修费', '配件费', '人工费', '运费', '折扣', '其他']),
    quantity: z.number().int().min(1).max(999),
    unitPriceCents: z.number().int().min(-999999999).max(999999999),
    materialId: z.string().trim().max(120).optional(),
    materialCode: z.string().trim().max(80).default(''),
    serviceFeeCents: z.number().int().min(0).max(999999999).nullable().optional(),
    discountCents: z.number().int().min(0).max(999999999).default(0),
    customerNote: z.string().trim().max(500).default(''),
    note: z.string().trim().max(500).default('')
  })).min(1).max(50)
});

export const quoteDraftSchema = quoteSchema.extend({
  workflowStatus: z.enum(['DRAFT', 'READY_FOR_REVIEW']).default('READY_FOR_REVIEW')
});

export const confirmQuoteSendSchema = z.object({
  idempotencyKey: z.string().uuid()
});

export const mailTemplateKeySchema = z.enum(['system_test', 'after_sales_quote', 'service_report', 'shipment_notice', 'password_reset']);

export const mailTestSchema = z.object({
  template: mailTemplateKeySchema.default('system_test'),
  recipient: z.string().email().max(254).transform((value) => value.toLowerCase().trim()),
  idempotencyKey: z.string().uuid()
});

export const mailPreviewSchema = z.object({
  template: mailTemplateKeySchema.default('system_test')
});

export const adminDamageReviewSchema = z.object({
  inspectionId: z.string().trim().min(1).max(120),
  finalDecision: z.enum(['保修内免费处理', '保外收费维修', '收费更换部件', '单独销售部件', '无故障退回', '拒绝保修', '整机更换', '其他']),
  customerVisibleConclusion: z.string().trim().min(2).max(2000),
  internalNote: z.string().trim().max(2000).default(''),
  finalFaultChains: z.array(z.record(z.string(), z.unknown())).max(50).default([]),
  finalMaterials: z.array(z.object({
    materialId: z.string().trim().min(1).max(120).optional(),
    materialCode: z.string().trim().max(80).default(''),
    materialName: z.string().trim().min(1).max(160),
    quantity: z.number().int().min(1).max(999),
    unitPriceCents: z.number().int().min(0).max(999999999).nullable(),
    serviceFeeCents: z.number().int().min(0).max(999999999).nullable(),
    discountCents: z.number().int().min(0).max(999999999).default(0),
    customerNote: z.string().trim().max(500).default('')
  })).max(100).default([])
});

export const updateRepairMaterialSchema = z.object({
  materialName: z.string().trim().min(1).max(160),
  applicableModels: z.string().trim().max(500).default(''),
  description: z.string().trim().max(2000).default(''),
  outOfWarrantyPriceCents: z.number().int().min(0).max(999999999).nullable(),
  priceStatus: z.enum(['available', 'zero', 'not_applicable', 'missing', 'manual_confirm']),
  outOfWarrantyServiceFeeCents: z.number().int().min(0).max(999999999).nullable(),
  serviceFeeStatus: z.enum(['fixed', 'zero', 'missing', 'not_applicable', 'included', 'text_rule', 'version_rule', 'manual_confirm']),
  serviceFeeRuleJson: z.string().trim().max(2000).default('{}'),
  retailCategory: z.string().trim().max(160).default(''),
  canReplaceAsWholeSet: z.boolean().default(false),
  warrantyPolicy: z.string().trim().max(500).default(''),
  warrantyDays: z.number().int().min(0).max(3650).nullable(),
  warrantyRuleJson: z.string().trim().max(4000).default('{}'),
  active: z.boolean().default(true),
  sourceNote: z.string().trim().max(2000).default('')
});

export const assignAfterSalesSchema = z.object({
  serviceCenterId: z.string().uuid()
});

export const afterSalesAssessmentSchema = z.object({
  result: z.string().trim().min(2).max(160),
  details: z.string().trim().min(10).max(5000)
});

export const afterSalesRecommendationSchema = z.object({
  recommendation: z.string().trim().min(2).max(160),
  details: z.string().trim().min(10).max(5000)
});

const historicalValueSchema = z.union([z.string().max(10000), z.number(), z.boolean(), z.null()]);
export const historicalWarrantyRecordSchema = z.object({
  rowNumber: z.number().int().min(1).max(100000),
  values: z.record(z.string().min(1).max(40), historicalValueSchema)
});

export const historicalWarrantyPrecheckSchema = z.object({
  sourceFilename: z.string().trim().min(1).max(255).refine((value) => value.toLowerCase().endsWith('.xlsx'), '仅支持 .xlsx 文件'),
  sourceSheet: z.string().trim().min(1).max(120),
  sourceFileFingerprint: z.string().trim().regex(/^[a-f0-9]{16,128}$/i, '文件标识格式不正确'),
  headers: z.array(z.string().trim().min(1).max(40)).min(1).max(64),
  records: z.array(historicalWarrantyRecordSchema).min(1).max(10000)
});

export const confirmHistoricalWarrantyImportSchema = z.object({
  skipRowNumbers: z.array(z.number().int().min(1).max(100000)).max(10000).default([])
});

export const updateAssetWarrantySchema = z.object({
  warrantyOverrideStatus: z.enum(['no_warranty', 'denied', 'exception', 'cancelled', 'scrapped']).nullable(),
  warrantyOverrideReason: z.string().trim().max(1000).default('')
}).superRefine((value, context) => {
  if (value.warrantyOverrideStatus && !value.warrantyOverrideReason) context.addIssue({ code: z.ZodIssueCode.custom, path: ['warrantyOverrideReason'], message: '设置人工保修状态时必须填写原因' });
});

export const updateAssetSchema = z.object({
  currentSn: z.string().transform((value) => value.replace(/[\r\n\t]/g, '').trim().toUpperCase()).pipe(z.string().min(1).max(100)).optional(),
  originalSn: z.string().trim().max(100).nullable().optional(),
  productId: z.string().uuid().nullable().optional(),
  productName: z.string().trim().min(1).max(160).optional(),
  version: z.string().trim().max(80).optional(),
  assetStatus: z.enum(['active', 'in_service', 'refurbished', 'returned_to_inventory', 'resold', 'scrapped', 'unknown']).optional(),
  warrantyPolicy: z.enum(['standard', 'extended', 'none', 'unknown']).optional(),
  warrantyStartAt: isoDateSchema.nullable().optional(),
  warrantyEndAt: isoDateSchema.nullable().optional(),
  warrantyOverrideStatus: z.enum(['no_warranty', 'denied', 'exception', 'cancelled', 'scrapped']).nullable().optional(),
  warrantyOverrideReason: z.string().trim().max(1000).optional(),
  sourceChannel: z.string().trim().max(120).optional(),
  shippingWarehouse: z.string().trim().max(120).optional(),
  dealerId: z.string().uuid().nullable().optional(),
  storeId: z.string().uuid().nullable().optional(),
  latestOrderId: z.string().uuid().nullable().optional(),
  noteContent: z.string().trim().max(2000).optional()
}).superRefine((value, context) => {
  if (value.warrantyStartAt && value.warrantyEndAt && value.warrantyEndAt < value.warrantyStartAt) context.addIssue({ code: z.ZodIssueCode.custom, path: ['warrantyEndAt'], message: '保修结束日期不能早于开始日期' });
  const touchedWarrantyDate = Object.prototype.hasOwnProperty.call(value, 'warrantyStartAt') || Object.prototype.hasOwnProperty.call(value, 'warrantyEndAt');
  if ((touchedWarrantyDate || value.warrantyOverrideStatus) && !value.warrantyOverrideReason) context.addIssue({ code: z.ZodIssueCode.custom, path: ['warrantyOverrideReason'], message: '修改保修信息时必须填写原因' });
});

export const createAssetAfterSalesSchema = z.object({
  storeId: z.string().uuid(),
  caseType: z.enum(['产品异常', '安装使用', '物流问题', '配件缺失', '其他问题']),
  subject: z.string().trim().min(3).max(160),
  description: z.string().trim().min(10).max(5000)
});
