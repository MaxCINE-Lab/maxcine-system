import { conflict } from '@maxcine/shared';
import { one } from './db';
import { certifiedWarrantyPolicy } from './certifiedWarranty';

const entitlementType = 'maxcine_certified_standard_12m';
const displayName = 'MaxCINE Certified 12-Month Limited Warranty';
const canonicalWhere = `a.certified_warranty_policy_code = '${certifiedWarrantyPolicy.code}'
  AND a.warranty_source_order_id IS NOT NULL AND a.warranty_start_at IS NOT NULL AND a.warranty_end_at IS NOT NULL
  AND EXISTS (SELECT 1 FROM orders o JOIN international_asset_allocations al ON al.order_id = o.id
    WHERE o.id = a.warranty_source_order_id AND o.status = 'delivered' AND o.delivered_at = a.warranty_start_at
      AND al.asset_id = a.id AND al.status = 'fulfilled')`;
const certificationWhere = `cert.certification_status = 'certified' AND cert.final_qc = 1 AND cert.grade <> 'D'
  AND cert.inspection_result IN ('PASS','ADVISORY') AND julianday(cert.certification_date) <= julianday(a.warranty_start_at)`;

// Statements deliberately read canonical fields inside the caller's D1 batch,
// after internal activation. Stable keys and conditional upserts make retries
// no-ops, while preserving unrelated legacy entitlements and visibility choices.
export function publicWarrantyProjectionStatements(db: D1Database, assetId: string): D1PreparedStatement[] {
  return [
    db.prepare(`INSERT INTO asset_public_warranties (id, asset_id, serial_number_snapshot, product_name_snapshot, product_version_snapshot,
      public_warranty_start_date, public_warranty_end_date, public_warranty_status, projection_policy_code, projection_source_order_id)
      SELECT 'certified-public:' || a.id, a.id, COALESCE(NULLIF(a.current_sn,''), a.original_sn, ''), a.product_name_snapshot, a.version_snapshot,
        a.warranty_start_at, a.warranty_end_at, 'auto', a.certified_warranty_policy_code, a.warranty_source_order_id
      FROM assets a WHERE a.id = ? AND ${canonicalWhere}
      ON CONFLICT(asset_id) DO UPDATE SET serial_number_snapshot = excluded.serial_number_snapshot,
        product_name_snapshot = excluded.product_name_snapshot, product_version_snapshot = excluded.product_version_snapshot,
        public_warranty_start_date = excluded.public_warranty_start_date, public_warranty_end_date = excluded.public_warranty_end_date,
        is_public_query_enabled = CASE WHEN asset_public_warranties.public_warranty_status IN ('hidden','blocked')
          THEN 0 ELSE asset_public_warranties.is_public_query_enabled END,
        public_warranty_status = 'auto', projection_policy_code = excluded.projection_policy_code,
        projection_source_order_id = excluded.projection_source_order_id, updated_at = CURRENT_TIMESTAMP
      WHERE asset_public_warranties.projection_policy_code IS NOT excluded.projection_policy_code
        OR asset_public_warranties.projection_source_order_id IS NOT excluded.projection_source_order_id
        OR asset_public_warranties.serial_number_snapshot IS NOT excluded.serial_number_snapshot
        OR asset_public_warranties.product_name_snapshot IS NOT excluded.product_name_snapshot
        OR asset_public_warranties.product_version_snapshot IS NOT excluded.product_version_snapshot
        OR asset_public_warranties.public_warranty_start_date IS NOT excluded.public_warranty_start_date
        OR asset_public_warranties.public_warranty_end_date IS NOT excluded.public_warranty_end_date
        OR asset_public_warranties.public_warranty_status <> 'auto'`).bind(assetId),
    db.prepare(`INSERT INTO asset_public_warranty_entitlements (id, public_warranty_id, entitlement_type, display_name, date_mode)
      SELECT 'certified-entitlement:' || p.asset_id, p.id, ?, ?, 'inherit' FROM asset_public_warranties p
      JOIN assets a ON a.id = p.asset_id WHERE a.id = ? AND ${canonicalWhere}
        AND p.projection_policy_code = a.certified_warranty_policy_code AND p.projection_source_order_id = a.warranty_source_order_id
      ON CONFLICT(public_warranty_id, entitlement_type) DO UPDATE SET display_name = excluded.display_name,
        is_enabled = 1, is_public = 1, date_mode = 'inherit', start_date = NULL, end_date = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE asset_public_warranty_entitlements.display_name <> excluded.display_name
        OR asset_public_warranty_entitlements.is_enabled <> 1 OR asset_public_warranty_entitlements.is_public <> 1
        OR asset_public_warranty_entitlements.date_mode <> 'inherit'
        OR asset_public_warranty_entitlements.start_date IS NOT NULL OR asset_public_warranty_entitlements.end_date IS NOT NULL`)
      .bind(entitlementType, displayName, assetId)
  ];
}

export async function syncPublicWarrantyProjection(db: D1Database, assetId: string, orderId: string) {
  try {
    await db.batch([
      db.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM assets a WHERE a.id = ? AND a.warranty_source_order_id = ?
        AND ${canonicalWhere}) THEN 1 ELSE json('invalid canonical warranty') END`).bind(assetId, orderId),
      ...publicWarrantyProjectionStatements(db, assetId)
    ]);
  } catch (error) {
    if (error instanceof Error && /malformed JSON|invalid canonical warranty/i.test(error.message)) throw conflict('没有可同步的有效内部 Certified Warranty。');
    throw error;
  }
}

export async function publicWarrantyProjectionState(db: D1Database, assetId: string, orderId: string) {
  const row = await one<{ synced: number }>(db, `SELECT 1 AS synced FROM asset_public_warranties p JOIN assets a ON a.id = p.asset_id
    WHERE a.id = ? AND a.warranty_source_order_id = ? AND p.projection_policy_code = a.certified_warranty_policy_code
      AND p.projection_source_order_id = a.warranty_source_order_id AND p.public_warranty_start_date = a.warranty_start_at
      AND p.public_warranty_end_date = a.warranty_end_at
      AND EXISTS (SELECT 1 FROM asset_public_warranty_entitlements e WHERE e.public_warranty_id = p.id
        AND e.entitlement_type = ? AND e.is_enabled = 1 AND e.is_public = 1)`, assetId, orderId, entitlementType);
  return { synced: Boolean(row) };
}

// Consumer DTO: an explicit whitelist. Never spread an internal row or return
// order references, original identifiers, notes, prices, buyer or warehouse data.
export async function certifiedPublicWarrantyDto(db: D1Database, assetId: string, locale: string, now = new Date()) {
  const row = await one<{ assetCode: string; serialNumber: string; productName: string; productVersion: string;
    start: string; end: string; override: string | null; market: string; certificationStatus: string; grade: string }>(db,
    `SELECT a.asset_code AS assetCode, COALESCE(NULLIF(a.current_sn,''), a.original_sn, '') AS serialNumber,
      a.product_name_snapshot AS productName, a.version_snapshot AS productVersion,
      a.warranty_start_at AS start, a.warranty_end_at AS end, a.warranty_override_status AS override,
      a.warranty_market_region AS market, cert.certification_status AS certificationStatus, cert.grade
      FROM assets a JOIN asset_public_warranties p ON p.asset_id = a.id JOIN asset_certifications cert ON cert.asset_id = a.id
      WHERE a.id = ? AND ${canonicalWhere} AND ${certificationWhere}
        AND p.projection_policy_code = a.certified_warranty_policy_code AND p.projection_source_order_id = a.warranty_source_order_id
        AND p.is_public_query_enabled = 1`, assetId);
  // Revoked/suspended/invalid Certification must never be advertised as Certified.
  // Withhold this public record; do not silently mutate the canonical warranty.
  if (!row) return null;
  const statusCode = row.override ? row.override === 'exception' ? 'SUSPENDED' : 'VOID'
    : now.getTime() < Date.parse(row.start) ? 'PENDING' : now.getTime() >= Date.parse(row.end) ? 'EXPIRED' : 'ACTIVE';
  const warrantyStatus = ({ ACTIVE: '保修中', EXPIRED: '已过保', PENDING: '待生效', VOID: '无保修', SUSPENDED: '待确认' })[statusCode];
  const name = locale === 'en' ? displayName : 'MaxCINE Certified 12个月有限保修';
  const startDate = row.start.slice(0, 10); const endDate = row.end.slice(0, 10);
  return {
    serialNumber: row.serialNumber ? `***${row.serialNumber.slice(-Math.min(4, Math.max(1, Math.floor(row.serialNumber.length / 2))))}` : '—', assetCode: row.assetCode,
    productName: row.productName, productVersion: row.productVersion, warrantyStatus, warrantyStatusCode: statusCode,
    warrantyPolicyName: name, warrantyStartDate: startDate, warrantyEndDate: endDate, marketRegion: row.market,
    certificationStatus: row.certificationStatus, grade: row.grade, purchaseDate: null, publicNote: '',
    publicEntitlements: [{ type: entitlementType, name, startDate, endDate, status: warrantyStatus, marketRegion: row.market }]
  };
}
