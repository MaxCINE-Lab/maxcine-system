export const ROLES = ['admin', 'dealer', 'warehouse'] as const;
export type Role = (typeof ROLES)[number];

export const ORDER_STATUSES = [
  'draft', 'submitted', 'approved', 'rejected', 'picking', 'packed', 'shipped', 'delivered', 'cancelled'
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export type SessionUser = {
  id: string;
  email: string;
  role: Role;
  dealerId: string | null;
  name: string;
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
