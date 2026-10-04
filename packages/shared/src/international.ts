import { forbidden } from './errors.js';
import { can } from './policy.js';
import type { SessionUser } from './types.js';

export type InternationalAssetAccess = {
  warehouseId?: string | null;
  salesAccountId?: string | null;
};

export type InternationalOrderAccess = {
  salesAccountId: string | null;
  fulfilmentWarehouseId: string | null;
};

export type InternationalRmaAccess = InternationalOrderAccess & {
  assetWarehouseId: string | null;
  returnWarehouseId: string | null;
  marketRegion: string | null;
  scopedWarehouseRegions?: string[];
};

export function hasGlobalInternationalAccess(user: SessionUser): boolean {
  return can(user, 'data:read:all');
}

export function workspaceScopeIds(user: SessionUser, key: string): string[] {
  return Array.from(new Set((user.workspaces ?? []).flatMap((workspace) => {
    const value = workspace.dataScope[key];
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
  })));
}

export function requireWorkspace(user: SessionUser, ...workspaceCodes: string[]): void {
  if (hasGlobalInternationalAccess(user)) return;
  const assigned = new Set((user.workspaces ?? []).map((workspace) => workspace.code));
  if (!workspaceCodes.some((code) => assigned.has(code))) throw forbidden('当前账户没有对应 Workspace 权限');
}

export function requireWarehouseScope(user: SessionUser, warehouseId: string | null | undefined): void {
  if (hasGlobalInternationalAccess(user)) return;
  if (!warehouseId || !workspaceScopeIds(user, 'warehouseIds').includes(warehouseId)) throw forbidden('该仓库不在你的数据范围内');
}

export function requireSalesAccountScope(user: SessionUser, salesAccountId: string | null | undefined): void {
  if (hasGlobalInternationalAccess(user)) return;
  if (!salesAccountId || !workspaceScopeIds(user, 'salesAccountIds').includes(salesAccountId)) throw forbidden('该销售账号不在你的数据范围内');
}

export function requireAssetAccess(user: SessionUser, asset: InternationalAssetAccess): void {
  if (hasGlobalInternationalAccess(user)) return;
  const warehouseAllowed = Boolean(asset.warehouseId && workspaceScopeIds(user, 'warehouseIds').includes(asset.warehouseId));
  const salesAccountAllowed = Boolean(asset.salesAccountId && workspaceScopeIds(user, 'salesAccountIds').includes(asset.salesAccountId));
  if (!warehouseAllowed && !salesAccountAllowed) throw forbidden('该资产不在你的数据范围内');
}

export function requireInspectionAssignment(user: SessionUser, assignedTo: string | null | undefined): void {
  if (hasGlobalInternationalAccess(user) || user.roles.includes('international_operator')) return;
  if (!assignedTo || assignedTo !== user.id) throw forbidden('只能操作分配给自己的检测任务');
}

export function requireOrderAccess(user: SessionUser, order: InternationalOrderAccess): void {
  if (hasGlobalInternationalAccess(user)) return;
  requireSalesAccountScope(user, order.salesAccountId);
  requireWarehouseScope(user, order.fulfilmentWarehouseId);
}

export function requireRmaAccess(user: SessionUser, rma: InternationalRmaAccess): void {
  if (hasGlobalInternationalAccess(user)) return;
  requireSalesAccountScope(user, rma.salesAccountId);
  requireWarehouseScope(user, rma.returnWarehouseId);
  requireWarehouseScope(user, rma.assetWarehouseId ?? rma.fulfilmentWarehouseId);
  const explicitRegions = workspaceScopeIds(user, 'marketRegions');
  const inferredRegions = rma.scopedWarehouseRegions ?? [];
  if (rma.marketRegion && !explicitRegions.includes(rma.marketRegion) && !inferredRegions.includes(rma.marketRegion)) {
    throw forbidden('该市场区域不在你的数据范围内');
  }
}

export function assetCodeProductSegment(value: string): string {
  const compact = value.toUpperCase().replace(/[^A-Z0-9]+/g, '');
  return compact.slice(0, 8) || 'ASSET';
}

export function generateAssetCode(input: { assetId: string; productCode?: string | null; createdAt?: Date; prefix?: string }): string {
  const prefix = assetCodeProductSegment(input.prefix ?? 'MC').slice(0, 4);
  const year = String((input.createdAt ?? new Date()).getUTCFullYear()).slice(-2);
  const product = assetCodeProductSegment(input.productCode ?? 'ASSET');
  const identity = input.assetId.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const suffix = identity.slice(-12).padStart(12, '0');
  return `${prefix}-${year}-${product}-${suffix}`;
}
