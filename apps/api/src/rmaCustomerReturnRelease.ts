import { can,conflict,forbidden,notFound,requireWorkspace,type SessionUser } from '@maxcine/shared';
import { z } from 'zod';
import { hashIdentifier } from './auth';
import { id,one } from './db';
import { requireAssetAccess,requireOrderAccess,requireRmaAccess } from './internationalAuthorization';
import { operationalState } from './rmaOperationalState';

export const customerReturnReleaseSchema=z.object({reason:z.string().trim().min(1).max(1000)}).strict();
type Input=z.infer<typeof customerReturnReleaseSchema>;
type Context={id:string;rmaReference:string;assetId:string;assetCode:string;orderId:string;orderReference:string;salesAccountId:string|null;
  market:string;warehouse:string;status:string;stage:string;resolution:string|null;outboundShippedAt:string|null;
  repairId:string|null;repairStatus:string|null;inspectionId:string|null;inspectionStatus:string|null;decisionId:string|null;decision:string|null;
  certificationId:string|null;certificationVersion:number|null;certificationStatus:string|null;inventoryStatus:string;custody:string|null;
  locationStatus:string|null;locationCode:string|null;warehouseCode:string|null};
type Release={id:string;rmaId:string;assetId:string;orderId:string;repairId:string;inspectionId:string;decisionId:string;certificationId:string;
  certificationVersion:number;purpose:string;reason:string;releasedBy:string;releasedByName:string;releasedAt:string;fingerprint:string};

const admin=(user:SessionUser)=>user.roles.includes('super_admin');
export const canReleaseCustomerReturn=(user:SessionUser)=>admin(user)||can(user,'international-customer-return:release');
const canRead=(user:SessionUser)=>canReleaseCustomerReturn(user)||can(user,'data:read:all')||can(user,'international-after-sales:read');

const eligibility=`SELECT c.id FROM after_sales_cases c
 JOIN rma_repair_executions repair ON repair.rma_id=c.id
 JOIN rma_post_repair_inspections inspection ON inspection.rma_id=c.id
 JOIN rma_recertification_decisions decision ON decision.rma_id=c.id
 JOIN current_asset_certifications cert ON cert.asset_id=c.asset_id
 JOIN assets a ON a.id=c.asset_id JOIN asset_locations location ON location.asset_id=a.id
 JOIN warehouse_locations area ON area.id=location.location_id JOIN warehouses warehouse ON warehouse.id=location.warehouse_id
 JOIN orders original_order ON original_order.id=c.order_id
 WHERE (c.id=? AND c.status='in_progress' AND c.service_stage='REPAIR_COMPLETED' AND c.cross_border_resolution='REPAIR')
 AND (c.market_region='UK' AND c.return_warehouse_id='wh-uk' AND c.return_shipped_at IS NOT NULL AND c.return_received_at IS NOT NULL AND c.outbound_shipped_at IS NULL)
 AND (repair.status='REPAIR_COMPLETED' AND repair.asset_id=c.asset_id AND repair.order_id=c.order_id AND repair.completed_at IS NOT NULL AND repair.submission_fingerprint IS NOT NULL
      AND repair.resolution_decided_at=c.resolution_decided_at AND repair.inspection_id=c.resolution_inspection_id)
 AND (inspection.status='COMPLETED' AND inspection.asset_id=c.asset_id AND inspection.repair_execution_id=repair.id AND inspection.completed_at IS NOT NULL AND inspection.completion_fingerprint IS NOT NULL)
 AND (decision.inspection_id=inspection.id AND decision.asset_id=c.asset_id AND decision.decision='APPROVED' AND decision.certification_id=cert.id)
 AND (cert.purpose='POST_REPAIR_RECERTIFICATION' AND cert.post_repair_inspection_id=inspection.id AND cert.certification_status='certified' AND cert.final_qc=1 AND cert.inspection_result='PASS')
 AND (a.inventory_status='QUARANTINED' AND location.warehouse_id='wh-uk' AND location.custody='WAREHOUSE' AND location.status='returned')
 AND (area.warehouse_id='wh-uk' AND area.code='RETURN-QUARANTINE' AND warehouse.status='active' AND warehouse.market_region='UK')
 AND (original_order.status='delivered' AND original_order.sales_account_id=c.sales_account_id AND original_order.fulfilment_warehouse_id='wh-uk')
 AND (SELECT COUNT(*) FROM international_asset_allocations allocation WHERE allocation.order_id=c.order_id AND allocation.asset_id=a.id AND allocation.status='fulfilled')=1
 AND NOT EXISTS(SELECT 1 FROM international_asset_allocations allocation WHERE allocation.asset_id=a.id AND allocation.status='reserved')
 AND NOT EXISTS(SELECT 1 FROM asset_transfers transfer WHERE transfer.asset_id=a.id AND transfer.status IN ('created','shipped'))
 AND NOT EXISTS(SELECT 1 FROM after_sales_cases other WHERE other.asset_id=a.id AND other.id<>c.id AND other.status IN ('open','in_progress'))
 AND EXISTS(SELECT 1 FROM asset_events event WHERE event.related_service_case_id=c.id AND event.event_type='repair_completed' AND event.source='international-rma-repair')
 AND EXISTS(SELECT 1 FROM asset_events event WHERE event.related_service_case_id=c.id AND event.event_type='post_repair_reinspection_completed' AND event.source='post-repair-recertification')
 AND EXISTS(SELECT 1 FROM asset_events event WHERE event.related_service_case_id=c.id AND event.event_type='recertification_approved' AND event.source='post-repair-recertification')`;

async function scoped(db:D1Database,user:SessionUser,rmaId:string,write:boolean){
  if(write?!canReleaseCustomerReturn(user):!canRead(user))throw forbidden('你没有该 RMA 的原客户返还授权权限。');
  requireWorkspace(user,'ADMIN','INTERNATIONAL','SERVICE','UK_FULFILMENT');
  await requireRmaAccess(db,user,rmaId);
  const row=await one<Context>(db,`SELECT c.id,c.rma_reference AS rmaReference,c.asset_id AS assetId,a.asset_code AS assetCode,c.order_id AS orderId,o.order_no AS orderReference,
   c.sales_account_id AS salesAccountId,c.market_region AS market,c.return_warehouse_id AS warehouse,c.status,c.service_stage AS stage,c.cross_border_resolution AS resolution,
   c.outbound_shipped_at AS outboundShippedAt,repair.id AS repairId,repair.status AS repairStatus,inspection.id AS inspectionId,inspection.status AS inspectionStatus,
   decision.id AS decisionId,decision.decision,cert.id AS certificationId,cert.version AS certificationVersion,cert.certification_status AS certificationStatus,
   a.inventory_status AS inventoryStatus,location.custody,location.status AS locationStatus,area.code AS locationCode,w.code AS warehouseCode
   FROM after_sales_cases c JOIN assets a ON a.id=c.asset_id JOIN orders o ON o.id=c.order_id
   LEFT JOIN rma_repair_executions repair ON repair.rma_id=c.id LEFT JOIN rma_post_repair_inspections inspection ON inspection.rma_id=c.id
   LEFT JOIN rma_recertification_decisions decision ON decision.rma_id=c.id LEFT JOIN current_asset_certifications cert ON cert.asset_id=c.asset_id
   LEFT JOIN asset_locations location ON location.asset_id=a.id LEFT JOIN warehouse_locations area ON area.id=location.location_id LEFT JOIN warehouses w ON w.id=location.warehouse_id
   WHERE c.id=? AND c.return_authorized_at IS NOT NULL`,rmaId);
  if(!row)throw notFound('未找到国际 RMA。');
  await requireOrderAccess(db,user,row.orderId);await requireAssetAccess(db,user,row.assetId);
  if(row.market!=='UK'||row.warehouse!=='wh-uk')throw forbidden('该 RMA 不在允许授权原客户返还的 UK Scope 内。');
  return row;
}

async function release(db:D1Database,rmaId:string){return one<Release>(db,`SELECT release.id,release.rma_id AS rmaId,release.asset_id AS assetId,release.order_id AS orderId,
 release.repair_execution_id AS repairId,release.post_repair_inspection_id AS inspectionId,release.recertification_decision_id AS decisionId,
 release.certification_id AS certificationId,release.certification_version AS certificationVersion,release.purpose,release.release_reason AS reason,
 release.released_by AS releasedBy,u.name AS releasedByName,release.released_at AS releasedAt,release.request_fingerprint AS fingerprint
 FROM rma_customer_return_releases release JOIN users u ON u.id=release.released_by WHERE release.rma_id=?`,rmaId);}

function publicRelease(record:Release|null){if(!record)return null;const {fingerprint:_fingerprint,...value}=record;void _fingerprint;return value;}
function blocking(row:Context,eligible:boolean){
  if(eligible)return null;
  if(!['open','in_progress'].includes(row.status))return 'RMA 已关闭。';
  if(row.resolution!=='REPAIR'||row.repairStatus!=='REPAIR_COMPLETED')return '必须先完成正式 REPAIR Execution。';
  if(row.inspectionStatus!=='COMPLETED')return '维修后复检尚未完成。';
  if(row.decision!=='APPROVED')return '维修后再认证尚未批准。';
  if(row.certificationStatus!=='certified')return '当前最新 Certification 不是有效 certified 状态。';
  if(row.outboundShippedAt)return '设备已记录售后发运，不能重复授权。';
  if(row.inventoryStatus!=='QUARANTINED'||row.custody!=='WAREHOUSE'||row.locationStatus!=='returned'||row.warehouseCode!=='UK'||row.locationCode!=='RETURN-QUARANTINE')return 'Asset 必须保持在 UK Return Quarantine。';
  return 'RMA、订单、Allocation、Transfer 或正式 Lifecycle 状态不满足返还授权条件。';
}

// A release is a historical fact. Whether it still holds is recomputed from the
// current canonical chain on every read; a later Shipment must still re-validate.
function releaseValidity(row:Context,record:Release|null,eligible:boolean){
  if(!record)return {releaseCurrentlyValid:null,releaseBlockingReason:null};
  if(record.certificationId!==row.certificationId)return {releaseCurrentlyValid:false,releaseBlockingReason:'当前最新 Certification 已不是该返还授权引用的版本。'};
  if(!eligible)return {releaseCurrentlyValid:false,releaseBlockingReason:blocking(row,false)};
  return {releaseCurrentlyValid:true,releaseBlockingReason:null};
}

export async function customerReturnReleaseDetail(db:D1Database,user:SessionUser,rmaId:string){
  const row=await scoped(db,user,rmaId,false),existing=await release(db,rmaId),eligible=Boolean(await one(db,eligibility,rmaId));
  const state=await operationalState(db,rmaId);
  return {state:existing?'CUSTOMER_RETURN_RELEASED':'NOT_RELEASED',release:publicRelease(existing),...releaseValidity(row,existing,eligible),
    canRelease:!existing&&eligible&&canReleaseCustomerReturn(user),eligible,
    blockingReason:existing?null:blocking(row,eligible),assetCode:row.assetCode,orderReference:row.orderReference,resolution:row.resolution,
    repairStatus:row.repairStatus,reinspectionStatus:row.inspectionStatus,certification:row.certificationId?{id:row.certificationId,version:row.certificationVersion,status:row.certificationStatus}:null,
    inventory:{warehouse:row.warehouseCode,custody:row.custody,inventoryStatus:row.inventoryStatus,locationStatus:row.locationStatus,locationCode:row.locationCode,sellable:state?.sellable??false},rmaOpen:['open','in_progress'].includes(row.status)};
}

export async function createCustomerReturnRelease(db:D1Database,user:SessionUser,rmaId:string,input:Input,requestId:string){
  const row=await scoped(db,user,rmaId,true),normalized={reason:input.reason.trim()},fingerprint=await hashIdentifier(JSON.stringify(normalized));
  const repeated=(record:Release)=>{if(record.fingerprint!==fingerprint)throw conflict('原客户返还授权已锁定，不同理由或内容不能覆盖。');};
  const existing=await release(db,rmaId);if(existing){repeated(existing);return customerReturnReleaseDetail(db,user,rmaId);}
  const eligible=await one<{repairId:string;inspectionId:string;decisionId:string;certificationId:string;certificationVersion:number}>(db,
   `SELECT repair.id AS repairId,inspection.id AS inspectionId,decision.id AS decisionId,cert.id AS certificationId,cert.version AS certificationVersion
    FROM (${eligibility}) eligible JOIN after_sales_cases c ON c.id=eligible.id JOIN rma_repair_executions repair ON repair.rma_id=c.id
    JOIN rma_post_repair_inspections inspection ON inspection.rma_id=c.id JOIN rma_recertification_decisions decision ON decision.rma_id=c.id
    JOIN current_asset_certifications cert ON cert.id=decision.certification_id`,rmaId);
  if(!eligible)throw conflict(blocking(row,false)||'当前状态不满足原客户返还授权条件。');
  const releaseId=id(),now=new Date().toISOString();
  const metadata={rma_id:row.id,rma_reference:row.rmaReference,asset_id:row.assetId,order_id:row.orderId,release_id:releaseId,purpose:'CUSTOMER_RETURN',
    repair_execution_id:eligible.repairId,post_repair_inspection_id:eligible.inspectionId,recertification_decision_id:eligible.decisionId,
    certification_id:eligible.certificationId,certification_version:eligible.certificationVersion,released_by:user.id,released_at:now,inventory_status:'QUARANTINED'};
  try{await db.batch([
    db.prepare(`SELECT CASE WHEN EXISTS(${eligibility}) AND NOT EXISTS(SELECT 1 FROM rma_customer_return_releases WHERE rma_id=?) THEN 1 ELSE json('Customer return release state changed') END`).bind(rmaId,rmaId),
    db.prepare(`INSERT INTO rma_customer_return_releases(id,rma_id,asset_id,order_id,repair_execution_id,post_repair_inspection_id,recertification_decision_id,certification_id,certification_version,purpose,release_reason,released_by,released_at,request_fingerprint,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,'CUSTOMER_RETURN',?,?,?,?,?)`).bind(releaseId,row.id,row.assetId,row.orderId,eligible.repairId,eligible.inspectionId,eligible.decisionId,eligible.certificationId,eligible.certificationVersion,normalized.reason,user.id,now,fingerprint,now),
    db.prepare(`INSERT INTO asset_events(id,asset_id,event_type,occurred_at,title,related_order_id,related_service_case_id,operator_user_id,visibility,source,new_value_json)
      VALUES(?,?, 'customer_return_released',?,'Customer return released',?,?,?,'admin_private','international-customer-return-release',?)`)
      .bind(id(),row.assetId,now,row.orderId,row.id,user.id,JSON.stringify(metadata)),
    db.prepare(`INSERT INTO audit_logs(id,actor_id,action,entity_type,entity_id,request_id,after_json) VALUES(?,?,'international.rma.customer_return_release','rma_customer_return_release',?,?,?)`)
      .bind(id(),user.id,releaseId,requestId,JSON.stringify({...metadata,release_reason:normalized.reason}))
  ]);}catch(error){
    if(error instanceof Error&&/Customer return release|UNIQUE constraint failed|Invalid customer return release|immutable|malformed JSON/i.test(error.message)){
      const current=await release(db,rmaId);if(current){repeated(current);return customerReturnReleaseDetail(db,user,rmaId);}
      throw conflict('RMA、认证或隔离状态已变化，不能授权返还原客户。');
    }
    throw error;
  }
  return customerReturnReleaseDetail(db,user,rmaId);
}
