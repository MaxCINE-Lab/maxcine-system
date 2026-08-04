/* eslint-disable react-refresh/only-export-components */
import { useState, type ReactNode } from 'react';
import type { Permission, Role, SessionUser } from '@maxcine/shared';

type NavItem = [label: string, href: string];
type NavGroup = { label: string; items: NavItem[] };

const roleDisplayOrder: Role[] = ['warehouse_manager', 'dealer', 'authorized_service_center', 'super_admin'];
const primaryRoleOrder: Role[] = ['super_admin', 'warehouse_manager', 'authorized_service_center', 'dealer', 'online_product_consultant'];
const roleDisplayName: Record<Role, string> = {
  super_admin: '管理员',
  warehouse_manager: '仓库',
  dealer: '经销商',
  authorized_service_center: '工程师',
  online_product_consultant: '产品顾问'
};

const employeeNumberByEmail: Readonly<Record<string, string>> = {
  'yukyinchew@maxcine.cn': '9353',
  'warehouse@maxcine.cn': '9612',
  'ziyuesun@maxcine.cn': '8043',
  'finestormray@maxcine.cn': '2056',
  'yuxiangchen@maxcine.cn': '0938',
  'ericzhu@maxcine.cn': '6583'
};

const hasAnyPermission = (user: SessionUser, permissions: Permission[]) => permissions.some((permission) => user.permissions.includes(permission));

export function displayRoleLabel(role: string): string {
  return roleDisplayName[role as Role] ?? role;
}

export function displayRoleText(user: SessionUser): string {
  const labels = roleDisplayOrder.filter((role) => user.roles.includes(role)).map((role) => roleDisplayName[role]);
  if (labels.length) return Array.from(new Set(labels)).join('，');
  if (user.roles.includes('online_product_consultant')) return roleDisplayName.online_product_consultant;
  return '员工';
}

export function primaryRoleText(user: SessionUser): string {
  const role = primaryRoleOrder.find((item) => user.roles.includes(item));
  return role ? roleDisplayName[role] : '员工';
}

export function greetingText(user: SessionUser): string {
  return `欢迎您，${user.name}`;
}

export function EmployeeWatermark({ user }: { user: SessionUser }) {
  const email = user.email.trim().toLowerCase();
  const employeeNumber = employeeNumberByEmail[email];
  if (!employeeNumber || user.watermarkEnabled === false) return null;
  const text = `${employeeNumber} · ${email}`;
  return <div className="employee-watermark" aria-hidden="true">
    {Array.from({ length: 40 }, (_, index) => <span key={index}>{text}</span>)}
  </div>;
}

export function hasAdminAccess(user: SessionUser): boolean {
  return user.roles.includes('super_admin') || hasAnyPermission(user, ['data:read:all', 'system:manage', 'user:manage', 'dealer:manage', 'order:review', 'audit:read', 'asset:manage']);
}

export function hasDealerAccess(user: SessionUser): boolean {
  return user.roles.includes('dealer') || hasAnyPermission(user, ['order:create', 'order:submit']);
}

export function hasWarehouseAccess(user: SessionUser): boolean {
  return user.roles.includes('warehouse_manager') || user.permissions.includes('order:fulfill');
}

export function hasServiceCenterAccess(user: SessionUser): boolean {
  return user.roles.includes('authorized_service_center') || hasAnyPermission(user, ['after-sales:receive', 'after-sales:damage-assess', 'after-sales:recommend']);
}

export function systemNavGroups(user: SessionUser): NavGroup[] {
  const groups: NavGroup[] = [];
  if (hasAdminAccess(user)) {
    groups.push({
      label: '管理后台',
      items: [
        ['工作台', '/system/admin'],
        ['订单管理', '/system/admin/orders'],
        ['产品与库存', '/system/admin/products'],
        ['资产与保修', '/system/admin/assets'],
        ['经销商与店铺', '/system/admin/dealers'],
        ['售后管理', '/system/admin/after-sales'],
        ['用户与权限', '/system/admin/users'],
        ['审计记录', '/system/admin/audit']
      ]
    });
  }
  if (hasDealerAccess(user)) {
    groups.push({
      label: '经销商业务',
      items: [
        ['工作台', '/system/dashboard'],
        ['新建订单', '/system/new-order'],
        ['我的订单', '/system/orders'],
        ['共享库存', '/system/inventory'],
        ['Customer Risk Center', '/system/customer-risk'],
        ['通知', '/system/notifications'],
        ['售后服务', '/system/after-sales']
      ]
    });
  }
  if (hasWarehouseAccess(user)) {
    groups.push({ label: '仓库', items: [['发货', '/system/warehouse']] });
  }
  if (hasServiceCenterAccess(user)) {
    groups.push({ label: '工程师', items: [['服务中心工单', '/system/service-center'], ['SN 查询', '/system/service-center/assets']] });
  }
  return groups;
}

export function systemNavActive(path: string, href: string): boolean {
  return path === href
    || (href === '/system/admin/assets' && path.startsWith('/system/admin/assets'))
    || (href === '/system/service-center/assets' && path.startsWith('/system/service-center/assets'))
    || (href === '/system/admin/products' && path.startsWith('/system/admin/inventory'))
    || (href === '/system/admin/dealers' && (path.startsWith('/system/admin/dealers') || path.startsWith('/system/admin/stores')))
    || (href === '/system/admin/orders' && path.startsWith('/system/admin/order/'))
    || (href === '/system/warehouse' && path.startsWith('/system/warehouse'))
    || (href === '/system/customer-risk' && path.startsWith('/system/customer-risk'))
    || (href === '/system/orders' && path.startsWith('/system/orders/'))
    || (href === '/system/after-sales' && path.startsWith('/system/after-sales/'))
    || (href === '/system/service-center' && path.startsWith('/system/service-center/cases/'));
}

export function SystemNavigation({ user, route, onNavigate }: { user: SessionUser; route: string; onNavigate: () => void }) {
  const path = route.split('?')[0];
  return <>
    {systemNavGroups(user).map((group) => <section className="nav-group" key={group.label}>
      <p className="nav-label">{group.label}</p>
      {group.items.map(([label, href]) => <a key={href} className={systemNavActive(path, href) ? 'is-active' : ''} href={`#${href}`} onClick={onNavigate}>{label}</a>)}
    </section>)}
  </>;
}

export function AccountMenu({ user, logout, children }: { user: SessionUser; logout: () => void; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const greeting = greetingText(user);
  return <div className="account-menu">
    <button className="user-chip" onClick={() => setOpen(!open)} aria-expanded={open}>
      <span className="user-avatar"><img src="/assets/maxcine-logo-on-light.png" alt="" /></span>
      <span className="user-chip-copy"><span>{greeting}</span><small>{primaryRoleText(user)}</small></span>
    </button>
    {open && <div className="account-popover">
      <strong>{greeting}</strong>
      <span>{displayRoleText(user)}</span>
      <span>{user.email}</span>
      {children}
      <button className="account-logout" onClick={logout}>退出登录</button>
    </div>}
  </div>;
}
