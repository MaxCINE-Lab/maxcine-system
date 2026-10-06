import { badRequest, can, conflict, forbidden, hasGlobalInternationalAccess, notFound, type SessionUser } from '@maxcine/shared';
import { z } from 'zod';
import { all, id, one } from './db';
import { hashIdentifier } from './auth';
import { requireOrderAccess, requireRmaAccess } from './internationalAuthorization';

export const inspectionItems = ['IDENTITY','EXTERIOR','DISPLAY','LENS_CAMERA','POWER','FUNCTIONAL','ACCESSORIES','RETURN_REASON'] as const;
export const evidenceCategories = ['OVERALL_CONDITION','DAMAGE_DEFECT','ACCESSORIES','OTHER'] as const;
export const inspectionStartSchema = z.object({ assetCode: z.string().trim().min(1).max(100) }).strict();
export const inspectionCompleteSchema = inspectionStartSchema.extend({
  observedSn: z.string().trim().max(160).default(''),
  snVerification: z.enum(['MATCH','MISMATCH','NOT_TESTED']),
  checklist: z.array(z.object({ item: z.enum(inspectionItems), result: z.enum(['PASS','FAIL','NOT_APPLICABLE','NOT_TESTED']), notes: z.string().trim().max(1000).default('') }).strict()).length(8),
  findings: z.object({ issueReproduced: z.enum(['YES','NO','INCONCLUSIVE']), conditionAssessment: z.enum(['GOOD','COSMETIC_DAMAGE','FUNCTIONAL_DEFECT','PHYSICAL_DAMAGE','INCOMPLETE','OTHER']), inspectorNotes: z.string().trim().min(1).max(4000) }).strict()
}).strict();
type Case = { id: string; assetId: string; orderId: string; salesAccountId: string | null; stage: string; assetCode: string; expectedSn: string };
type Inspection = { id: string; rmaId: string; assetId: string; orderId: string; inspectorId: string; inspectorName: string; status: string; matchedAssetCode: string; expectedSn: string; observedSn: string; snVerification: string; checklistJson: string; findingsJson: string; evidenceSnapshotJson: string; startedAt: string; completedAt: string | null; submissionFingerprint: string | null };
type Evidence = { id: string; category: string; filename: string; contentType: string; fileSize: number; createdAt: string; createdBy: string; createdByName: string };
const inspectionSelect = `SELECT i.id,i.rma_id AS rmaId,i.asset_id AS assetId,i.order_id AS orderId,i.inspector_id AS inspectorId,u.name AS inspectorName,i.status,
  i.matched_asset_code AS matchedAssetCode,i.expected_sn AS expectedSn,i.observed_sn AS observedSn,i.sn_verification AS snVerification,
  i.checklist_json AS checklistJson,i.findings_json AS findingsJson,i.evidence_snapshot_json AS evidenceSnapshotJson,i.started_at AS startedAt,i.completed_at AS completedAt,i.submission_fingerprint AS submissionFingerprint
  FROM rma_return_inspections i JOIN users u ON u.id=i.inspector_id WHERE i.rma_id=?`;

async function scopedCase(db: D1Database,user: SessionUser,rmaId: string,completedReview=false): Promise<Case> {
  const inspecting=hasGlobalInternationalAccess(user) || can(user,'international-return:inspect');
  const reviewing=completedReview && (user.roles.includes('super_admin') || can(user,'international-after-sales:decide') || can(user,'international-repair:execute') || can(user,'post-repair:read') || can(user,'post-repair:inspect') || can(user,'post-repair:decide'));
  if (!inspecting && !reviewing) throw forbidden('你没有 UK 退货检测或已完成报告审阅权限。');
  await requireRmaAccess(db,user,rmaId);
  const row = await one<Case & { market: string; warehouse: string }>(db,`SELECT c.id,c.asset_id AS assetId,c.order_id AS orderId,c.sales_account_id AS salesAccountId,c.service_stage AS stage,
    c.market_region AS market,c.return_warehouse_id AS warehouse,a.asset_code AS assetCode,COALESCE(NULLIF(a.current_sn,''),a.original_sn,'') AS expectedSn
    FROM after_sales_cases c JOIN assets a ON a.id=c.asset_id WHERE c.id=? AND c.return_authorized_at IS NOT NULL`,rmaId);
  if (!row) throw notFound('未找到国际 RMA。');
  await requireOrderAccess(db,user,row.orderId);
  if (row.market!=='UK' || row.warehouse!=='wh-uk') throw forbidden('仅允许 Scope 内的 UK 退货仓检测。');
  if (!inspecting && !await one(db,"SELECT id FROM rma_return_inspections WHERE rma_id=? AND status='INSPECTION_COMPLETED'",rmaId)) throw forbidden('决策 / 维修权限仅允许审阅正式完成的检测报告。');
  return row;
}
function match(row: Case,code: string) {
  if (code.trim().toUpperCase()!==row.assetCode.toUpperCase()) throw conflict('Asset 不匹配：输入的设备与 RMA 绑定设备不一致，不能检测。');
}
function assigned(user: SessionUser,inspection: Inspection) {
  if (!hasGlobalInternationalAccess(user) && inspection.inspectorId!==user.id) throw forbidden('仅本次检测员或管理员可以提交报告及上传证据。');
}
function stateGuard(db: D1Database,row: Case,stage: string,code: string) {
  // Mutable state and the original sale link are rechecked atomically. No Asset,
  // Location, Certification or Warranty writes are part of inspection.
  return db.prepare(`SELECT CASE WHEN EXISTS (
    SELECT 1 FROM after_sales_cases c JOIN assets a ON a.id=c.asset_id JOIN asset_locations l ON l.asset_id=a.id
    JOIN orders o ON o.id=c.order_id JOIN warehouses w ON w.id=c.return_warehouse_id JOIN warehouse_locations area ON area.id=l.location_id
    WHERE c.id=? AND c.asset_id=? AND c.order_id=? AND c.sales_account_id=? AND o.sales_account_id=c.sales_account_id
    AND c.status='in_progress' AND c.service_stage=? AND c.return_received_at IS NOT NULL AND c.return_shipped_at IS NOT NULL
    AND c.market_region='UK' AND c.return_warehouse_id='wh-uk' AND w.status='active' AND o.status='delivered' AND o.fulfilment_warehouse_id='wh-uk'
    AND a.inventory_status='QUARANTINED' AND UPPER(a.asset_code)=? AND l.custody='WAREHOUSE' AND l.status='returned'
    AND l.warehouse_id='wh-uk' AND area.warehouse_id='wh-uk' AND area.code='RETURN-QUARANTINE'
    AND (SELECT COUNT(*) FROM international_asset_allocations al WHERE al.asset_id=a.id AND al.order_id=o.id AND al.status='fulfilled')=1
    AND NOT EXISTS (SELECT 1 FROM international_asset_allocations al WHERE al.asset_id=a.id AND al.status='reserved')
    AND NOT EXISTS (SELECT 1 FROM asset_transfers t WHERE t.asset_id=a.id AND t.status IN ('created','shipped'))
    ) THEN 1 ELSE json('Inspection state changed') END`).bind(row.id,row.assetId,row.orderId,row.salesAccountId,stage,code.trim().toUpperCase());
}
function reportGuard(db: D1Database,inspection: Inspection) {
  return db.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM rma_return_inspections WHERE id=? AND rma_id=? AND inspector_id=? AND status='INSPECTION_IN_PROGRESS')
    THEN 1 ELSE json('Inspection report changed') END`).bind(inspection.id,inspection.rmaId,inspection.inspectorId);
}
function records(db: D1Database,user: SessionUser,row: Case,inspectionId: string,now: string,requestId: string,completed: boolean) {
  const event=completed?'return_inspection_completed':'return_inspection_started';
  const metadata=JSON.stringify({ rma_id:row.id,asset_id:row.assetId,order_id:row.orderId,inspection_id:inspectionId,inspector_id:user.id,status:completed?'INSPECTION_COMPLETED':'INSPECTION_IN_PROGRESS',inventory_status:'QUARANTINED' });
  return [db.prepare(`INSERT INTO asset_events (id,asset_id,event_type,occurred_at,title,related_order_id,related_service_case_id,operator_user_id,visibility,source,new_value_json)
    VALUES (?,?,?,?,?,?,?,?,'admin_private','international-return-inspection',?)`).bind(id(),row.assetId,event,now,completed?'退货检测已完成，等待处理决策；继续隔离':'退货检测已开始',row.orderId,row.id,user.id,metadata),
    db.prepare(`INSERT INTO audit_logs (id,actor_id,action,entity_type,entity_id,request_id,after_json) VALUES (?,?,?,'rma_return_inspection',?,?,?)`).bind(id(),user.id,`international.rma.${event}`,inspectionId,requestId,metadata)];
}
function retryable(error: unknown) { return error instanceof Error && /malformed JSON|Inspection .*changed|UNIQUE constraint failed/i.test(error.message); }

export async function returnInspectionDetail(db: D1Database,user: SessionUser,rmaId: string) {
  const row=await scopedCase(db,user,rmaId,true);
  const inspection=await one<Inspection>(db,inspectionSelect,rmaId);
  if (!inspection) return { inspection:null,canStart:row.stage==='RECEIVED',items:inspectionItems };
  const evidence=await all<Evidence>(db,`SELECT e.id,e.category,e.filename,e.content_type AS contentType,e.file_size AS fileSize,e.created_at AS createdAt,e.created_by AS createdBy,u.name AS createdByName
    FROM rma_return_inspection_evidence e JOIN users u ON u.id=e.created_by WHERE e.inspection_id=? ORDER BY e.created_at,e.id`,inspection.id);
  return { inspection:{ id:inspection.id,rmaId:inspection.rmaId,assetId:inspection.assetId,orderId:inspection.orderId,inspectorId:inspection.inspectorId,inspectorName:inspection.inspectorName,
    status:inspection.status,matchedAssetCode:inspection.matchedAssetCode,expectedSn:inspection.expectedSn,observedSn:inspection.observedSn,snVerification:inspection.snVerification,startedAt:inspection.startedAt,completedAt:inspection.completedAt,
    checklist:JSON.parse(inspection.checklistJson),findings:JSON.parse(inspection.findingsJson),evidenceSnapshot:JSON.parse(inspection.evidenceSnapshotJson),
    evidence:evidence.map((e)=>({...e,contentUrl:`/international/return-inspection-evidence/${e.id}/content`})),
    canEdit:inspection.status==='INSPECTION_IN_PROGRESS' && (hasGlobalInternationalAccess(user) || inspection.inspectorId===user.id) },canStart:false,items:inspectionItems };
}

export async function startReturnInspection(db: D1Database,user: SessionUser,rmaId: string,input: z.infer<typeof inspectionStartSchema>,requestId: string) {
  const row=await scopedCase(db,user,rmaId); match(row,input.assetCode);
  if (await one(db,inspectionSelect,rmaId)) return returnInspectionDetail(db,user,rmaId);
  const now=new Date().toISOString(); const inspectionId=id();
  try {
    await db.batch([stateGuard(db,row,'RECEIVED',input.assetCode),
      db.prepare(`INSERT INTO rma_return_inspections (id,rma_id,asset_id,order_id,inspector_id,status,matched_asset_code,expected_sn,started_at)
        VALUES (?,?,?,?,?,'INSPECTION_IN_PROGRESS',?,?,?)`).bind(inspectionId,row.id,row.assetId,row.orderId,user.id,row.assetCode,row.expectedSn,now),
      db.prepare(`UPDATE after_sales_cases SET service_stage='INSPECTION_IN_PROGRESS',updated_at=?,updated_by=? WHERE id=?`).bind(now,user.id,row.id),
      ...records(db,user,row,inspectionId,now,requestId,false)]);
  } catch(error) {
    if (retryable(error)) {
      if (await one(db,inspectionSelect,rmaId)) return returnInspectionDetail(db,user,rmaId);
      throw conflict('只有已收货且仍在 UK Return Quarantine 的设备可以开始检测，请刷新。');
    } throw error;
  }
  return returnInspectionDetail(db,user,rmaId);
}

export async function completeReturnInspection(db: D1Database,user: SessionUser,rmaId: string,input: z.infer<typeof inspectionCompleteSchema>,requestId: string) {
  const row=await scopedCase(db,user,rmaId); match(row,input.assetCode);
  const inspection=await one<Inspection>(db,inspectionSelect,rmaId);
  if (!inspection) throw conflict('请先开始退货检测。');
  assigned(user,inspection);
  // Canonicalize order/case before hashing to make request retries deterministic.
  const normalized={...input,assetCode:row.assetCode,checklist:[...input.checklist].sort((a,b)=>a.item.localeCompare(b.item))};
  const fingerprint=await hashIdentifier(JSON.stringify(normalized));
  const repeated=(report: Inspection) => {
    if (report.status!=='INSPECTION_COMPLETED') return false;
    if (report.submissionFingerprint!==fingerprint) throw conflict('检测报告已完成并锁定，不能覆盖已提交事实。');
    return true;
  };
  if (repeated(inspection)) return returnInspectionDetail(db,user,rmaId);
  if (new Set(input.checklist.map((item)=>item.item)).size!==inspectionItems.length) throw badRequest('请完整填写八个不同检测项目。');
  if (input.checklist.some((item)=>item.result==='NOT_TESTED' && !item.notes)) throw badRequest('NOT_TESTED 必须说明未检测原因，不能默认为 PASS。');
  if (input.snVerification==='NOT_TESTED') {
    if (input.observedSn || !input.checklist.find((item)=>item.item==='IDENTITY')?.notes) throw badRequest('未核验 SN 时请留空观察 SN，并在 Identity 备注说明。');
  } else {
    if (!input.observedSn) throw badRequest('请填写实际观察的 SN。');
    const actual=input.observedSn.toUpperCase()===inspection.expectedSn.toUpperCase() && Boolean(inspection.expectedSn) ? 'MATCH':'MISMATCH';
    if (actual!==input.snVerification) throw badRequest('SN 核验结果与观察 SN 不一致；请记录真实异常，不会更改原 SN。');
    if (actual==='MISMATCH' && !input.checklist.find((item)=>item.item==='IDENTITY')?.notes) throw badRequest('SN 不一致时必须填写 Identity 异常备注。');
  }
  const evidence=await all<{id:string}>(db,'SELECT id FROM rma_return_inspection_evidence WHERE inspection_id=? ORDER BY id',inspection.id);
  const now=new Date().toISOString();
  try {
    await db.batch([stateGuard(db,row,'INSPECTION_IN_PROGRESS',input.assetCode),reportGuard(db,inspection),
      db.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM rma_return_inspection_evidence WHERE inspection_id=? AND category='OVERALL_CONDITION')
        AND (SELECT json_group_array(id) FROM (SELECT id FROM rma_return_inspection_evidence WHERE inspection_id=? ORDER BY id))=?
        THEN 1 ELSE json('Inspection evidence changed') END`).bind(inspection.id,inspection.id,JSON.stringify(evidence.map((e)=>e.id))),
      db.prepare(`UPDATE rma_return_inspections SET status='INSPECTION_COMPLETED',completed_at=?,observed_sn=?,sn_verification=?,checklist_json=?,findings_json=?,
        evidence_snapshot_json=?,submission_fingerprint=? WHERE id=?`).bind(now,input.observedSn,input.snVerification,JSON.stringify(normalized.checklist),JSON.stringify(input.findings),JSON.stringify(evidence.map((e)=>e.id)),fingerprint,inspection.id),
      db.prepare(`UPDATE after_sales_cases SET service_stage='INSPECTION_COMPLETED',updated_at=?,updated_by=? WHERE id=?`).bind(now,user.id,row.id),
      ...records(db,user,row,inspection.id,now,requestId,true)]);
  } catch(error) {
    if (retryable(error)) {
      const latest=await one<Inspection>(db,inspectionSelect,rmaId);
      if (latest && repeated(latest)) return returnInspectionDetail(db,user,rmaId);
      throw conflict('检测状态或照片已变化；至少上传一张 Overall Condition 照片后刷新重试。');
    } throw error;
  }
  return returnInspectionDetail(db,user,rmaId);
}

export async function validatedInspectionPhoto(file:FormDataEntryValue|null){
  if (!(file instanceof File) || !['image/jpeg','image/png','image/webp'].includes(file.type) || !file.size || file.size>25*1024*1024) throw badRequest('仅支持 25MB 以内的 JPG、PNG 或 WebP 照片。');
  const bytes=await file.arrayBuffer();const head=new Uint8Array(bytes);
  const valid=file.type==='image/jpeg'?head[0]===255&&head[1]===216&&head[2]===255:file.type==='image/png'
    ?[137,80,78,71,13,10,26,10].every((byte,index)=>head[index]===byte)
    :new TextDecoder().decode(head.slice(0,4))==='RIFF'&&new TextDecoder().decode(head.slice(8,12))==='WEBP';
  if(!valid)throw badRequest('文件内容与照片类型不一致。');
  return {file,bytes};
}
export async function uploadReturnInspectionEvidence(db: D1Database,bucket: R2Bucket | undefined,user: SessionUser,rmaId: string,form: FormData,requestId: string) {
  const row=await scopedCase(db,user,rmaId);
  const inspection=await one<Inspection>(db,inspectionSelect,rmaId);
  if (!inspection || inspection.status!=='INSPECTION_IN_PROGRESS') throw conflict('仅检测进行中可以上传照片。');
  assigned(user,inspection);
  if (!bucket) throw conflict('私有照片存储尚未配置。');
  const category=z.enum(evidenceCategories).parse(form.get('category'));
  const {file,bytes}=await validatedInspectionPhoto(form.get('file'));
  const evidenceId=id(); const key=`return-inspection/${inspection.id}/${evidenceId}`; const now=new Date().toISOString();
  await bucket.put(key,bytes,{httpMetadata:{contentType:file.type},customMetadata:{uploadedBy:user.id,originalFilename:file.name}});
  try {
    await db.batch([stateGuard(db,row,'INSPECTION_IN_PROGRESS',row.assetCode),reportGuard(db,inspection),
      db.prepare(`INSERT INTO rma_return_inspection_evidence (id,inspection_id,category,object_key,filename,content_type,file_size,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?)`)
        .bind(evidenceId,inspection.id,category,key,file.name.slice(0,200)||'photo',file.type,file.size,now,user.id),
      db.prepare(`INSERT INTO audit_logs (id,actor_id,action,entity_type,entity_id,request_id,after_json) VALUES (?,?,'international.rma.inspection_evidence','rma_return_inspection',?,?,?)`)
        .bind(id(),user.id,inspection.id,requestId,JSON.stringify({rma_id:rmaId,evidence_id:evidenceId,category,content_type:file.type}))]);
  } catch(error) {
    // A response can be lost after D1 commits. Never delete an object already
    // referenced by a report; if D1 is unavailable, retain the private object
    // rather than risk destroying committed evidence.
    const linked=await one<{id:string}>(db,'SELECT id FROM rma_return_inspection_evidence WHERE id=?',evidenceId).catch(()=>{throw error;});
    if (linked) return returnInspectionDetail(db,user,rmaId);
    // The object is not exposed until its DB link commits. Failed links are
    // cleaned; a cleanup outage leaves only an inaccessible orphan, not a report.
    await bucket.delete(key).catch(()=>undefined);
    if (retryable(error)) throw conflict('检测状态已变化，照片未加入报告，请刷新。');
    throw error;
  }
  return returnInspectionDetail(db,user,rmaId);
}

export async function returnInspectionEvidenceContent(db: D1Database,bucket: R2Bucket | undefined,user: SessionUser,evidenceId: string) {
  const row=await one<{rmaId:string;objectKey:string;contentType:string}>(db,`SELECT i.rma_id AS rmaId,e.object_key AS objectKey,e.content_type AS contentType FROM rma_return_inspection_evidence e
    JOIN rma_return_inspections i ON i.id=e.inspection_id WHERE e.id=?`,evidenceId);
  if (!row) throw notFound('照片不存在。');
  await scopedCase(db,user,row.rmaId,true);
  const object=await bucket?.get(row.objectKey);
  if (!object) throw notFound('照片内容暂不可用。');
  return new Response(object.body,{headers:{'Content-Type':row.contentType,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"}});
}
