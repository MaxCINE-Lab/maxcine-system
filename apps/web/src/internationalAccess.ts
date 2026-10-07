import type { Permission, SessionUser } from '@maxcine/shared';

// Navigation visibility only; the API remains the authority for every action.
const internationalPermissions: Permission[] = ['marketplace:manage', 'transfer:manage', 'international-after-sales:decide', 'international-repair:execute',
  'post-repair:read', 'post-repair:inspect', 'post-repair:decide', 'international-customer-return:release',
  'international-rma-replace:execute'];

export function hasInternationalAccess(user: SessionUser): boolean {
  return user.roles.includes('international_operator') || internationalPermissions.some((permission) => user.permissions.includes(permission));
}
