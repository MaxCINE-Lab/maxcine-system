import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().email().max(254).transform((value) => value.toLowerCase().trim()),
  password: z.string().min(8).max(128)
});

export const createOrderSchema = z.object({
  storeId: z.string().uuid(),
  items: z.array(z.object({ productId: z.string().uuid(), quantity: z.number().int().min(1).max(999) })).min(1).max(100),
  note: z.string().trim().max(500).default('')
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

export const shipmentSchema = z.object({
  carrier: z.enum(['顺丰速运']).default('顺丰速运'),
  trackingNumber: z.string().trim().min(6).max(80).regex(/^[A-Za-z0-9._\-/]+$/, '运单号只能包含字母、数字和常用连接符')
});

export const createAfterSalesSchema = z.object({
  storeId: z.string().uuid(),
  orderId: z.string().uuid().optional().nullable(),
  productId: z.string().uuid().optional().nullable(),
  serialNumber: z.string().trim().max(100).optional().nullable(),
  caseType: z.enum(['产品异常', '安装使用', '物流问题', '配件缺失', '其他问题']),
  subject: z.string().trim().min(3).max(160),
  description: z.string().trim().min(10).max(5000),
  // Contact fields are optional so local demo flows never require personal data.
  contactName: z.string().trim().min(2).max(80).optional().nullable(),
  contactPhone: z.string().trim().min(6).max(32).optional().nullable()
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
  dealerIds: z.array(z.string().uuid()).max(20).default([]),
  serviceCenterIds: z.array(z.string().uuid()).max(20).default([]),
  storeIds: z.array(z.string().uuid()).max(100).default([]),
  isActive: z.boolean()
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
