import { badRequest,can,conflict,forbidden,notFound,requireInspectionAssignment,requireWorkspace,type SessionUser } from '@maxcine/shared';
import { z } from 'zod';
import { all,id,one } from './db';
import { hashIdentifier } from './auth';
import { requireAssetAccess,requireOrderAccess,requireRmaAccess } from './internationalAuthorization';
import { certifiedGrades,legacyCertifiedGrade } from './certifiedInspectionPrimitives';
import { validatedInspectionPhoto } from './rmaInspection';

export const postRepairItems=['IDENTITY','EXTERIOR','DISPLAY','LENS_CAMERA','POWER','FUNCTIONAL','REPAIRED_FUNCTION','ACCESSORIES','FINAL_QC'] as const;
const categories=['OVERALL_CONDITION','REPAIRED_AREA','ACCESSORIES','OTHER'] as const;
export const postRepairStartSchema=z.object({assetCode:z.string().trim().min(1).max(100)}).strict();
export const postRepairDraftSchema=postRepairStartSchema.extend({
  observedSn:z.string().trim().max(160).default(''),snVerification:z.enum(['MATCH','MISMATCH','NOT_TESTED']),
  grade:z.enum(certifiedGrades).nullable(),
  checklist:z.array(z.object({item:z.enum(postRepairItems),result:z.enum(['PASS','FAIL','NOT_APPLICABLE','NOT_TESTED']),notes:z.string().trim().max(1000).default('')}).strict()).length(9),
  findings:z.object({issueRemains:z.enum(['YES','NO','INCONCLUSIVE']),functionalCondition:z.enum(['GOOD','DEFECTIVE','INCONCLUSIVE']),inspectorNotes:z.string().trim().max(4000)}).strict()
}).strict();
export const postRepairCompleteSchema=postRepairDraftSchema.extend({grade:z.enum(certifiedGrades),findings:postRepairDraftSchema.shape.findings.extend({inspectorNotes:z.string().trim().min(1).max(4000)})});
export const recertificationDecisionSchema=z.object({inspectionId:z.string().uuid(),decision:z.enum(['APPROVED','REJECTED']),reason:z.string().trim().min(1).max(1000),notes:z.string().trim().max(4000).default('')}).strict();
type Draft=z.infer<typeof postRepairDraftSchema>;
type Complete=z.infer<typeof postRepairCompleteSchema>;
type DecisionInput=z.infer<typeof recertificationDecisionSchema>;
type Case={id:string;assetId:string;orderId:string;account:string|null;assetCode:string;expectedSn:string;repairId:string|null;repairStatus:string|null};
type Inspection={id:string;rmaId:string;assetId:string;repairId:string;taskId:string;status:string;assetCode:string;expectedSn:string;observedSn:string;snVerification:string;
  grade:typeof certifiedGrades[number]|null;checklistJson:string;findingsJson:string;evidenceJson:string;completedAt:string|null;fingerprint:string|null;inspectorId:string;inspectorName:string;startedAt:string};
type Decision={id:string;inspectionId:string;rmaId:string;assetId:string;decision:string;reason:string;notes:string;decidedBy:string;decidedByName:string;decidedAt:string;certificationId:string|null;fingerprint:string};
const inspectionSelect=`SELECT i.id,i.rma_id AS rmaId,i.asset_id AS assetId,i.repair_execution_id AS repairId,i.inspection_task_id AS taskId,i.status,
 i.matched_asset_code AS assetCode,i.expected_sn AS expectedSn,i.observed_sn AS observedSn,i.sn_verification AS snVerification,i.grade,
 i.checklist_json AS checklistJson,i.findings_json AS findingsJson,i.evidence_snapshot_json AS evidenceJson,i.completed_at AS completedAt,i.completion_fingerprint AS fingerprint,
 t.assigned_to AS inspectorId,u.name AS inspectorName,t.started_at AS startedAt FROM rma_post_repair_inspections i
 JOIN asset_inspection_tasks t ON t.id=i.inspection_task_id JOIN users u ON u.id=t.assigned_to WHERE i.rma_id=?`;
const admin=(user:SessionUser)=>user.roles.includes('super_admin');
export const canReadPostRepair=(user:SessionUser)=>admin(user)||can(user,'post-repair:read')||can(user,'post-repair:inspect')||can(user,'post-repair:decide');
const canInspect=(user:SessionUser)=>admin(user)||can(user,'post-repair:inspect');
const canDecide=(user:SessionUser)=>admin(user)||can(user,'post-repair:decide');
async function scoped(db:D1Database,user:SessionUser,rmaId:string,action:'read'|'inspect'|'decide'){
  if(!(action==='read'?canReadPostRepair(user):action==='inspect'?canInspect(user):canDecide(user)))throw forbidden('你没有对应的维修后复检 / 再认证权限。');
  requireWorkspace(user,'ADMIN','SERVICE','CERTIFIED','INTERNATIONAL','UK_FULFILMENT');
  await requireRmaAccess(db,user,rmaId);
  const row=await one<Case&{market:string;warehouse:string}>(db,`SELECT c.id,c.asset_id AS assetId,c.order_id AS orderId,c.sales_account_id AS account,
   a.asset_code AS assetCode,COALESCE(NULLIF(a.current_sn,''),a.original_sn,'') AS expectedSn,e.id AS repairId,e.status AS repairStatus,c.market_region AS market,c.return_warehouse_id AS warehouse
   FROM after_sales_cases c JOIN assets a ON a.id=c.asset_id LEFT JOIN rma_repair_executions e ON e.rma_id=c.id WHERE c.id=? AND c.return_authorized_at IS NOT NULL`,rmaId);
  if(!row)throw notFound('未找到国际 RMA。');
  await requireOrderAccess(db,user,row.orderId);await requireAssetAccess(db,user,row.assetId);
  if(row.market!=='UK'||row.warehouse!=='wh-uk')throw forbidden('当前仅允许 Scope 内的 UK 退货隔离设备复检。');
  return row;
}
function match(row:Case,code:string){if(code.toUpperCase()!==row.assetCode.toUpperCase())throw conflict('Asset 不匹配，不能记录该 RMA 的复检。');}
function assignment(user:SessionUser,i:Inspection){
  requireInspectionAssignment(user,i.inspectorId);
  if(!admin(user)&&i.inspectorId!==user.id)throw forbidden('只有本次分配的复检人员或管理员可以编辑报告。');
}
// Shallow conjunction groups keep all guards within D1's expression-depth limit.
const eligibility=`SELECT c.id FROM after_sales_cases c JOIN rma_repair_executions e ON e.rma_id=c.id
 JOIN rma_return_inspections original ON original.id=c.resolution_inspection_id JOIN assets a ON a.id=c.asset_id
 JOIN asset_locations l ON l.asset_id=a.id JOIN warehouse_locations area ON area.id=l.location_id JOIN warehouses w ON w.id=l.warehouse_id JOIN orders o ON o.id=c.order_id
 WHERE (c.id=? AND c.asset_id=? AND c.order_id=? AND c.sales_account_id=? AND e.id=?)
 AND (c.status='in_progress' AND c.service_stage='REPAIR_COMPLETED' AND c.cross_border_resolution='REPAIR' AND c.resolution_decided_at=e.resolution_decided_at)
 AND (e.status='REPAIR_COMPLETED' AND e.asset_id=a.id AND e.order_id=o.id AND e.completed_at IS NOT NULL AND e.submission_fingerprint IS NOT NULL)
 AND (original.status='INSPECTION_COMPLETED' AND original.id=e.inspection_id AND original.asset_id=a.id AND original.rma_id=c.id)
 AND (c.market_region='UK' AND c.return_warehouse_id='wh-uk' AND w.status='active' AND w.market_region='UK')
 AND (l.custody='WAREHOUSE' AND l.warehouse_id='wh-uk' AND l.status='returned' AND a.inventory_status='QUARANTINED')
 AND (area.warehouse_id='wh-uk' AND area.code='RETURN-QUARANTINE' AND o.status='delivered' AND o.sales_account_id=c.sales_account_id)
 AND EXISTS(SELECT 1 FROM international_asset_allocations al WHERE al.order_id=o.id AND al.asset_id=a.id AND al.status='fulfilled')
 AND NOT EXISTS(SELECT 1 FROM international_asset_allocations al WHERE al.asset_id=a.id AND al.status='reserved')
 AND NOT EXISTS(SELECT 1 FROM asset_transfers tr WHERE tr.asset_id=a.id AND tr.status IN ('created','shipped'))
 AND EXISTS(SELECT 1 FROM asset_events ev WHERE ev.related_service_case_id=c.id AND ev.event_type='repair_completed' AND ev.source='international-rma-repair')`;
const params=(row:Case)=>[row.id,row.assetId,row.orderId,row.account,row.repairId];
function stateGuard(db:D1Database,row:Case){return db.prepare(`SELECT CASE WHEN EXISTS(${eligibility}) THEN 1 ELSE json('Post-repair state changed') END`).bind(...params(row));}
function taskGuard(db:D1Database,i:Inspection){return db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM rma_post_repair_inspections i JOIN asset_inspection_tasks t ON t.id=i.inspection_task_id
 WHERE (i.id=? AND i.status='IN_PROGRESS' AND t.status='in_progress') AND (t.process_code='POST_REPAIR_RECERTIFICATION' AND t.assigned_to=?))
 THEN 1 ELSE json('Post-repair report changed') END`).bind(i.id,i.inspectorId);}
async function report(db:D1Database,rmaId:string){return one<Inspection>(db,inspectionSelect,rmaId);}
async function decision(db:D1Database,rmaId:string){return one<Decision>(db,`SELECT d.id,d.inspection_id AS inspectionId,d.rma_id AS rmaId,d.asset_id AS assetId,d.decision,d.reason,d.notes,
 d.decided_by AS decidedBy,u.name AS decidedByName,d.decided_at AS decidedAt,d.certification_id AS certificationId,d.fingerprint FROM rma_recertification_decisions d JOIN users u ON u.id=d.decided_by WHERE d.rma_id=?`,rmaId);}
function records(db:D1Database,user:SessionUser,row:Case,i:Inspection|{id:string;taskId:string},event:string,now:string,requestId:string,extra:Record<string,unknown>={}){
  const metadata={rma_id:row.id,asset_id:row.assetId,repair_execution_id:row.repairId,inspection_id:i.id,inspection_task_id:i.taskId,
    purpose:'POST_REPAIR_RECERTIFICATION',inventory_status:'QUARANTINED',...extra};
  return [db.prepare(`INSERT INTO asset_events(id,asset_id,event_type,occurred_at,title,related_order_id,related_service_case_id,operator_user_id,visibility,source,new_value_json)
   VALUES(?,?,?,?,?,?,?,?,'admin_private','post-repair-recertification',?)`).bind(id(),row.assetId,event,now,event,row.orderId,row.id,user.id,JSON.stringify(metadata)),
   db.prepare(`INSERT INTO audit_logs(id,actor_id,action,entity_type,entity_id,request_id,after_json) VALUES(?,?,?,'rma_post_repair_inspection',?,?,?)`)
    .bind(id(),user.id,`international.rma.${event}`,i.id,requestId,JSON.stringify(metadata))];
}
// Read-only projection of canonical Asset / location / RMA facts. Sellable reuses
// the ordinary inventory predicate: not QUARANTINED, WAREHOUSE on_hand, not in
// service, no open RMA and no active transfer.
async function operationalState(db:D1Database,rmaId:string){
  const s=await one<{inventoryStatus:string;custody:string|null;locationStatus:string|null;warehouseCode:string|null;warehouseMarket:string|null;locationCode:string|null;rmaStatus:string;rmaStage:string;sellable:number}>(db,
   `SELECT a.inventory_status AS inventoryStatus,l.custody,l.status AS locationStatus,w.code AS warehouseCode,w.market_region AS warehouseMarket,area.code AS locationCode,
    c.status AS rmaStatus,c.service_stage AS rmaStage,
    CASE WHEN a.inventory_status<>'QUARANTINED' AND l.custody='WAREHOUSE' AND l.status='on_hand' AND a.asset_status<>'in_service'
     AND NOT EXISTS(SELECT 1 FROM after_sales_cases r WHERE r.asset_id=a.id AND r.status IN ('open','in_progress'))
     AND NOT EXISTS(SELECT 1 FROM asset_transfers t WHERE t.asset_id=a.id AND t.status IN ('created','shipped')) THEN 1 ELSE 0 END AS sellable
    FROM after_sales_cases c JOIN assets a ON a.id=c.asset_id LEFT JOIN asset_locations l ON l.asset_id=a.id
    LEFT JOIN warehouses w ON w.id=l.warehouse_id LEFT JOIN warehouse_locations area ON area.id=l.location_id WHERE c.id=?`,rmaId);
  if(!s)return null;
  return {...s,warehouseCode:s.custody==='WAREHOUSE'?s.warehouseCode:null,sellable:s.sellable===1,
    inventoryReleasePending:s.inventoryStatus==='QUARANTINED',rmaOpen:['open','in_progress'].includes(s.rmaStatus)};
}
const retryable=(e:unknown)=>e instanceof Error&&/malformed JSON|Post-repair .*changed|UNIQUE constraint failed|Invalid post-repair|Invalid recertification|immutable/i.test(e.message);
export async function postRepairDetail(db:D1Database,user:SessionUser,rmaId:string){
  const row=await scoped(db,user,rmaId,'read');const i=await report(db,rmaId),d=await decision(db,rmaId);
  const eligible=Boolean(await one(db,eligibility,...params(row)));
  const evidence=i?await all<{id:string;metadata:string;createdAt:string;createdByName:string}>(db,`SELECT e.id,e.metadata_json AS metadata,e.created_at AS createdAt,u.name AS createdByName
   FROM asset_inspection_evidence e JOIN users u ON u.id=e.created_by WHERE e.inspection_task_id=? ORDER BY e.created_at,e.id`,i.taskId):[];
  // Current is the canonical latest version only; older rows keep their stored
  // issuance status but are Superseded and never become current again.
  const history=(await all<{id:string;version:number;purpose:string;grade:string;status:string;issuedAt:string;taskId:string;postRepairInspectionId:string|null;isCurrent:number}>(db,`SELECT c.id,c.version,c.purpose,COALESCE(c.grade_display,c.grade) AS grade,
   c.certification_status AS status,c.certification_date AS issuedAt,c.inspection_task_id AS taskId,c.post_repair_inspection_id AS postRepairInspectionId,
   CASE WHEN cur.id IS NULL THEN 0 ELSE 1 END AS isCurrent FROM asset_certifications c LEFT JOIN current_asset_certifications cur ON cur.id=c.id WHERE c.asset_id=? ORDER BY c.version`,row.assetId))
   .map(c=>({...c,isCurrent:c.isCurrent===1,standing:c.isCurrent===1?'CURRENT':'SUPERSEDED'}));
  const state=(await operationalState(db,rmaId))!;
  return {purpose:'POST_REPAIR_RECERTIFICATION',assetCode:row.assetCode,executionStatus:row.repairStatus||'NOT_STARTED',items:postRepairItems,
    canStart:!i&&eligible&&canInspect(user),canDecide:Boolean(i?.status==='COMPLETED'&&!d&&eligible&&canDecide(user)),certificationHistory:history,
    currentCertification:history.find(c=>c.isCurrent)??null,operationalState:state,
    inspection:i?{id:i.id,rmaId:i.rmaId,assetId:i.assetId,repairExecutionId:i.repairId,taskId:i.taskId,status:i.status,inspectorId:i.inspectorId,inspectorName:i.inspectorName,
      startedAt:i.startedAt,completedAt:i.completedAt,assetCode:i.assetCode,expectedSn:i.expectedSn,observedSn:i.observedSn,snVerification:i.snVerification,grade:i.grade,
      checklist:JSON.parse(i.checklistJson),findings:JSON.parse(i.findingsJson),evidenceSnapshot:JSON.parse(i.evidenceJson),
      canEdit:i.status==='IN_PROGRESS'&&eligible&&canInspect(user)&&(admin(user)||i.inspectorId===user.id),
      evidence:evidence.map((e)=>{const m=JSON.parse(e.metadata);return {id:e.id,category:m.category,filename:m.originalFilename,contentType:m.contentType,fileSize:m.fileSize,createdAt:e.createdAt,createdByName:e.createdByName,contentUrl:`/international/post-repair-evidence/${e.id}/content`};})}:null,
    decision:d?{id:d.id,inspectionId:d.inspectionId,decision:d.decision,reason:d.reason,notes:d.notes,decidedBy:d.decidedBy,decidedByName:d.decidedByName,decidedAt:d.decidedAt,certificationId:d.certificationId}:null,
    inventoryReleasePending:state.inventoryReleasePending,sellable:state.sellable,eligibilityReason:eligible?'复检与再认证均不解除 UK Quarantine。':'必须完成正式 REPAIR 且设备仍位于 UK Return Quarantine。'};
}
export async function startPostRepair(db:D1Database,user:SessionUser,rmaId:string,input:z.infer<typeof postRepairStartSchema>,requestId:string){
  const row=await scoped(db,user,rmaId,'inspect');match(row,input.assetCode);
  const existing=await report(db,rmaId);if(existing){assignment(user,existing);if(existing.status==='COMPLETED')throw conflict('复检已完成，不能重新开始。');return postRepairDetail(db,user,rmaId);}
  const now=new Date().toISOString(),inspectionId=id(),taskId=id();
  try{await db.batch([stateGuard(db,row),
    db.prepare('INSERT INTO asset_inspection_tasks(id,asset_id,assigned_to,process_code,status,started_at,created_by) VALUES(?,?,?,\'POST_REPAIR_RECERTIFICATION\',\'in_progress\',?,?)').bind(taskId,row.assetId,user.id,now,user.id),
    db.prepare(`INSERT INTO rma_post_repair_inspections(id,rma_id,asset_id,repair_execution_id,inspection_task_id,status,matched_asset_code,expected_sn) VALUES(?,?,?,?,?,'IN_PROGRESS',?,?)`).bind(inspectionId,row.id,row.assetId,row.repairId,taskId,row.assetCode,row.expectedSn),
    ...records(db,user,row,{id:inspectionId,taskId},'post_repair_reinspection_started',now,requestId,{inspector_id:user.id,started_at:now})
  ]);}catch(error){if(retryable(error)){const current=await report(db,rmaId);if(current?.status==='IN_PROGRESS'){assignment(user,current);return postRepairDetail(db,user,rmaId);}throw conflict('设备、维修或复检状态已变化，不能开始复检。');}throw error;}
  return postRepairDetail(db,user,rmaId);
}
function normalize(row:Case,input:Draft){return {...input,assetCode:row.assetCode,checklist:[...input.checklist].sort((a,b)=>a.item.localeCompare(b.item))};}
function validateFacts(i:Inspection,input:Draft,complete:boolean){
  if(new Set(input.checklist.map(c=>c.item)).size!==postRepairItems.length)throw badRequest('请填写九个不同的复检项目。');
  if(!complete)return;
  if(input.checklist.some(c=>c.result==='NOT_TESTED'&&!c.notes))throw badRequest('未检测项目必须说明原因，不能视为 PASS。');
  const identity=input.checklist.find(c=>c.item==='IDENTITY');
  if(input.snVerification==='NOT_TESTED'){if(input.observedSn||!identity?.notes)throw badRequest('未核验 SN 时需留空观察 SN，并记录原因。');}
  else{const actual=input.observedSn&&i.expectedSn&&input.observedSn.toUpperCase()===i.expectedSn.toUpperCase()?'MATCH':'MISMATCH';
    if(!input.observedSn||actual!==input.snVerification||(actual==='MISMATCH'&&!identity?.notes))throw badRequest('请准确记录观察 SN 和核验异常；不会修改原始 SN。');}
}
function draftStatements(db:D1Database,i:Inspection,input:Draft){return db.prepare(`UPDATE rma_post_repair_inspections SET observed_sn=?,sn_verification=?,grade=?,checklist_json=?,findings_json=? WHERE id=? AND status='IN_PROGRESS'`)
 .bind(input.observedSn,input.snVerification,input.grade,JSON.stringify(input.checklist),JSON.stringify(input.findings),i.id);}
export async function savePostRepair(db:D1Database,user:SessionUser,rmaId:string,input:Draft,requestId:string){
  const row=await scoped(db,user,rmaId,'inspect');match(row,input.assetCode);const i=await report(db,rmaId);if(!i||i.status!=='IN_PROGRESS')throw conflict('只有进行中的复检可以保存草稿。');assignment(user,i);validateFacts(i,input,false);
  const normalized=normalize(row,input);if(i.observedSn===normalized.observedSn&&i.snVerification===normalized.snVerification&&i.grade===normalized.grade&&i.checklistJson===JSON.stringify(normalized.checklist)&&i.findingsJson===JSON.stringify(normalized.findings))return postRepairDetail(db,user,rmaId);
  try{await db.batch([stateGuard(db,row),taskGuard(db,i),draftStatements(db,i,normalized),db.prepare(`INSERT INTO audit_logs(id,actor_id,action,entity_type,entity_id,request_id,after_json) VALUES(?,?,'international.rma.post_repair_draft','rma_post_repair_inspection',?,?,?)`)
   .bind(id(),user.id,i.id,requestId,JSON.stringify({rma_id:rmaId,purpose:'POST_REPAIR_RECERTIFICATION'}))]);}
  catch(e){if(retryable(e))throw conflict('复检草稿已锁定或设备状态变化。');throw e;}return postRepairDetail(db,user,rmaId);
}
export async function completePostRepair(db:D1Database,user:SessionUser,rmaId:string,input:Complete,requestId:string){
  const row=await scoped(db,user,rmaId,'inspect');match(row,input.assetCode);const i=await report(db,rmaId);if(!i)throw conflict('请先开始维修后复检。');assignment(user,i);
  const normalized=normalize(row,input),fingerprint=await hashIdentifier(JSON.stringify(normalized));
  const repeated=(r:Inspection)=>{if(r.status!=='COMPLETED')return false;if(r.fingerprint!==fingerprint)throw conflict('复检报告已锁定，不同内容不能覆盖。');return true;};
  if(repeated(i))return postRepairDetail(db,user,rmaId);validateFacts(i,input,true);
  const photos=await all<{id:string;metadata:string}>(db,'SELECT id,metadata_json AS metadata FROM asset_inspection_evidence WHERE inspection_task_id=? ORDER BY id',i.taskId);
  if(!photos.some(p=>JSON.parse(p.metadata).category==='OVERALL_CONDITION'))throw conflict('至少上传一张 Overall Condition 私有照片才能完成复检。');
  const snapshot=JSON.stringify(photos.map(p=>p.id)),now=new Date().toISOString();
  const result=input.checklist.some(c=>c.result==='FAIL')?'FAIL':input.checklist.some(c=>c.result==='NOT_TESTED')?'ADVISORY':'PASS';
  try{await db.batch([stateGuard(db,row),taskGuard(db,i),
    db.prepare(`SELECT CASE WHEN (SELECT json_group_array(id) FROM(SELECT id FROM asset_inspection_evidence WHERE inspection_task_id=? ORDER BY id))=? THEN 1 ELSE json('Post-repair evidence changed') END`).bind(i.taskId,snapshot),
    db.prepare(`UPDATE asset_inspection_tasks SET status='completed',result=?,grade=?,grade_display=?,notes=?,completed_at=?,updated_at=? WHERE id=? AND status='in_progress'`)
      .bind(result,legacyCertifiedGrade(input.grade),input.grade,input.findings.inspectorNotes,now,now,i.taskId),
    draftStatements(db,i,normalized),
    db.prepare(`UPDATE rma_post_repair_inspections SET status='COMPLETED',completed_at=?,completion_fingerprint=?,evidence_snapshot_json=? WHERE id=? AND status='IN_PROGRESS'`).bind(now,fingerprint,snapshot,i.id),
    ...records(db,user,row,i,'post_repair_reinspection_completed',now,requestId,{inspector_id:i.inspectorId,completed_by:user.id,completed_at:now,result})
  ]);}catch(e){if(retryable(e)){const current=await report(db,rmaId);if(current&&repeated(current))return postRepairDetail(db,user,rmaId);throw conflict('复检或照片状态已变化，请刷新；不能覆盖完成报告。');}throw e;}
  return postRepairDetail(db,user,rmaId);
}
function approveEligible(i:Inspection){
  const checklist=JSON.parse(i.checklistJson) as Draft['checklist'],findings=JSON.parse(i.findingsJson) as Draft['findings'];
  return i.snVerification==='MATCH'&&i.grade!==null&&i.grade!=='Parts / Repair'&&findings.issueRemains==='NO'&&findings.functionalCondition==='GOOD'
    &&checklist.length===9&&checklist.every(c=>c.result==='PASS'||c.result==='NOT_APPLICABLE')
    &&['IDENTITY','POWER','FUNCTIONAL','REPAIRED_FUNCTION','FINAL_QC'].every(item=>checklist.some(c=>c.item===item&&c.result==='PASS'));
}
export async function decideRecertification(db:D1Database,user:SessionUser,rmaId:string,input:DecisionInput,requestId:string){
  const row=await scoped(db,user,rmaId,'decide');const i=await report(db,rmaId);if(!i||i.id!==input.inspectionId||i.status!=='COMPLETED')throw conflict('再认证决定必须引用本 RMA 正式完成的维修后复检。');
  const fingerprint=await hashIdentifier(JSON.stringify(input));
  const repeated=(d:Decision)=>{if(d.fingerprint!==fingerprint)throw conflict('再认证决定已锁定，不同决定或内容不能覆盖。');};
  const existing=await decision(db,rmaId);if(existing){repeated(existing);return postRepairDetail(db,user,rmaId);}
  if(input.decision==='APPROVED'&&!approveEligible(i))throw conflict('报告尚未符合 Certified 质量条件；不能因维修完成或未检测而批准再认证。');
  const now=new Date().toISOString(),decisionId=id(),certId=input.decision==='APPROVED'?id():null;
  const version=(await one<{v:number}>(db,'SELECT COALESCE(MAX(version),0)+1 AS v FROM asset_certifications WHERE asset_id=?',row.assetId))!.v;
  if(input.decision==='APPROVED'&&version<2)throw conflict('未找到原始认证历史，不能签发维修后认证版本。');
  const evidenceSnapshot=i.evidenceJson;
  try{await db.batch([stateGuard(db,row),
    db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM rma_post_repair_inspections i JOIN asset_inspection_tasks t ON t.id=i.inspection_task_id
     WHERE(i.id=? AND i.rma_id=? AND i.status='COMPLETED' AND i.completion_fingerprint=?) AND(t.status='completed' AND t.process_code='POST_REPAIR_RECERTIFICATION'))
     AND NOT EXISTS(SELECT 1 FROM rma_recertification_decisions WHERE rma_id=?)
     AND EXISTS(SELECT 1 FROM asset_events WHERE related_service_case_id=? AND event_type='post_repair_reinspection_completed' AND source='post-repair-recertification')
     AND (SELECT json_group_array(id) FROM(SELECT id FROM asset_inspection_evidence WHERE inspection_task_id=? ORDER BY id))=?
     THEN 1 ELSE json('Post-repair decision changed') END`).bind(i.id,row.id,i.fingerprint,row.id,row.id,i.taskId,evidenceSnapshot),
    db.prepare(`INSERT INTO rma_recertification_decisions(id,inspection_id,rma_id,asset_id,decision,reason,notes,decided_by,decided_at,certification_id,fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(decisionId,i.id,row.id,row.assetId,input.decision,input.reason,input.notes,user.id,now,certId,fingerprint),
    ...(certId?[db.prepare(`INSERT INTO asset_certifications(id,asset_id,inspection_task_id,grade,grade_display,inspection_result,final_qc,certification_date,certification_status,verification_code_hash,created_by,version,purpose,post_repair_inspection_id)
      VALUES(?,?,?,?,?,'PASS',1,?,'certified',?,?,?,'POST_REPAIR_RECERTIFICATION',?)`).bind(certId,row.assetId,i.taskId,legacyCertifiedGrade(i.grade!),i.grade,now,await hashIdentifier(crypto.randomUUID()),user.id,version,i.id)]:[]),
    ...records(db,user,row,i,input.decision==='APPROVED'?'recertification_approved':'recertification_rejected',now,requestId,{decision_id:decisionId,decision:input.decision,decided_by:user.id,decided_at:now,certification_id:certId,...(certId?{certification_version:version}:{})}),
    ...(certId?records(db,user,row,i,'certification_issued',now,requestId,{certification_id:certId,certification_version:version,issuer_id:user.id}):[])
  ]);}catch(e){if(retryable(e)){const current=await decision(db,rmaId);if(current){repeated(current);return postRepairDetail(db,user,rmaId);}throw conflict('复检、决定或隔离状态已变化，不能签发认证。');}throw e;}
  return postRepairDetail(db,user,rmaId);
}
// The 25MB photo limit plus multipart framing; larger declared bodies are refused unread.
const maxUploadBytes=25*1024*1024+64*1024;
export async function uploadPostRepairEvidence(db:D1Database,bucket:R2Bucket|undefined,user:SessionUser,rmaId:string,request:Request,requestId:string){
  // Authorize permission, Workspace, scope, report state and assignment before the body is read.
  const row=await scoped(db,user,rmaId,'inspect'),i=await report(db,rmaId);if(!i||i.status!=='IN_PROGRESS')throw conflict('仅进行中的复检可以上传照片。');assignment(user,i);
  if(!bucket)throw conflict('私有照片存储尚未配置。');
  if(!/^multipart\/form-data\s*;/i.test(request.headers.get('Content-Type')||''))throw badRequest('请使用 multipart/form-data 上传复检照片。');
  const declared=Number(request.headers.get('Content-Length'));if(Number.isFinite(declared)&&declared>maxUploadBytes)throw badRequest('仅支持 25MB 以内的 JPG、PNG 或 WebP 照片。');
  let form:FormData;try{form=await request.formData();}catch{throw badRequest('上传内容格式有误，请重新选择照片。');}
  const category=z.enum(categories).parse(form.get('category')),{file,bytes}=await validatedInspectionPhoto(form.get('file'));
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join('');
  const key=`post-repair-inspection/${i.taskId}/${category}/${digest}`;
  if(await one(db,'SELECT id FROM asset_inspection_evidence WHERE inspection_task_id=? AND object_key=?',i.taskId,key))return postRepairDetail(db,user,rmaId);
  const evidenceId=id(),metadata={purpose:'POST_REPAIR_RECERTIFICATION',category,originalFilename:file.name.slice(0,200)||'photo',contentType:file.type,fileSize:file.size};
  await bucket.put(key,bytes,{httpMetadata:{contentType:file.type},customMetadata:{uploadedBy:user.id,originalFilename:metadata.originalFilename}});
  try{await db.batch([stateGuard(db,row),taskGuard(db,i),db.prepare(`INSERT INTO asset_inspection_evidence(id,inspection_task_id,evidence_type,object_key,metadata_json,created_by) VALUES(?,?,'photo',?,?,?)`).bind(evidenceId,i.taskId,key,JSON.stringify(metadata),user.id),
    db.prepare(`INSERT INTO audit_logs(id,actor_id,action,entity_type,entity_id,request_id,after_json) VALUES(?,?,'international.rma.post_repair_evidence','rma_post_repair_inspection',?,?,?)`).bind(id(),user.id,i.id,requestId,JSON.stringify({evidence_id:evidenceId,category}))]);}
  catch(e){const linked=await one(db,'SELECT id FROM asset_inspection_evidence WHERE object_key=?',key).catch(()=>{throw e;});if(linked)return postRepairDetail(db,user,rmaId);
    // A content-addressed key may be concurrently linked. Never delete it on an
    // uncertain outcome: an unlinked private object is inaccessible, and a retry
    // reuses it. This preserves committed evidence during lost responses.
    if(retryable(e))throw conflict('报告已锁定或照片状态变化，请刷新。');throw e;}
  return postRepairDetail(db,user,rmaId);
}
export async function postRepairEvidenceContent(db:D1Database,bucket:R2Bucket|undefined,user:SessionUser,evidenceId:string){
  const e=await one<{rmaId:string;key:string;metadata:string}>(db,`SELECT i.rma_id AS rmaId,e.object_key AS key,e.metadata_json AS metadata FROM asset_inspection_evidence e
    JOIN rma_post_repair_inspections i ON i.inspection_task_id=e.inspection_task_id WHERE e.id=?`,evidenceId);if(!e)throw notFound('复检照片不存在。');
  await scoped(db,user,e.rmaId,'read');const object=await bucket?.get(e.key);if(!object)throw notFound('复检照片内容暂不可用。');
  return new Response(object.body,{headers:{'Content-Type':JSON.parse(e.metadata).contentType,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"}});
}
