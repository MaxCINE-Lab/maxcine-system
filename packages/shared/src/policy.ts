import type { OrderStatus, Permission, SessionUser } from './types.js';

export function can(user: SessionUser, permission: Permission): boolean {
  return user.permissions.includes(permission);
}

export function canReadOrder(user: SessionUser, order: { storeId: string; status: OrderStatus }): boolean {
  if (can(user, 'data:read:all')) return true;
  if (can(user, 'order:warehouse-read')) return ['approved', 'picking', 'packed', 'shipped', 'delivered'].includes(order.status);
  return can(user, 'order:read') && user.storeIds.includes(order.storeId);
}

export function canAccessStore(user: SessionUser, storeId: string): boolean {
  return can(user, 'data:read:all') || user.storeIds.includes(storeId);
}

export function canTransitionOrder(user: SessionUser, from: OrderStatus, to: OrderStatus): boolean {
  if (to === 'submitted') return from === 'draft' && can(user, 'order:submit');
  if (to === 'approved' || to === 'rejected') return from === 'submitted' && can(user, 'order:review');
  if (to === 'picking') return from === 'approved' && can(user, 'order:fulfill');
  if (to === 'packed') return from === 'picking' && can(user, 'order:fulfill');
  if (to === 'shipped') return from === 'packed' && can(user, 'order:fulfill');
  if (to === 'cancelled') return (from === 'draft' || from === 'approved') && can(user, 'order:review');
  return false;
}
