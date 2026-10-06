export const ROLES = ['super_admin', 'warehouse_manager', 'dealer', 'authorized_service_center', 'online_product_consultant', 'certified_operator', 'international_operator', 'uk_fulfilment_operator', 'international_resolution_manager'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'data:read:all', 'system:manage', 'user:manage', 'dealer:manage', 'service-center:manage', 'store:manage',
  'catalog:read', 'knowledge:read', 'consultation:reply', 'order:read', 'order:create', 'order:submit',
  'order:review', 'order:warehouse-read', 'order:fulfill', 'inventory:read', 'inventory:manage',
  'inventory:warehouse-manage', 'audit:read', 'notifications:read', 'after-sales:create', 'after-sales:read',
  'after-sales:assign', 'after-sales:receive', 'after-sales:damage-assess', 'after-sales:recommend', 'after-sales:approve',
  'asset:read', 'asset:manage', 'asset:import', 'asset:warehouse-read',
  'customer-risk:read', 'customer-risk:create', 'customer-risk:update-own', 'customer-risk:manage'
  , 'workspace:read', 'certified:read', 'certified:manage', 'certified:final-qc', 'warehouse:international-read', 'transfer:manage',
  'marketplace:read', 'marketplace:manage', 'international-order:read', 'international-order:manage', 'international-order:deliver',
  'international-after-sales:read', 'international-after-sales:manage', 'international-after-sales:decide', 'international-return:receive', 'international-return:inspect'
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
  mustChangePassword: boolean;
  watermarkEnabled: boolean;
  workspaces?: WorkspaceContext[];
};

export type WorkspaceContext = {
  code: string;
  name: string;
  defaultRoute: string;
  dataScope: Record<string, unknown>;
  isDefault: boolean;
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
