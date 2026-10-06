import { can, conflict, forbidden, notFound, type SessionUser } from '@maxcine/shared';
import { z } from 'zod';
import { hashIdentifier } from './auth';
import { id, one } from './db';
import { requireOrderAccess, requireRmaAccess } from './internationalAuthorization';

export const repairStartSchema=z.object({}).strict();
export const repairCompleteSchema=z.object({
  repairSummary:z.string().trim().min(1).max(1000),workPerformed:z.string().trim().min(1).max(4000),repairNotes:z.string().trim().max(4000).default(''),
  partsUsed:z.array(z.object({partName:z.string().trim().min(1).max(160),partNumber:z.string().trim().max(160).default(''),quantity:z.number().int().min(1).max(999)}).strict()).max(30).default([]),
  postRepairCheck:z.enum(['PASS','FAIL','INCONCLUSIVE'])
}).strict();
type Input=z.infer<typeof repairCompleteSchema>;
type Case={id:string;rmaReference:string;assetId:string;orderId:string;salesAccountId:string|null;market:string;warehouse:string;stage:string;
  resolution:string|null;decidedAt:string|null;inspectionId:string|null};
type Execution={id:string;rmaId:string;assetId:string;orderId:string;resolutionReference:string;resolutionDecidedAt:string;inspectionId:string;status:string;
  technicianId:string;technicianName:string;startedBy:string;startedAt:string;completedBy:string|null;completedByName:string|null;completedAt:string|null;
  repairSummary:string;workPerformed:string;repairNotes:string;partsJson:string;postRepairCheck:string|null;fingerprint:string|null;createdAt:string;updatedAt:string};
export function canExecuteRepair(user:SessionUser){return user.roles.includes('super_admin')||can(user,'international-repair:execute');}
async function scopedCase(db:D1Database,user:SessionUser,rmaId:string,write:boolean){
  if(write?!canExecuteRepair(user):!canExecuteRepair(user)&&!can(user,'international-after-sales:read'))throw forbidden('你没有该 RMA 的维修执行权限。');
  await requireRmaAccess(db,user,rmaId);
  const row=await one<Case>(db,`SELECT id,rma_reference AS rmaReference,asset_id AS assetId,order_id AS orderId,sales_account_id AS salesAccountId,
    market_region AS market,return_warehouse_id AS warehouse,service_stage AS stage,cross_border_resolution AS resolution,
    resolution_decided_at AS decidedAt,resolution_inspection_id AS inspectionId FROM after_sales_cases WHERE id=? AND return_authorized_at IS NOT NULL`,rmaId);
  if(!row)throw notFound('未找到国际 RMA。');
  await requireOrderAccess(db,user,row.orderId);
  if(row.market!=='UK'||row.warehouse!=='wh-uk')throw forbidden('该 RMA 不在允许维修的 UK 退货范围内。');
  return row;
}
async function execution(db:D1Database,rmaId:string){
  return one<Execution>(db,`SELECT e.id,e.rma_id AS rmaId,e.asset_id AS assetId,e.order_id AS orderId,e.resolution_reference AS resolutionReference,
    e.resolution_decided_at AS resolutionDecidedAt,e.inspection_id AS inspectionId,e.status,e.technician_id AS technicianId,u.name AS technicianName,
    e.started_by AS startedBy,e.started_at AS startedAt,e.completed_by AS completedBy,completer.name AS completedByName,e.completed_at AS completedAt,
    e.repair_summary AS repairSummary,e.work_performed AS workPerformed,e.repair_notes AS repairNotes,e.parts_json AS partsJson,
    e.post_repair_check AS postRepairCheck,e.submission_fingerprint AS fingerprint,e.created_at AS createdAt,e.updated_at AS updatedAt
    FROM rma_repair_executions e JOIN users u ON u.id=e.technician_id LEFT JOIN users completer ON completer.id=e.completed_by WHERE e.rma_id=?`,rmaId);
}
const eligibility=`SELECT c.id FROM after_sales_cases c JOIN rma_return_inspections i ON i.id=c.resolution_inspection_id
  JOIN assets a ON a.id=c.asset_id JOIN asset_locations l ON l.asset_id=a.id JOIN warehouse_locations area ON area.id=l.location_id
  JOIN warehouses w ON w.id=l.warehouse_id JOIN orders o ON o.id=c.order_id
  WHERE c.id=? AND c.asset_id=? AND c.order_id=? AND c.sales_account_id=? AND c.resolution_decided_at=? AND c.resolution_inspection_id=?
  AND c.status='in_progress' AND c.cross_border_resolution='REPAIR' AND c.resolution_decided_by IS NOT NULL AND length(trim(c.resolution_decision_reason))>0
  AND c.return_received_at IS NOT NULL AND c.return_shipped_at IS NOT NULL AND c.market_region='UK' AND c.return_warehouse_id='wh-uk'
  AND i.rma_id=c.id AND i.asset_id=c.asset_id AND i.order_id=c.order_id AND i.status='INSPECTION_COMPLETED'
  AND i.completed_at IS NOT NULL AND i.submission_fingerprint IS NOT NULL AND json_array_length(i.checklist_json)=8 AND json_array_length(i.evidence_snapshot_json)>0
  AND json_extract(i.findings_json,'$.issueReproduced') IN ('YES','NO','INCONCLUSIVE')
  AND json_extract(i.findings_json,'$.conditionAssessment') IN ('GOOD','COSMETIC_DAMAGE','FUNCTIONAL_DEFECT','PHYSICAL_DAMAGE','INCOMPLETE','OTHER')
  AND length(trim(json_extract(i.findings_json,'$.inspectorNotes')))>0
  AND NOT EXISTS (SELECT 1 FROM json_each(i.evidence_snapshot_json) snapshot WHERE NOT EXISTS
    (SELECT 1 FROM rma_return_inspection_evidence e WHERE e.id=snapshot.value AND e.inspection_id=i.id))
  AND EXISTS (SELECT 1 FROM asset_events e WHERE e.related_service_case_id=c.id AND e.event_type='rma_resolution_decided' AND e.source='international-rma-resolution')
  AND EXISTS (SELECT 1 FROM asset_events e WHERE e.related_service_case_id=c.id AND e.event_type='return_inspection_completed' AND e.source='international-return-inspection')
  AND a.inventory_status='QUARANTINED' AND l.custody='WAREHOUSE' AND l.status='returned' AND l.warehouse_id='wh-uk'
  AND area.warehouse_id='wh-uk' AND area.code='RETURN-QUARANTINE' AND w.status='active' AND w.market_region='UK'
  AND o.status='delivered' AND o.sales_account_id=c.sales_account_id AND o.fulfilment_warehouse_id='wh-uk'
  AND (SELECT COUNT(*) FROM international_asset_allocations al WHERE al.order_id=o.id AND al.asset_id=a.id AND al.status='fulfilled')=1
  AND NOT EXISTS (SELECT 1 FROM international_asset_allocations al WHERE al.asset_id=a.id AND al.status='reserved')
  AND NOT EXISTS (SELECT 1 FROM asset_transfers t WHERE t.asset_id=a.id AND t.status IN ('created','shipped'))`;
const parameters=(row:Case)=>[row.id,row.assetId,row.orderId,row.salesAccountId,row.decidedAt,row.inspectionId];
function guardSql(completing:boolean){return `${eligibility} AND ${completing
  ? `c.service_stage='REPAIR_IN_PROGRESS' AND EXISTS(SELECT 1 FROM rma_repair_executions e WHERE e.rma_id=c.id AND e.id=? AND e.status='REPAIR_IN_PROGRESS'
    AND e.asset_id=c.asset_id AND e.order_id=c.order_id AND e.resolution_decided_at=c.resolution_decided_at AND e.inspection_id=c.resolution_inspection_id AND e.technician_id=?)`
  : `c.service_stage='RESOLUTION_DECIDED' AND NOT EXISTS(SELECT 1 FROM rma_repair_executions e WHERE e.rma_id=c.id)`}`;}
function mayComplete(user:SessionUser,e:Execution){return canExecuteRepair(user)&&(user.roles.includes('super_admin')||e.technicianId===user.id);}
function dto(e:Execution){const {partsJson,fingerprint:_fingerprint,...record}=e;void _fingerprint;return {...record,partsUsed:JSON.parse(partsJson),
  postCheckStatus:e.postRepairCheck===null?null:e.postRepairCheck==='FAIL'?'POST_CHECK_FAILED':e.postRepairCheck==='PASS'?'POST_CHECK_PASSED':'POST_CHECK_INCONCLUSIVE',
  awaitingReinspection:e.status==='REPAIR_COMPLETED'};}
export async function repairDetail(db:D1Database,user:SessionUser,rmaId:string){
  const row=await scopedCase(db,user,rmaId,false);const e=await execution(db,rmaId);
  const eligible=e?.status==='REPAIR_IN_PROGRESS'
    ? Boolean(await one(db,guardSql(true),...parameters(row),e.id,e.technicianId))
    : !e&&Boolean(await one(db,guardSql(false),...parameters(row)));
  return {execution:e?dto(e):null,executionStatus:e?.status??'NOT_STARTED',resolutionType:row.resolution,
    canStart:!e&&eligible&&canExecuteRepair(user),canComplete:Boolean(e&&e.status==='REPAIR_IN_PROGRESS'&&eligible&&mayComplete(user,e)),
    eligibilityReason:e?.status==='REPAIR_COMPLETED'?'维修执行已锁定，等待 Reinspection / Re-Certification，设备仍不可售。'
      :eligible?'只执行已批准的 REPAIR；设备全程保持 UK 隔离。':'需要已批准的 REPAIR、正式完成的检测及 UK 隔离设备，不能跳过决策或直接完成。'};
}
function records(db:D1Database,user:SessionUser,row:Case,e:Execution|{id:string;technicianId:string;startedAt:string},now:string,requestId:string,input?:Input){
  const event=input?'repair_completed':'repair_started';
  const metadata={rma_id:row.id,rma_reference:row.rmaReference,asset_id:row.assetId,resolution_type:'REPAIR',resolution_reference:row.id,
    repair_execution_id:e.id,technician:e.technicianId,started_at:e.startedAt,...(input?{completed_at:now,post_repair_check:input.postRepairCheck}:{})};
  return [db.prepare(`INSERT INTO asset_events(id,asset_id,event_type,occurred_at,title,related_order_id,related_service_case_id,operator_user_id,visibility,source,new_value_json)
    VALUES(?,?,?,?,?,?,? ,?,'admin_private','international-rma-repair',?)`).bind(id(),row.assetId,event,now,input?'维修执行完成，设备继续隔离，等待重新检测':'已批准的维修开始执行，设备保持隔离',row.orderId,row.id,user.id,JSON.stringify(metadata)),
    db.prepare(`INSERT INTO audit_logs(id,actor_id,action,entity_type,entity_id,request_id,after_json) VALUES(?,?,?,'after_sales_case',?,?,?)`)
      .bind(id(),user.id,`international.rma.${event}`,row.id,requestId,JSON.stringify({...metadata,execution_status:input?'REPAIR_COMPLETED':'REPAIR_IN_PROGRESS',
        ...(input?{repair_summary:input.repairSummary,work_performed:input.workPerformed,parts_used:input.partsUsed,repair_notes:input.repairNotes}:{}),
        execution_authority:user.roles.includes('super_admin')?'administrator':'international-repair:execute'}))];
}
function recoverable(error:unknown){return error instanceof Error&&/malformed JSON|Repair state changed|UNIQUE constraint failed|Invalid repair|Repair execution is immutable/i.test(error.message);}
export async function startRepair(db:D1Database,user:SessionUser,rmaId:string,requestId:string){
  const row=await scopedCase(db,user,rmaId,true);const existing=await execution(db,rmaId);
  if(existing){if(existing.status==='REPAIR_IN_PROGRESS')return repairDetail(db,user,rmaId);throw conflict('维修记录已经完成，不能重新开始或覆盖。');}
  const now=new Date().toISOString();const repairId=id();
  try{await db.batch([
    db.prepare(`SELECT CASE WHEN EXISTS(${guardSql(false)}) THEN 1 ELSE json('Repair state changed') END`).bind(...parameters(row)),
    db.prepare(`INSERT INTO rma_repair_executions(id,rma_id,asset_id,order_id,resolution_reference,resolution_decided_at,inspection_id,status,technician_id,started_by,started_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'REPAIR_IN_PROGRESS',?,?,?,?,?)`).bind(repairId,row.id,row.assetId,row.orderId,row.id,row.decidedAt,row.inspectionId,user.id,user.id,now,now,now),
    db.prepare(`UPDATE after_sales_cases SET service_stage='REPAIR_IN_PROGRESS',updated_at=?,updated_by=? WHERE id=?`).bind(now,user.id,row.id),
    ...records(db,user,row,{id:repairId,technicianId:user.id,startedAt:now},now,requestId)
  ]);}catch(error){if(recoverable(error)){const current=await execution(db,rmaId);if(current?.status==='REPAIR_IN_PROGRESS')return repairDetail(db,user,rmaId);
    throw conflict('不能开始维修：需要正式批准的 REPAIR，且设备必须仍在 UK Return Quarantine。');}throw error;}
  return repairDetail(db,user,rmaId);
}
export async function completeRepair(db:D1Database,user:SessionUser,rmaId:string,input:Input,requestId:string){
  const row=await scopedCase(db,user,rmaId,true);const e=await execution(db,rmaId);
  if(!e)throw conflict('维修尚未开始，不能跳过 Start Repair 直接完成。');
  if(!mayComplete(user,e))throw forbidden('只有本次维修技师或管理员可以完成维修记录。');
  const fingerprint=await hashIdentifier(JSON.stringify(input));
  const repeated=(current:Execution)=>{if(current.status!=='REPAIR_COMPLETED')return false;
    if(current.fingerprint!==fingerprint)throw conflict('维修记录已完成且不可修改；不同提交内容不能覆盖原结果。');return true;};
  if(repeated(e))return repairDetail(db,user,rmaId);
  const now=new Date().toISOString();
  try{await db.batch([
    db.prepare(`SELECT CASE WHEN EXISTS(${guardSql(true)}) THEN 1 ELSE json('Repair state changed') END`).bind(...parameters(row),e.id,e.technicianId),
    db.prepare(`UPDATE rma_repair_executions SET status='REPAIR_COMPLETED',completed_by=?,completed_at=?,repair_summary=?,work_performed=?,repair_notes=?,parts_json=?,post_repair_check=?,submission_fingerprint=?,updated_at=? WHERE id=? AND status='REPAIR_IN_PROGRESS'`)
      .bind(user.id,now,input.repairSummary,input.workPerformed,input.repairNotes,JSON.stringify(input.partsUsed),input.postRepairCheck,fingerprint,now,e.id),
    db.prepare(`UPDATE after_sales_cases SET service_stage='REPAIR_COMPLETED',updated_at=?,updated_by=? WHERE id=?`).bind(now,user.id,row.id),
    ...records(db,user,row,e,now,requestId,input)
  ]);}catch(error){if(recoverable(error)){const current=await execution(db,rmaId);if(current&&repeated(current))return repairDetail(db,user,rmaId);
    throw conflict('维修或设备隔离状态已变化；请刷新记录，不能覆盖已完成的维修。');}throw error;}
  return repairDetail(db,user,rmaId);
}
