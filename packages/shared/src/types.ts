export const ROLES = ['super_admin', 'warehouse_manager', 'dealer', 'authorized_service_center', 'online_product_consultant'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'data:read:all', 'system:manage', 'user:manage', 'dealer:manage', 'service-center:manage', 'store:manage',
  'catalog:read', 'knowledge:read', 'consultation:reply', 'order:read', 'order:create', 'order:submit',
  'order:review', 'order:warehouse-read', 'order:fulfill', 'inventory:read', 'inventory:manage',
  'inventory:warehouse-manage', 'audit:read', 'notifications:read', 'after-sales:create', 'after-sales:read',
  'after-sales:assign', 'after-sales:receive', 'after-sales:damage-assess', 'after-sales:recommend', 'after-sales:approve'
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ORDER_STATUSES = [
  'draft', 'submitted', 'approved', 'rejected', 'picking', 'packed', 'shipped', 'delivered', 'cancelled'
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  dealerId: string | null;
  roles: Role[];
  permissions: Permission[];
  dealerIds: string[];
  serviceCenterIds: string[];
  storeIds: string[];
  sessionVersion: number;
};

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: Record<string, string[]>;
  };
};

export type OrderLineInput = {
  productId: string;
  quantity: number;
};
