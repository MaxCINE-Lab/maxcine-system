import { AppError, can, conflict, forbidden, hasGlobalInternationalAccess, notFound, requireSalesAccountScope, requireWarehouseScope, requireWorkspace, workspaceScopeIds, type SessionUser } from '@maxcine/shared';
import { z } from 'zod';
import { hashIdentifier } from './auth';
import { all, id, one } from './db';
import { requireAssetAccess, requireOrderAccess, requireRmaAccess } from './internationalAuthorization';

// REPLACE execution only: record and commit a separate replacement Asset.
// No shipment, delivery, quarantine release, RMA closure or Warranty change.
export const replaceStartSchema=z.object({}).strict();
export const replaceSelectSchema=z.object({replacementAssetCode:z.string().trim().min(1).max(100)}).strict();
export const replaceCompleteSchema=z.object({replacementAssetCode:z.string().trim().min(1).max(100),executionNotes:z.string().trim().min(1).max(4000)}).strict();
type SelectInput=z.infer<typeof replaceSelectSchema>;
type CompleteInput=z.infer<typeof replaceCompleteSchema>;
type Case={id:string;rmaReference:string;assetId:string;assetCode:string;orderId:string;salesAccountId:string|null;market:string;warehouse:string;stage:string;
  status:string;resolution:string|null;decidedAt:string|null;inspectionId:string|null;productId:string|null;productName:string;version:string;
  inventoryStatus:string;custody:string|null;locationStatus:string|null;locationCode:string|null};
type Execution={id:string;rmaId:string;originalAssetId:string;orderId:string;resolutionReference:string;resolutionDecidedAt:string;inspectionId:string;status:string;
  startedBy:string;startedByName:string;startedAt:string;replacementAssetId:string|null;replacementAssetCode:string|null;replacementWarehouseId:string|null;
  replacementCertificationId:string|null;selectedBy:string|null;selectedByName:string|null;selectedAt:string|null;selectionFingerprint:string|null;
  completedBy:string|null;completedByName:string|null;completedAt:string|null;executionNotes:string;completionFingerprint:string|null;createdAt:string;updatedAt:string};
type Unit={id:string;assetCode:string;productId:string|null;productName:string;version:string;inventoryStatus:string;assetStatus:string;warehouseId:string|null;
  warehouseCode:string|null;warehouseMarket:string|null;warehouseStatus:string|null;custody:string|null;locationStatus:string|null;certificationId:string|null;
  certificationVersion:number|null;certificationStatus:string|null;finalQc:number|null;grade:string|null;inspectionResult:string|null;
  reservedAllocations:number;activeListings:number;activeTransfers:number;openRmas:number;customerReleases:number;originalOf:number;committedTo:string|null};

const admin=(user:SessionUser)=>user.roles.includes('super_admin');
const norm=(value:string|null)=>(value??'').trim().toLowerCase();
const activeCommitment=`SELECT id FROM rma_replace_executions WHERE replacement_asset_id=? AND status IN ('REPLACEMENT_IN_PROGRESS','REPLACEMENT_COMPLETED')`;
// Friendly 409 for ordinary sale / movement / after-sales / Asset edit routes;
// the 0044 + 0045 triggers remain the authority.
export async function requireNotReplacementCommitted(db:D1Database,assetId:string){
  if(await one(db,activeCommitment,assetId))throw conflict('该设备已锁定为 RMA 替换设备，不能分配订单、Listing、调拨、新建售后工单或修改关键字段。');
}
export const canExecuteReplace=(user:SessionUser)=>admin(user)||can(user,'international-rma-replace:execute');
const canRead=(user:SessionUser)=>canExecuteReplace(user)||can(user,'international-after-sales:read');

async function scopedCase(db:D1Database,user:SessionUser,rmaId:string,write:boolean){
  if(write?!canExecuteReplace(user):!canRead(user))throw forbidden('你没有该 RMA 的更换执行权限。');
  requireWorkspace(user,'ADMIN','INTERNATIONAL','SERVICE','UK_FULFILMENT');
  await requireRmaAccess(db,user,rmaId);
  const row=await one<Case>(db,`SELECT c.id,c.rma_reference AS rmaReference,c.asset_id AS assetId,a.asset_code AS assetCode,c.order_id AS orderId,
    c.sales_account_id AS salesAccountId,c.market_region AS market,c.return_warehouse_id AS warehouse,c.service_stage AS stage,c.status,
    c.cross_border_resolution AS resolution,c.resolution_decided_at AS decidedAt,c.resolution_inspection_id AS inspectionId,
    a.product_id AS productId,a.product_name_snapshot AS productName,a.version_snapshot AS version,a.inventory_status AS inventoryStatus,
    l.custody,l.status AS locationStatus,area.code AS locationCode
    FROM after_sales_cases c JOIN assets a ON a.id=c.asset_id LEFT JOIN asset_locations l ON l.asset_id=a.id LEFT JOIN warehouse_locations area ON area.id=l.location_id
    WHERE c.id=? AND c.return_authorized_at IS NOT NULL`,rmaId);
  if(!row)throw notFound('未找到国际 RMA。');
  await requireOrderAccess(db,user,row.orderId);await requireAssetAccess(db,user,row.assetId);
  if(row.market!=='UK'||row.warehouse!=='wh-uk')throw forbidden('该 RMA 不在允许更换执行的 UK 退货范围内。');
  return row;
}
// Strict replacement-stock scope. Unlike requireAssetAccess (warehouse OR Sales
// Account), the caller must hold the unit's warehouse AND every canonical Sales
// Account affinity the unit carries. Affinity reuses the existing Asset scope
// derivation (listing Sales Account, else the latest allocation's Order), widened
// only to every non-terminal listing; no new ownership notion is introduced.
const affinityAccounts=`SELECT DISTINCT account FROM (
  SELECT m.sales_account_id AS account FROM marketplace_listings m WHERE m.asset_id=?1 AND m.status IN ('draft','active','paused','reserved','sold')
  UNION SELECT o.sales_account_id FROM international_asset_allocations x JOIN orders o ON o.id=x.order_id
   WHERE x.asset_id=?1 AND x.created_at=(SELECT MAX(h.created_at) FROM international_asset_allocations h WHERE h.asset_id=?1)) WHERE account IS NOT NULL`;
async function requireReplacementScope(db:D1Database,user:SessionUser,unit:{id:string;warehouseId:string|null}){
  requireWarehouseScope(user,unit.warehouseId);
  for(const {account} of await all<{account:string}>(db,affinityAccounts,unit.id))requireSalesAccountScope(user,account);
}
const allowedByScope=async(db:D1Database,user:SessionUser,unit:Unit)=>{try{await requireReplacementScope(db,user,unit);return true;}catch{return false;}};
// No canonical product identity on the original unit means compatibility is unprovable.
const modelDataMissing=(row:Case)=>!row.productId||!norm(row.productName)||!norm(row.version);
const modelDataInsufficient=()=>new AppError(409,'MODEL_COMPATIBILITY_DATA_INSUFFICIENT','原设备缺少规范的 product_id / 产品名称 / 版本记录，无法证明替换设备型号兼容；不能执行更换。');
async function execution(db:D1Database,rmaId:string){
  return one<Execution>(db,`SELECT e.id,e.rma_id AS rmaId,e.original_asset_id AS originalAssetId,e.order_id AS orderId,e.resolution_reference AS resolutionReference,
    e.resolution_decided_at AS resolutionDecidedAt,e.inspection_id AS inspectionId,e.status,e.started_by AS startedBy,starter.name AS startedByName,e.started_at AS startedAt,
    e.replacement_asset_id AS replacementAssetId,e.replacement_asset_code AS replacementAssetCode,e.replacement_warehouse_id AS replacementWarehouseId,
    e.replacement_certification_id AS replacementCertificationId,e.replacement_selected_by AS selectedBy,selector.name AS selectedByName,e.replacement_selected_at AS selectedAt,
    e.selection_fingerprint AS selectionFingerprint,e.completed_by AS completedBy,completer.name AS completedByName,e.completed_at AS completedAt,
    e.execution_notes AS executionNotes,e.completion_fingerprint AS completionFingerprint,e.created_at AS createdAt,e.updated_at AS updatedAt
    FROM rma_replace_executions e JOIN users starter ON starter.id=e.started_by LEFT JOIN users selector ON selector.id=e.replacement_selected_by
    LEFT JOIN users completer ON completer.id=e.completed_by WHERE e.rma_id=?`,rmaId);
}
const unitSelect=`SELECT r.id,r.asset_code AS assetCode,r.product_id AS productId,r.product_name_snapshot AS productName,r.version_snapshot AS version,
  r.inventory_status AS inventoryStatus,r.asset_status AS assetStatus,l.warehouse_id AS warehouseId,w.code AS warehouseCode,w.market_region AS warehouseMarket,
  w.status AS warehouseStatus,l.custody,l.status AS locationStatus,cert.id AS certificationId,cert.version AS certificationVersion,
  cert.certification_status AS certificationStatus,cert.final_qc AS finalQc,COALESCE(cert.grade_display,cert.grade) AS grade,cert.inspection_result AS inspectionResult,
  (SELECT COUNT(*) FROM international_asset_allocations x WHERE x.asset_id=r.id AND x.status IN ('reserved','fulfilled')) AS reservedAllocations,
  (SELECT COUNT(*) FROM marketplace_listings m WHERE m.asset_id=r.id AND m.status IN ('draft','active','paused','reserved','sold')) AS activeListings,
  (SELECT COUNT(*) FROM asset_transfers t WHERE t.asset_id=r.id AND t.status IN ('created','shipped')) AS activeTransfers,
  (SELECT COUNT(*) FROM after_sales_cases other WHERE other.asset_id=r.id AND other.status IN ('open','in_progress')) AS openRmas,
  (SELECT COUNT(*) FROM rma_customer_return_releases owned WHERE owned.asset_id=r.id) AS customerReleases,
  (SELECT COUNT(*) FROM rma_replace_executions original WHERE original.original_asset_id=r.id) AS originalOf,
  (SELECT e.rma_id FROM rma_replace_executions e WHERE e.replacement_asset_id=r.id) AS committedTo
  FROM assets r LEFT JOIN asset_locations l ON l.asset_id=r.id LEFT JOIN warehouses w ON w.id=l.warehouse_id
  LEFT JOIN current_asset_certifications cert ON cert.asset_id=r.id`;
// Fails closed. The canonical product_id must be present on both units and equal;
// name and version are additional guards that must be non-empty and agree. They
// never substitute for a missing product_id (there is no SKU/BOM master yet).
function compatible(row:Case,unit:Unit){
  return Boolean(row.productId)&&unit.productId===row.productId&&norm(row.productName)!==''&&norm(unit.productName)===norm(row.productName)
    &&norm(row.version)!==''&&norm(unit.version)===norm(row.version);
}
// Human-readable mirror of trg_rma_replace_select. The trigger remains the authority.
function blockers(row:Case,unit:Unit,rmaId:string,committed:boolean){
  const reasons:string[]=[];
  if(unit.id===row.assetId)reasons.push('不能选择原退回设备本身。');
  if(unit.inventoryStatus!=='NORMAL')reasons.push(`库存状态为 ${unit.inventoryStatus}，不可作为替换设备。`);
  if(['in_service','scrapped','unknown'].includes(unit.assetStatus))reasons.push(`设备状态为 ${unit.assetStatus}。`);
  if(unit.custody!=='WAREHOUSE')reasons.push(`Custody 为 ${unit.custody??'未知'}，不是 WAREHOUSE。`);
  if(unit.warehouseId!=='wh-uk'||unit.warehouseMarket!==row.market||unit.warehouseStatus!=='active')reasons.push('不在 UK 有效实体仓。');
  if(unit.locationStatus!==(committed?'reserved':'on_hand'))reasons.push(`库位状态为 ${unit.locationStatus??'未知'}，${committed?'未保持更换锁定':'不是 on_hand 可用库存'}。`);
  if(unit.certificationStatus!=='certified'||unit.finalQc!==1||unit.grade==='D'||unit.grade==='Parts / Repair'||!['PASS','ADVISORY'].includes(unit.inspectionResult??''))
    reasons.push(`当前最新 Certification 无效（${unit.certificationStatus??'无认证'}）。`);
  if(!compatible(row,unit))reasons.push('产品 / 型号 / 版本与原设备不一致，或任一设备缺少规范 product_id / 名称 / 版本，无法证明兼容。');
  if(unit.reservedAllocations)reasons.push('已被订单预留或已售出。');
  if(unit.activeListings)reasons.push('存在未终止的 Listing。');
  if(unit.activeTransfers)reasons.push('处于调拨中。');
  if(unit.openRmas)reasons.push('存在未关闭的 RMA / 售后工单。');
  if(unit.customerReleases||unit.originalOf)reasons.push('属于客户退回 / 原客户设备。');
  if(unit.committedTo&&unit.committedTo!==rmaId)reasons.push('已被其他 RMA 锁定为替换设备。');
  return reasons;
}
const eligibility=`SELECT c.id FROM after_sales_cases c JOIN rma_return_inspections i ON i.id=c.resolution_inspection_id
  JOIN assets a ON a.id=c.asset_id JOIN asset_locations l ON l.asset_id=a.id JOIN warehouse_locations area ON area.id=l.location_id JOIN orders o ON o.id=c.order_id
  WHERE (c.id=? AND c.asset_id=? AND c.order_id=? AND c.sales_account_id=? AND c.resolution_decided_at=? AND c.resolution_inspection_id=?)
  AND (c.status='in_progress' AND c.cross_border_resolution='REPLACE' AND c.resolution_decided_by IS NOT NULL AND c.outbound_shipped_at IS NULL)
  AND (c.market_region='UK' AND c.return_warehouse_id='wh-uk' AND i.status='INSPECTION_COMPLETED' AND i.rma_id=c.id AND i.asset_id=c.asset_id)
  AND (c.return_shipped_at IS NOT NULL AND c.return_received_at IS NOT NULL AND o.fulfilment_warehouse_id='wh-uk')
  AND (a.inventory_status='QUARANTINED' AND l.custody='WAREHOUSE' AND l.status='returned' AND l.warehouse_id='wh-uk')
  AND (area.warehouse_id='wh-uk' AND area.code='RETURN-QUARANTINE' AND o.status='delivered' AND o.sales_account_id=c.sales_account_id)
  AND (SELECT COUNT(*) FROM international_asset_allocations al WHERE al.order_id=o.id AND al.asset_id=a.id AND al.status='fulfilled')=1
  AND EXISTS (SELECT 1 FROM asset_events e WHERE e.related_service_case_id=c.id AND e.event_type='rma_resolution_decided' AND e.source='international-rma-resolution')`;
const parameters=(row:Case)=>[row.id,row.assetId,row.orderId,row.salesAccountId,row.decidedAt,row.inspectionId];
const stageGuard=(stage:string)=>`${eligibility} AND c.service_stage='${stage}'`;
function caseGuard(db:D1Database,row:Case,stage:string){return db.prepare(`SELECT CASE WHEN EXISTS(${stageGuard(stage)}) THEN 1 ELSE json('Replacement state changed') END`).bind(...parameters(row));}

async function replacementUnit(db:D1Database,user:SessionUser,code:string){
  const unit=await one<Unit>(db,`${unitSelect} WHERE UPPER(r.asset_code)=UPPER(?)`,code);
  if(!unit)throw notFound('未找到该替换设备 Asset Code。');
  // Access to the RMA never implies access to any replacement stock: check the unit's own strict scope.
  await requireReplacementScope(db,user,unit);
  return unit;
}
function unitDto(unit:Unit){return {assetId:unit.id,assetCode:unit.assetCode,productName:unit.productName,version:unit.version,warehouseCode:unit.warehouseCode,
  custody:unit.custody,locationStatus:unit.locationStatus,inventoryStatus:unit.inventoryStatus,
  certification:unit.certificationId?{version:unit.certificationVersion,status:unit.certificationStatus,grade:unit.grade}:null};}
function publicExecution(e:Execution){const {selectionFingerprint:_s,completionFingerprint:_c,...record}=e;void _s;void _c;return record;}

// Every SQL-expressible eligibility and scope condition is applied before LIMIT,
// so an eligible unit is never hidden behind ineligible ones. The rows are then
// re-checked with the same blockers and the same strict scope as the manual
// Asset Code path.
async function candidateUnits(db:D1Database,user:SessionUser,row:Case){
  const global=hasGlobalInternationalAccess(user);
  if(!global&&!workspaceScopeIds(user,'warehouseIds').includes('wh-uk'))return [];
  const accounts=global?[]:workspaceScopeIds(user,'salesAccountIds');
  const foreignAffinity=global?'':`AND NOT EXISTS(SELECT 1 FROM international_asset_allocations x JOIN orders o ON o.id=x.order_id
    WHERE x.asset_id=r.id AND x.created_at=(SELECT MAX(h.created_at) FROM international_asset_allocations h WHERE h.asset_id=r.id)
    AND o.sales_account_id IS NOT NULL ${accounts.length?`AND o.sales_account_id NOT IN (${accounts.map(()=>'?').join(',')})`:''})`;
  const units=await all<Unit>(db,`${unitSelect} WHERE (l.warehouse_id='wh-uk' AND l.custody='WAREHOUSE' AND l.status='on_hand' AND w.status='active' AND w.market_region=?)
    AND (r.inventory_status='NORMAL' AND r.asset_status NOT IN ('in_service','scrapped','unknown') AND r.id<>?)
    AND (r.product_id=? AND lower(trim(r.product_name_snapshot))=lower(trim(?)) AND lower(trim(r.version_snapshot))=lower(trim(?)))
    AND (cert.certification_status='certified' AND cert.final_qc=1 AND cert.grade<>'D' AND cert.inspection_result IN ('PASS','ADVISORY'))
    AND NOT EXISTS(SELECT 1 FROM international_asset_allocations x WHERE x.asset_id=r.id AND x.status IN ('reserved','fulfilled'))
    AND NOT EXISTS(SELECT 1 FROM marketplace_listings m WHERE m.asset_id=r.id AND m.status IN ('draft','active','paused','reserved','sold'))
    AND NOT EXISTS(SELECT 1 FROM asset_transfers t WHERE t.asset_id=r.id AND t.status IN ('created','shipped'))
    AND NOT EXISTS(SELECT 1 FROM after_sales_cases other WHERE other.asset_id=r.id AND other.status IN ('open','in_progress'))
    AND NOT EXISTS(SELECT 1 FROM rma_customer_return_releases owned WHERE owned.asset_id=r.id)
    AND NOT EXISTS(SELECT 1 FROM rma_replace_executions e WHERE e.original_asset_id=r.id OR e.replacement_asset_id=r.id)
    ${foreignAffinity} ORDER BY r.asset_code LIMIT 50`,row.market,row.assetId,row.productId,row.productName,row.version,...accounts);
  const allowed=await Promise.all(units.map(unit=>allowedByScope(db,user,unit)));
  return units.filter((unit,index)=>allowed[index]&&!blockers(row,unit,row.id,false).length).map(unitDto);
}

export async function replacementDetail(db:D1Database,user:SessionUser,rmaId:string){
  const row=await scopedCase(db,user,rmaId,false);const e=await execution(db,rmaId);
  const replacement=e?.replacementAssetId?await one<Unit>(db,`${unitSelect} WHERE r.id=?`,e.replacementAssetId):null;
  // RMA scope never implies replacement-stock scope: a bound replacement unit is
  // re-checked with the strict replacement rule before any of its data is returned.
  if(replacement)await requireReplacementScope(db,user,replacement);
  const stage=e?e.status:'RESOLUTION_DECIDED',modelMissing=modelDataMissing(row);
  const eligible=row.resolution==='REPLACE'&&!modelMissing&&(!e||e.status==='REPLACEMENT_IN_PROGRESS')&&Boolean(await one(db,stageGuard(e?'REPLACEMENT_IN_PROGRESS':'RESOLUTION_DECIDED'),...parameters(row)));
  const replacementBlockers=replacement&&e?.status==='REPLACEMENT_IN_PROGRESS'?blockers(row,replacement,row.id,true):[];
  const executor=canExecuteReplace(user);
  const candidates=executor&&eligible&&e&&!e.replacementAssetId?await candidateUnits(db,user,row):[];
  return {resolutionType:row.resolution,executionStatus:e?.status??'NOT_STARTED',blockerCode:row.resolution==='REPLACE'&&modelMissing?'MODEL_COMPATIBILITY_DATA_INSUFFICIENT':null,
    originalAsset:{assetId:row.assetId,assetCode:row.assetCode,productName:row.productName,version:row.version,inventoryStatus:row.inventoryStatus,custody:row.custody,locationStatus:row.locationStatus,locationCode:row.locationCode},
    execution:e?publicExecution(e):null,replacementAsset:replacement?{...unitDto(replacement),committed:replacement.committedTo===row.id,blockers:replacementBlockers}:null,candidates,
    canStart:!e&&eligible&&executor,canSelect:Boolean(e&&e.status==='REPLACEMENT_IN_PROGRESS'&&!e.replacementAssetId&&eligible&&executor),
    canComplete:Boolean(e&&e.status==='REPLACEMENT_IN_PROGRESS'&&e.replacementAssetId&&eligible&&!replacementBlockers.length&&executor),
    shipmentPending:e?.status==='REPLACEMENT_COMPLETED',rmaOpen:['open','in_progress'].includes(row.status),warrantyChanged:false,
    eligibilityReason:e?.status==='REPLACEMENT_COMPLETED'?'Replacement prepared — shipment pending。原设备仍隔离，RMA 未关闭，保修未改变。'
      :row.resolution==='REPLACE'&&modelMissing?'MODEL_COMPATIBILITY_DATA_INSUFFICIENT：原设备缺少规范的 product_id / 产品名称 / 版本记录，无法证明替换设备型号兼容。'
      :eligible?'仅执行已批准的 REPLACE；替换设备是独立 Asset，原设备保持 UK 隔离。'
      :`当前阶段 ${stage} 不允许更换执行：需要已批准的 REPLACE、正式完成的检测且原设备仍在 UK Return Quarantine。`};
}
// Asset lifecycle metadata carries structured references only. Free-text notes
// (auditOnly) stay in the protected execution record and the audit log.
function records(db:D1Database,user:SessionUser,row:Case,e:{id:string;startedAt:string},event:string,now:string,requestId:string,extra:Record<string,unknown>={},replacementAssetId?:string,auditOnly:Record<string,unknown>={}){
  const metadata={rma_id:row.id,rma_reference:row.rmaReference,original_asset_id:row.assetId,resolution_type:'REPLACE',resolution_reference:row.id,
    replace_execution_id:e.id,started_at:e.startedAt,...extra};
  const titles:Record<string,string>={replacement_execution_started:'已批准的更换开始执行，原设备保持隔离',
    replacement_asset_committed:'替换设备已锁定（独立 Asset，尚未发货）',replacement_execution_completed:'更换准备完成，等待发货；未发货、未送达'};
  const insert=(assetId:string,orderId:string|null,role:string)=>db.prepare(`INSERT INTO asset_events(id,asset_id,event_type,occurred_at,title,related_order_id,related_service_case_id,operator_user_id,visibility,source,new_value_json)
    VALUES(?,?,?,?,?,?,?,?,'admin_private','international-rma-replace',?)`).bind(id(),assetId,event,now,titles[event],orderId,row.id,user.id,JSON.stringify({...metadata,asset_role:role}));
  // The replacement unit was never part of the original Order, so its events carry no order link.
  return [insert(row.assetId,row.orderId,'ORIGINAL'),...(replacementAssetId?[insert(replacementAssetId,null,'REPLACEMENT')]:[]),
    db.prepare(`INSERT INTO audit_logs(id,actor_id,action,entity_type,entity_id,request_id,after_json) VALUES(?,?,?,'after_sales_case',?,?,?)`)
      .bind(id(),user.id,`international.rma.${event}`,row.id,requestId,JSON.stringify({...metadata,...auditOnly,execution_authority:admin(user)?'administrator':'international-rma-replace:execute'}))];
}
function recoverable(error:unknown){return error instanceof Error&&/malformed JSON|Replacement state changed|UNIQUE constraint failed|Invalid replacement|Replacement reservation failed|Replacement execution is immutable|committed as an RMA replacement/i.test(error.message);}

export async function startReplacement(db:D1Database,user:SessionUser,rmaId:string,requestId:string){
  const row=await scopedCase(db,user,rmaId,true);const existing=await execution(db,rmaId);
  if(existing){if(existing.status==='REPLACEMENT_IN_PROGRESS')return replacementDetail(db,user,rmaId);throw conflict('更换执行已完成，不能重新开始。');}
  if(row.resolution!=='REPLACE')throw conflict('只有已批准 REPLACE 的 RMA 可以开始更换执行。');
  if(modelDataMissing(row))throw modelDataInsufficient();
  const now=new Date().toISOString(),executionId=id();
  try{await db.batch([caseGuard(db,row,'RESOLUTION_DECIDED'),
    db.prepare(`INSERT INTO rma_replace_executions(id,rma_id,original_asset_id,order_id,resolution_reference,resolution_decided_at,inspection_id,status,started_by,started_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'REPLACEMENT_IN_PROGRESS',?,?,?,?)`).bind(executionId,row.id,row.assetId,row.orderId,row.id,row.decidedAt,row.inspectionId,user.id,now,now,now),
    db.prepare(`UPDATE after_sales_cases SET service_stage='REPLACEMENT_IN_PROGRESS',updated_at=?,updated_by=? WHERE id=? AND service_stage='RESOLUTION_DECIDED'`).bind(now,user.id,row.id),
    ...records(db,user,row,{id:executionId,startedAt:now},'replacement_execution_started',now,requestId,{execution_status:'REPLACEMENT_IN_PROGRESS'})
  ]);}catch(error){if(recoverable(error)){const current=await execution(db,rmaId);if(current?.status==='REPLACEMENT_IN_PROGRESS')return replacementDetail(db,user,rmaId);
    throw conflict('不能开始更换：需要正式批准的 REPLACE，且原设备必须仍在 UK Return Quarantine。');}throw error;}
  return replacementDetail(db,user,rmaId);
}

export async function selectReplacement(db:D1Database,user:SessionUser,rmaId:string,input:SelectInput,requestId:string){
  const row=await scopedCase(db,user,rmaId,true);const e=await execution(db,rmaId);
  if(!e)throw conflict('请先开始更换执行，再选择替换设备。');
  const unit=await replacementUnit(db,user,input.replacementAssetCode);
  const fingerprint=await hashIdentifier(JSON.stringify({replacementAssetId:unit.id}));
  const repeated=(current:Execution)=>{if(!current.replacementAssetId)return false;
    if(current.replacementAssetId!==unit.id)throw conflict('本 RMA 已锁定其他替换设备；不能更换为不同设备。');return true;};
  if(repeated(e))return replacementDetail(db,user,rmaId);
  if(e.status!=='REPLACEMENT_IN_PROGRESS')throw conflict('更换执行已完成，不能再选择替换设备。');
  if(modelDataMissing(row))throw modelDataInsufficient();
  const reasons=blockers(row,unit,row.id,false);if(reasons.length)throw conflict(`替换设备不符合条件：${reasons.join(' ')}`);
  const now=new Date().toISOString();
  try{await db.batch([caseGuard(db,row,'REPLACEMENT_IN_PROGRESS'),
    // The 0045 triggers re-validate the unit and reserve its location (on_hand ->
    // reserved) as part of this same write, or abort it; the unique index
    // prevents a second execution from committing the same unit.
    db.prepare(`UPDATE rma_replace_executions SET replacement_asset_id=?,replacement_asset_code=?,replacement_warehouse_id=?,replacement_certification_id=?,
      replacement_selected_by=?,replacement_selected_at=?,selection_fingerprint=?,updated_at=? WHERE id=? AND status='REPLACEMENT_IN_PROGRESS' AND replacement_asset_id IS NULL`)
      .bind(unit.id,unit.assetCode,unit.warehouseId,unit.certificationId,user.id,now,fingerprint,now,e.id),
    db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM rma_replace_executions e JOIN asset_locations l ON l.asset_id=e.replacement_asset_id
      WHERE e.id=? AND e.replacement_asset_id=? AND e.replacement_selected_at=? AND l.status='reserved') THEN 1 ELSE json('Replacement state changed') END`).bind(e.id,unit.id,now),
    ...records(db,user,row,e,'replacement_asset_committed',now,requestId,{replacement_asset_id:unit.id,replacement_asset_code:unit.assetCode,
      replacement_certification_id:unit.certificationId,replacement_certification_version:unit.certificationVersion,selected_at:now},unit.id)
  ]);}catch(error){if(recoverable(error)){const current=await execution(db,rmaId);if(current&&repeated(current))return replacementDetail(db,user,rmaId);
    throw conflict('替换设备已被其他流程占用或状态已变化；未锁定任何设备，请刷新后重新选择。');}throw error;}
  return replacementDetail(db,user,rmaId);
}

export async function completeReplacement(db:D1Database,user:SessionUser,rmaId:string,input:CompleteInput,requestId:string){
  const row=await scopedCase(db,user,rmaId,true);const e=await execution(db,rmaId);
  if(!e)throw conflict('更换执行尚未开始，不能直接完成。');
  if(!e.replacementAssetId||!e.replacementAssetCode)throw conflict('尚未锁定替换设备，不能完成更换执行。');
  if(input.replacementAssetCode.toUpperCase()!==e.replacementAssetCode.toUpperCase())throw conflict('确认的替换设备与已锁定设备不一致。');
  const fingerprint=await hashIdentifier(JSON.stringify({replacementAssetId:e.replacementAssetId,executionNotes:input.executionNotes}));
  const repeated=(current:Execution)=>{if(current.status!=='REPLACEMENT_COMPLETED')return false;
    if(current.completionFingerprint!==fingerprint)throw conflict('更换执行已完成且不可修改；不同提交内容不能覆盖原结果。');return true;};
  // Replacement scope is enforced before any idempotent response.
  const unit=await replacementUnit(db,user,e.replacementAssetCode);
  if(repeated(e))return replacementDetail(db,user,rmaId);
  const reasons=blockers(row,unit,row.id,true);if(reasons.length)throw conflict(`替换设备已不再符合条件，不能完成：${reasons.join(' ')}`);
  const now=new Date().toISOString();
  try{await db.batch([caseGuard(db,row,'REPLACEMENT_IN_PROGRESS'),
    db.prepare(`UPDATE rma_replace_executions SET status='REPLACEMENT_COMPLETED',completed_by=?,completed_at=?,execution_notes=?,completion_fingerprint=?,updated_at=?
      WHERE id=? AND status='REPLACEMENT_IN_PROGRESS' AND replacement_asset_id=?`).bind(user.id,now,input.executionNotes,fingerprint,now,e.id,e.replacementAssetId),
    db.prepare(`UPDATE after_sales_cases SET service_stage='REPLACEMENT_COMPLETED',updated_at=?,updated_by=? WHERE id=? AND service_stage='REPLACEMENT_IN_PROGRESS'`).bind(now,user.id,row.id),
    db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM rma_replace_executions WHERE id=? AND status='REPLACEMENT_COMPLETED' AND completed_at=?) THEN 1 ELSE json('Replacement state changed') END`).bind(e.id,now),
    ...records(db,user,row,e,'replacement_execution_completed',now,requestId,{replacement_asset_id:e.replacementAssetId,replacement_asset_code:e.replacementAssetCode,
      completed_at:now,execution_status:'REPLACEMENT_COMPLETED',shipment:'NOT_CREATED'},e.replacementAssetId,{execution_notes:input.executionNotes})
  ]);}catch(error){if(recoverable(error)){const current=await execution(db,rmaId);if(current&&repeated(current))return replacementDetail(db,user,rmaId);
    throw conflict('替换设备或 RMA 状态已变化，不能完成更换；不会自动换用其他设备。');}throw error;}
  return replacementDetail(db,user,rmaId);
}
