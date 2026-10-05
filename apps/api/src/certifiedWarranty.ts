import { one } from './db';

export const certifiedWarrantyPolicy = {
  code: 'MAXCINE_CERTIFIED_STANDARD_12M',
  name: 'MaxCINE Certified Warranty',
  durationMonths: 12,
  description: '12 个月 MaxCINE Certified 商业保修'
} as const;

// Preserve the delivered timestamp and clamp leap-day/month-end anniversaries.
// The entitlement interval is [start, end); legacy date-only warranties retain
// their existing inclusive-date behavior elsewhere.
export function certifiedWarrantyEnd(start: string): string {
  const value = new Date(start);
  if (!Number.isFinite(value.getTime())) throw new Error('Invalid delivery timestamp');
  const end = new Date(value);
  const day = value.getUTCDate();
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() + certifiedWarrantyPolicy.durationMonths);
  const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  end.setUTCDate(Math.min(day, lastDay));
  return end.toISOString();
}

export type WarrantyEligibility = 'activated' | 'not_certified' | 'invalid_certification' | 'existing_warranty' | 'warranty_restricted';
// Used both by preflight and the transactional guard. Exactly one timestamp
// parameter is required, followed by the caller's own WHERE parameters.
export const certifiedEligibilitySql = `CASE
  WHEN asset.warranty_source_order_id IS NOT NULL THEN 'existing_warranty'
  WHEN asset.warranty_override_status IS NOT NULL THEN 'warranty_restricted'
  WHEN cert.id IS NULL THEN 'not_certified'
  WHEN cert.certification_status <> 'certified' OR cert.final_qc <> 1 OR cert.grade = 'D'
    OR cert.inspection_result NOT IN ('PASS','ADVISORY')
    OR julianday(cert.certification_date) IS NULL OR julianday(cert.certification_date) > julianday(?)
    THEN 'invalid_certification'
  ELSE 'activated' END`;

const reasons: Record<string, string> = {
  not_certified: '设备没有 MaxCINE Certification。',
  invalid_certification: '设备在送达时没有符合条件的有效 Certification。',
  existing_warranty: '设备已有关联其他销售的内部保修，未覆盖原记录。',
  warranty_restricted: '设备存在人工保修限制，未自动覆盖。'
};

export async function internalCertifiedWarranty(db: D1Database, assetId: string, sourceOrderId?: string) {
  const row = await one<{
    policyCode: string | null; sourceOrderId: string | null; marketRegion: string | null;
    start: string | null; end: string | null; activationSource: string | null; activatedAt: string | null;
    overrideStatus: string | null;
  }>(db, `SELECT certified_warranty_policy_code AS policyCode, warranty_source_order_id AS sourceOrderId,
    warranty_market_region AS marketRegion, warranty_start_at AS start, warranty_end_at AS end,
    warranty_activation_source AS activationSource, warranty_activated_at AS activatedAt,
    warranty_override_status AS overrideStatus FROM assets WHERE id = ?`, assetId);
  if (row?.policyCode && (!sourceOrderId || row.sourceOrderId === sourceOrderId)) {
    const now = Date.now();
    const status = row.overrideStatus ? 'restricted' : now < Date.parse(row.start ?? '') ? 'pending'
      : now >= Date.parse(row.end ?? '') ? 'expired' : 'active';
    return { ...row, status, reason: row.overrideStatus ? '内部保修存在人工限制。' : '', policyName: certifiedWarrantyPolicy.name };
  }
  const order = sourceOrderId ? await one<{ eligibility: string | null }>(db,
    'SELECT certified_warranty_eligibility AS eligibility FROM orders WHERE id = ?', sourceOrderId) : null;
  return { status: 'not_activated', reason: reasons[order?.eligibility ?? ''] ?? '未激活内部 Certified Warranty；旧送达记录可重试确认以补齐资格评估。',
    policyCode: null, sourceOrderId: sourceOrderId ?? null, marketRegion: null, start: null, end: null, activationSource: null, activatedAt: null, policyName: certifiedWarrantyPolicy.name };
}
