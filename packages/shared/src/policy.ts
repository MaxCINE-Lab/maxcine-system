import type { OrderStatus, Role, SessionUser } from './types.js';

export const permissions = {
  'order:create': ['dealer', 'admin'],
  'order:submit': ['dealer', 'admin'],
  'order:review': ['admin'],
  'order:fulfill': ['warehouse', 'admin'],
  'inventory:read': ['dealer', 'warehouse', 'admin'],
  'inventory:manage': ['admin'],
  'dealer:manage': ['admin'],
  'user:manage': ['admin'],
  'audit:read': ['admin'],
  'after-sales:create': ['dealer', 'admin'],
  'after-sales:read': ['dealer', 'admin']
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof permissions;

export function can(user: SessionUser, permission: Permission): boolean {
  return (permissions[permission] as readonly Role[]).includes(user.role);
}

export function canReadOrder(user: SessionUser, order: { dealerId: string; status: OrderStatus }): boolean {
  if (user.role === 'admin') return true;
  if (user.role === 'dealer') return user.dealerId === order.dealerId;
  return ['approved', 'picking', 'packed', 'shipped', 'delivered'].includes(order.status);
}

export function canTransitionOrder(role: Role, from: OrderStatus, to: OrderStatus): boolean {
  const transitions: Record<Role, Partial<Record<OrderStatus, OrderStatus[]>>> = {
    admin: { submitted: ['approved', 'rejected'], draft: ['cancelled'], approved: ['cancelled'] },
    dealer: { draft: ['submitted', 'cancelled'] },
    warehouse: { approved: ['picking'], picking: ['packed'], packed: ['shipped'] }
  };
  return transitions[role][from]?.includes(to) ?? false;
}
