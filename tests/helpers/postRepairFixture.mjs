import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Buffer,File } from 'node:buffer';
import { deliveryFixture } from './deliveryFixture.mjs';
export const assetId='43000000-0000-4000-8000-000000000099',assetCode='MC-26-TEST-000099',sn='STG-POST-REPAIR-000099';
export const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5XcAAAAASUVORK5CYII=','base64');
export const items=['IDENTITY','EXTERIOR','DISPLAY','LENS_CAMERA','POWER','FUNCTIONAL','REPAIRED_FUNCTION','ACCESSORIES','FINAL_QC'];
const {FormData}=globalThis;
export async function postRepairFixture({resolution='REPAIR',repair='completed'}={}){
 const objects=new Map(),assets={async put(key,value){objects.set(key,value);},async get(key){return objects.has(key)?{body:objects.get(key)}:null;},async delete(key){objects.delete(key);}};
 const f=await deliveryFixture({assets});f.sqlite.prepare('UPDATE assets SET original_sn=?,current_sn=? WHERE id=?').run(sn,sn,assetId);f.certify();await f.ship();assert.equal((await f.deliver()).status,200);
 const rma=(await (await f.request('uk','/international/rmas',{assetId,orderId:'order-test',reason:'DEFECTIVE',returnWarehouseId:'wh-uk'})).json()).rma,base=`/international/rmas/${rma.id}`;
 assert.equal((await f.request('uk',`${base}/return-shipment`,{carrier:'Royal Mail',returnTracking:'STG-POST-REPAIR'})).status,200);
 assert.equal((await f.request('uk',`${base}/receive-return`,{assetCode})).status,200);
 const original=(await(await f.request('uk',`${base}/inspection/start`,{assetCode})).json()).inspection;
 const form=new FormData();form.set('category','OVERALL_CONDITION');form.set('file',new File([png],'synthetic-return.png',{type:'image/png'}));assert.equal((await f.request('uk',`${base}/inspection/evidence`,form)).status,201);
 assert.equal((await f.request('uk',`${base}/inspection/complete`,{assetCode,observedSn:sn,snVerification:'MATCH',checklist:['IDENTITY','EXTERIOR','DISPLAY','LENS_CAMERA','POWER','FUNCTIONAL','ACCESSORIES','RETURN_REASON'].map(item=>({item,result:'PASS',notes:'Synthetic return facts'})),findings:{issueReproduced:'YES',conditionAssessment:'FUNCTIONAL_DEFECT',inspectorNotes:'Synthetic only; not physical inspection'}})).status,200);
 assert.equal((await f.request('admin',`${base}/resolution`,{inspectionId:original.id,resolutionType:resolution,decisionReason:'Synthetic decision; no actual repair',decisionNotes:''})).status,200);
 if(resolution==='REPAIR'&&repair!=='not_started'){
  assert.equal((await f.request('admin',`${base}/repair/start`,{})).status,200);
  if(repair==='completed')assert.equal((await f.request('admin',`${base}/repair/complete`,{repairSummary:'Synthetic repair record only',workPerformed:'Simulated work, no physical repair',postRepairCheck:'PASS'})).status,200);
 }
 const input={assetCode,observedSn:sn,snVerification:'MATCH',grade:'A',checklist:items.map(item=>({item,result:'PASS',notes:'Synthetic Staging quality fact; no physical inspection'})),findings:{issueRemains:'NO',functionalCondition:'GOOD',inspectorNotes:'Synthetic Staging post-repair recertification acceptance record. No physical device inspection represented.'}};
 const detail=(user='admin')=>f.request(user,`${base}/post-repair-inspection`);
 const data=async(user='admin')=>{const response=await detail(user);assert.equal(response.status,200);return response.json();};
 const start=(user='admin',code=assetCode)=>f.request(user,`${base}/post-repair-inspection/start`,{assetCode:code});
 const save=(user='admin',payload=input)=>f.request(user,`${base}/post-repair-inspection`,payload,'PATCH');
 const complete=(user='admin',payload=input)=>f.request(user,`${base}/post-repair-inspection/complete`,payload);
 const upload=(user='admin',category='OVERALL_CONDITION',bytes=png)=>{const form=new FormData();form.set('category',category);form.set('file',new File([bytes],'synthetic-post-repair.png',{type:'image/png'}));return f.request(user,`${base}/post-repair-inspection/evidence`,form);};
 const decide=async(outcome='APPROVED',user='admin',extra={})=>f.request(user,`${base}/recertification-decision`,{inspectionId:(await data()).inspection?.id??crypto.randomUUID(),decision:outcome,reason:'Synthetic explicit decision only; keep quarantine',notes:'No inventory release',...extra});
 const inspected=async()=>{assert.equal((await start()).status,200);assert.equal((await save()).status,200);assert.equal((await upload()).status,201);assert.equal((await complete()).status,200);};
 const grant=(user,role='inspector')=>f.sqlite.prepare('INSERT OR IGNORE INTO user_roles(user_id,role_id) VALUES(?,?)').run(user,role==='inspector'?'role-post-repair-inspector':'role-post-repair-certifier');
 return {...f,rma,base,objects,input,detail,data,start,save,complete,upload,decide,inspected,grant};
}
