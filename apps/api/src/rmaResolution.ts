import { can, conflict, forbidden, notFound, type SessionUser } from '@maxcine/shared';
import { z } from 'zod';
import { id, one } from './db';
import { requireOrderAccess, requireRmaAccess } from './internationalAuthorization';
import { internalCertifiedWarranty } from './certifiedWarranty';

export const resolutions = ['REPAIR','REPLACE','REFUND','REJECT'] as const;
export const resolutionDecisionSchema = z.object({
  inspectionId:z.string().uuid(),resolutionType:z.enum(resolutions),decisionReason:z.string().trim().min(1).max(1000),decisionNotes:z.string().trim().max(4000).default('')
}).strict();
type Input=z.infer<typeof resolutionDecisionSchema>;
type ResolutionCase = { id:string;rmaReference:string;assetId:string;orderId:string;salesAccountId:string|null;market:string;warehouse:string;stage:string;status:string;
  resolutionType:string|null;decisionReason:string|null;decisionNotes:string;decidedBy:string|null;decidedByName:string|null;decidedAt:string|null;inspectionId:string|null };
const selectCase=`SELECT c.id,c.rma_reference AS rmaReference,c.asset_id AS assetId,c.order_id AS orderId,c.sales_account_id AS salesAccountId,c.market_region AS market,c.return_warehouse_id AS warehouse,
  c.service_stage AS stage,c.status,c.cross_border_resolution AS resolutionType,c.resolution_decision_reason AS decisionReason,c.resolution_decision_notes AS decisionNotes,
  c.resolution_decided_by AS decidedBy,u.name AS decidedByName,c.resolution_decided_at AS decidedAt,c.resolution_inspection_id AS inspectionId
  FROM after_sales_cases c LEFT JOIN users u ON u.id=c.resolution_decided_by WHERE c.id=? AND c.return_authorized_at IS NOT NULL`;
export function canDecideRmaResolution(user:SessionUser) {
  // Decision authority is independent of inspection, warehouse and global-read
  // permission. A non-admin global reader does not acquire decision authority.
  return user.roles.includes('super_admin') || can(user,'international-after-sales:decide');
}
async function scopedCase(db:D1Database,user:SessionUser,rmaId:string,write:boolean) {
  if(write ? !canDecideRmaResolution(user) : !canDecideRmaResolution(user)&&!can(user,'international-after-sales:read')) throw forbidden('你没有该 RMA 的售后决策权限。');
  await requireRmaAccess(db,user,rmaId);
  const row=await one<ResolutionCase>(db,selectCase,rmaId);
  if(!row)throw notFound('未找到国际 RMA。');
  await requireOrderAccess(db,user,row.orderId);
  if(row.market!=='UK'||row.warehouse!=='wh-uk')throw forbidden('该 RMA 不在允许处理的 UK 退货范围内。');
  return row;
}
const eligibilitySql=`SELECT i.id FROM after_sales_cases c JOIN rma_return_inspections i ON i.rma_id=c.id AND i.asset_id=c.asset_id AND i.order_id=c.order_id
  JOIN assets a ON a.id=c.asset_id JOIN asset_locations l ON l.asset_id=a.id JOIN warehouse_locations area ON area.id=l.location_id
  JOIN warehouses w ON w.id=c.return_warehouse_id JOIN orders o ON o.id=c.order_id
  WHERE c.id=? AND c.asset_id=? AND c.order_id=? AND c.sales_account_id=? AND i.id=?
  AND c.status='in_progress' AND c.service_stage='INSPECTION_COMPLETED' AND c.cross_border_resolution IS NULL AND c.resolution_decided_at IS NULL
  AND c.return_received_at IS NOT NULL AND c.return_shipped_at IS NOT NULL AND c.market_region='UK' AND c.return_warehouse_id='wh-uk'
  AND i.status='INSPECTION_COMPLETED' AND i.completed_at IS NOT NULL AND i.submission_fingerprint IS NOT NULL
  AND json_array_length(i.checklist_json)=8 AND json_array_length(i.evidence_snapshot_json)>0
  AND json_extract(i.findings_json,'$.issueReproduced') IN ('YES','NO','INCONCLUSIVE')
  AND json_extract(i.findings_json,'$.conditionAssessment') IN ('GOOD','COSMETIC_DAMAGE','FUNCTIONAL_DEFECT','PHYSICAL_DAMAGE','INCOMPLETE','OTHER')
  AND length(trim(json_extract(i.findings_json,'$.inspectorNotes')))>0
  AND NOT EXISTS (SELECT 1 FROM json_each(i.evidence_snapshot_json) snapshot WHERE NOT EXISTS
    (SELECT 1 FROM rma_return_inspection_evidence e WHERE e.id=snapshot.value AND e.inspection_id=i.id))
  AND EXISTS (SELECT 1 FROM rma_return_inspection_evidence e WHERE e.inspection_id=i.id AND e.category='OVERALL_CONDITION')
  AND EXISTS (SELECT 1 FROM asset_events e WHERE e.related_service_case_id=c.id AND e.event_type='return_inspection_completed' AND e.source='international-return-inspection')
  AND a.inventory_status='QUARANTINED' AND l.custody='WAREHOUSE' AND l.status='returned' AND l.warehouse_id='wh-uk'
  AND area.warehouse_id='wh-uk' AND area.code='RETURN-QUARANTINE' AND w.status='active' AND w.market_region='UK'
  AND o.status='delivered' AND o.sales_account_id=c.sales_account_id AND o.fulfilment_warehouse_id='wh-uk'
  AND (SELECT COUNT(*) FROM international_asset_allocations al WHERE al.order_id=o.id AND al.asset_id=a.id AND al.status='fulfilled')=1
  AND NOT EXISTS (SELECT 1 FROM international_asset_allocations al WHERE al.asset_id=a.id AND al.status='reserved')
  AND NOT EXISTS (SELECT 1 FROM asset_transfers t WHERE t.asset_id=a.id AND t.status IN ('created','shipped'))`;
function params(row:ResolutionCase,inspectionId:string){return [row.id,row.assetId,row.orderId,row.salesAccountId,inspectionId];}
function decisionDto(row:ResolutionCase) {
  return row.decidedAt ? {rmaId:row.id,assetId:row.assetId,inspectionId:row.inspectionId,resolutionType:row.resolutionType,decisionReason:row.decisionReason,decisionNotes:row.decisionNotes,
    decidedBy:row.decidedBy,decidedByName:row.decidedByName,decidedAt:row.decidedAt,status:'RESOLUTION_DECIDED',executionStatus:'NOT_STARTED'} : null;
}
export async function rmaResolutionDetail(db:D1Database,user:SessionUser,rmaId:string) {
  const row=await scopedCase(db,user,rmaId,false);
  const inspection=await one<{id:string}>(db,"SELECT id FROM rma_return_inspections WHERE rma_id=? AND status='INSPECTION_COMPLETED'",rmaId);
  const eligible=inspection ? Boolean(await one(db,eligibilitySql,...params(row,inspection.id))) : false;
  return {decision:decisionDto(row),inspectionId:inspection?.id??null,canDecide:canDecideRmaResolution(user)&&eligible,
    eligibilityReason:row.decidedAt?'决策已锁定，等待后续执行。':eligible?'已完成检测且设备仍处于 UK 隔离库存。':'只有正式检测完成、未决定且仍在 UK 隔离库存的 RMA 可以决定。',
    warranty:await internalCertifiedWarranty(db,row.assetId,row.orderId)};
}
export async function decideRmaResolution(db:D1Database,user:SessionUser,rmaId:string,input:Input,requestId:string) {
  const row=await scopedCase(db,user,rmaId,true);
  const repeated=(current:ResolutionCase)=>{
    if(!current.decidedAt)return false;
    if(current.resolutionType!==input.resolutionType||current.decisionReason!==input.decisionReason||current.decisionNotes!==input.decisionNotes||current.inspectionId!==input.inspectionId)
      throw conflict('该 RMA 已有最终决策，不能更改或覆盖；本轮不支持决策修订。');
    return true;
  };
  if(repeated(row))return rmaResolutionDetail(db,user,rmaId);
  const now=new Date().toISOString();
  const metadata={rma_id:row.id,rma_reference:row.rmaReference,asset_id:row.assetId,resolution_type:input.resolutionType,inspection_id:input.inspectionId,decided_by:user.id,decided_at:now,execution_status:'NOT_STARTED'};
  try {
    await db.batch([
      db.prepare(`SELECT CASE WHEN EXISTS (${eligibilitySql}) THEN 1 ELSE json('Resolution state changed') END`).bind(...params(row,input.inspectionId)),
      db.prepare(`UPDATE after_sales_cases SET service_stage='RESOLUTION_DECIDED',cross_border_resolution=?,resolution_decision_reason=?,resolution_decision_notes=?,resolution_decided_by=?,
        resolution_decided_at=?,resolution_inspection_id=?,updated_at=?,updated_by=? WHERE id=? AND resolution_decided_at IS NULL`)
        .bind(input.resolutionType,input.decisionReason,input.decisionNotes,user.id,now,input.inspectionId,now,user.id,row.id),
      db.prepare(`INSERT INTO asset_events (id,asset_id,event_type,occurred_at,title,related_order_id,related_service_case_id,operator_user_id,visibility,source,new_value_json)
        VALUES (?,?,'rma_resolution_decided',?,'售后处理决策已确认，等待执行',?,?,?,'admin_private','international-rma-resolution',?)`)
        .bind(id(),row.assetId,now,row.orderId,row.id,user.id,JSON.stringify(metadata)),
      db.prepare(`INSERT INTO audit_logs (id,actor_id,action,entity_type,entity_id,request_id,after_json)
        VALUES (?,?,'international.rma.resolution_decided','after_sales_case',?,?,?)`)
        .bind(id(),user.id,row.id,requestId,JSON.stringify({...metadata,decision_reason:input.decisionReason,decision_notes:input.decisionNotes,
          decision_authority:user.roles.includes('super_admin')?'administrator':'international-after-sales:decide'}))
    ]);
  }catch(error){
    if(error instanceof Error && /malformed JSON|Resolution state changed|UNIQUE constraint failed|Invalid RMA resolution decision|immutable/i.test(error.message)){
      const latest=await scopedCase(db,user,rmaId,true);if(repeated(latest))return rmaResolutionDetail(db,user,rmaId);
      throw conflict('不能跳过正式检测，或 RMA / 设备隔离状态已变化；请刷新报告后重试。');
    }
    // Unknown transport failures must not claim success. Retrying can safely
    // recover a committed decision through the exact-content idempotency check.
    throw error;
  }
  return rmaResolutionDetail(db,user,rmaId);
}
