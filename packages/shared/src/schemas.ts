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
  note: z.string().max(1000).optional()
});

export const scanSerialSchema = z.object({
  productId: z.string().uuid(),
  serialNumber: z.string().trim().min(3).max(100).regex(/^[A-Za-z0-9._\-/]+$/, 'SN contains unsupported characters')
});

export const shipmentSchema = z.object({
  trackingNumber: z.string().trim().min(6).max(80).regex(/^[A-Za-z0-9._\-/]+$/, 'Tracking number contains unsupported characters')
});

export const createAfterSalesSchema = z.object({
  storeId: z.string().uuid(),
  orderId: z.string().uuid().optional().nullable(),
  productId: z.string().uuid().optional().nullable(),
  serialNumber: z.string().trim().max(100).optional().nullable(),
  caseType: z.enum(['产品异常', '安装使用', '物流问题', '配件缺失', '其他问题']),
  subject: z.string().trim().min(3).max(160),
  description: z.string().trim().min(10).max(5000),
  contactName: z.string().trim().min(2).max(80),
  contactPhone: z.string().trim().min(6).max(32)
});

export const createProductSchema = z.object({
  sku: z.string().trim().min(2).max(64).regex(/^[A-Z0-9._-]+$/, 'SKU must use uppercase letters, numbers, dot, underscore or hyphen'),
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().max(2000).default(''),
  unitPriceCents: z.number().int().min(0).max(999999999)
});

export const adjustInventorySchema = z.object({
  quantityDelta: z.number().int().min(-999999).max(999999).refine((value) => value !== 0, 'Adjustment cannot be zero'),
  note: z.string().trim().min(3).max(500)
});

export const createDealerSchema = z.object({
  code: z.string().trim().min(2).max(32).regex(/^[A-Z0-9-]+$/, 'Dealer code must use uppercase letters, numbers or hyphens'),
  name: z.string().trim().min(2).max(160)
});

export const createStoreSchema = z.object({
  dealerId: z.string().uuid(),
  code: z.string().trim().min(2).max(32).regex(/^[A-Z0-9-]+$/, 'Store code must use uppercase letters, numbers or hyphens'),
  name: z.string().trim().min(2).max(160)
});

export const createUserSchema = z.object({
  email: z.string().email().max(254).transform((value) => value.toLowerCase().trim()),
  name: z.string().trim().min(2).max(120),
  password: z.string().min(12).max(128),
  role: z.enum(['admin', 'dealer', 'warehouse']),
  dealerId: z.string().uuid().nullable().optional()
}).superRefine((value, ctx) => {
  if (value.role === 'dealer' && !value.dealerId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dealerId'], message: 'Dealer users require a dealer relationship' });
  if (value.role !== 'dealer' && value.dealerId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dealerId'], message: 'Only dealer users may be assigned to a dealer' });
});

export const updateAfterSalesSchema = z.object({
  status: z.enum(['open', 'in_progress', 'resolved', 'closed']),
  note: z.string().trim().max(1000).optional()
});
