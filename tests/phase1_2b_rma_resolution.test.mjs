import assert from 'node:assert/strict';
import test from 'node:test';
import { Buffer,File } from 'node:buffer';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync } from 'node:fs';
import { URL } from 'node:url';
import { deliveryFixture } from './helpers/deliveryFixture.mjs';
const { FormData }=globalThis;
const assetId='43000000-0000-4000-8000-000000000099';const assetCode='MC-26-TEST-000099';
const checklist=['IDENTITY','EXTERIOR','DISPLAY','LENS_CAMERA','POWER','FUNCTIONAL','ACCESSORIES','RETURN_REASON'].map((item)=>({item,result:'NOT_APPLICABLE',notes:item==='IDENTITY'?'No SN recorded in test fixture':'Staging fixture observation'}));
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5XcAAAAASUVORK5CYII=','base64');
async function fixture(stage='completed'){
  const objects=new Map();const assets={async put(key,value){objects.set(key,value);},async get(key){return objects.has(key)?{body:objects.get(key)}:null;},async delete(key){objects.delete(key);}};
  const f=await deliveryFixture({assets});f.certify();await f.ship();assert.equal((await f.deliver()).status,200);
  const rma=(await (await f.request('uk','/international/rmas',{assetId,orderId:'order-test',reason:'DEFECTIVE',returnWarehouseId:'wh-uk'})).json()).rma;
  const base=`/international/rmas/${rma.id}`;let inspectionId=null;
  if(stage!=='authorized'){
    assert.equal((await f.request('uk',`${base}/return-shipment`,{carrier:'Royal Mail',returnTracking:'RM-RESOLUTION'})).status,200);
    assert.equal((await f.request('uk',`${base}/receive-return`,{assetCode})).status,200);
    if(stage!=='received'){
      const started=await f.request('uk',`${base}/inspection/start`,{assetCode});assert.equal(started.status,200);inspectionId=(await started.json()).inspection.id;
      const form=new FormData();form.set('category','OVERALL_CONDITION');form.set('file',new File([png],'test.png',{type:'image/png'}));assert.equal((await f.request('uk',`${base}/inspection/evidence`,form)).status,201);
      if(stage==='completed')assert.equal((await f.request('uk',`${base}/inspection/complete`,{assetCode,observedSn:'',snVerification:'NOT_TESTED',checklist,findings:{issueReproduced:'YES',conditionAssessment:'PHYSICAL_DAMAGE',inspectorNotes:'Recorded facts only; no automatic responsibility decision'}})).status,200);
    }
  }
  const input={inspectionId:inspectionId??'00000000-0000-4000-8000-000000000001',resolutionType:'REPAIR',decisionReason:'Staging approval after manual review',decisionNotes:'Decision only; do not execute.'};
  const grant=(user)=>f.sqlite.prepare("INSERT OR IGNORE INTO user_roles (user_id,role_id) VALUES (?,'role-international-resolution-manager')").run(user);
  return {...f,objects,rma,base,input,grant,decide:(user='admin',payload=input)=>f.request(user,`${base}/resolution`,payload),detail:(user='admin')=>f.request(user,`${base}/resolution`)};
}
const invariant=(f)=>['assets','asset_locations','orders','international_asset_allocations','asset_inspection_tasks','asset_certifications','asset_public_warranties','asset_public_warranty_entitlements','rma_return_inspections','rma_return_inspection_evidence'].map((t)=>f.sqlite.prepare(`SELECT * FROM ${t}`).all());
const count=(f)=>f.sqlite.prepare("SELECT COUNT(*) AS n FROM asset_events WHERE event_type='rma_resolution_decided'").get().n;
const decision=async(f)=>(await (await f.detail()).json()).decision;

test('all four explicit decisions persist immutable identity/time/inspection and preserve quarantine, sale, certification, warranties and evidence',async()=>{
  for(const resolutionType of ['REPAIR','REPLACE','REFUND','REJECT']){
    const f=await fixture();const before=invariant(f);const response=await f.decide('admin',{...f.input,resolutionType});assert.equal(response.status,200);
    const result=await response.json();assert.equal(result.decision.resolutionType,resolutionType);assert.equal(result.decision.decisionReason,f.input.decisionReason);assert.equal(result.decision.decidedBy,'admin');assert.ok(result.decision.decidedAt);assert.equal(result.decision.inspectionId,f.input.inspectionId);assert.equal(result.decision.assetId,assetId);assert.equal(result.decision.executionStatus,'NOT_STARTED');assert.equal(result.canDecide,false);
    const row=f.sqlite.prepare('SELECT * FROM after_sales_cases').get();assert.equal(row.status,'in_progress');assert.equal(row.service_stage,'RESOLUTION_DECIDED');assert.equal(row.cross_border_resolution,resolutionType);assert.notEqual(row.status,'closed');assert.deepEqual(invariant(f),before);
    assert.equal(count(f),1);const event=f.sqlite.prepare("SELECT * FROM asset_events WHERE event_type='rma_resolution_decided'").get();const metadata=JSON.parse(event.new_value_json);assert.equal(metadata.rma_reference,f.rma.rmaReference);assert.equal(metadata.resolution_type,resolutionType);assert.equal(metadata.inspection_id,f.input.inspectionId);assert.equal(metadata.decided_by,'admin');assert.equal(metadata.decided_at,result.decision.decidedAt);assert.equal(event.visibility,'admin_private');assert.equal(metadata.decision_reason,undefined);
    const audit=f.sqlite.prepare("SELECT * FROM audit_logs WHERE action='international.rma.resolution_decided'").all();assert.equal(audit.length,1);assert.equal(JSON.parse(audit[0].after_json).decision_reason,f.input.decisionReason);assert.equal(JSON.parse(audit[0].after_json).decision_authority,'administrator');
    assert.deepEqual((await (await f.request('uk','/international/warehouses/assets?warehouseId=wh-uk')).json()).assets,[]);assert.equal((await (await f.request('uk','/international/warehouses/return-quarantine')).json()).assets[0].assetStatus,'QUARANTINED');
  }
});

test('decision grant is explicit, separate from inspection; authorized International succeeds without any inspection mutation privilege',async()=>{
  const f=await fixture();assert.equal((await f.decide('intl')).status,403);f.grant('intl');
  const review=await f.request('intl',`${f.base}/inspection`);assert.equal(review.status,200);const inspection=(await review.json()).inspection;assert.equal(inspection.canEdit,false);assert.equal((await f.request('intl',inspection.evidence[0].contentUrl)).status,200);
  assert.equal((await f.request('intl',`${f.base}/inspection/start`,{assetCode})).status,403);assert.equal((await f.request('intl',`${f.base}/inspection/complete`,{assetCode,observedSn:'',snVerification:'NOT_TESTED',checklist,findings:{issueReproduced:'YES',conditionAssessment:'PHYSICAL_DAMAGE',inspectorNotes:'Cannot edit'}})).status,403);
  assert.equal((await f.decide('intl')).status,200);assert.equal((await decision(f)).decidedBy,'intl');assert.equal(JSON.parse(f.sqlite.prepare("SELECT after_json FROM audit_logs WHERE action='international.rma.resolution_decided'").get().after_json).decision_authority,'international-after-sales:decide');
});

test('no completed inspection, in-progress inspection, wrong RMA state and mismatched report reference reject decisions',async()=>{
  for(const stage of ['authorized','received','in_progress']){const f=await fixture(stage);assert.equal((await f.decide()).status,409,stage);assert.equal(count(f),0);}
  for(const mutate of ["UPDATE after_sales_cases SET service_stage='RECEIVED'","UPDATE after_sales_cases SET status='closed'","UPDATE after_sales_cases SET cross_border_resolution='legacy-resolution'"]){const f=await fixture();f.sqlite.exec(mutate);assert.equal((await f.decide()).status,409);assert.equal(count(f),0);}
  const f=await fixture();assert.equal((await f.decide('admin',{...f.input,inspectionId:'00000000-0000-4000-8000-000000000001'})).status,409);assert.equal(count(f),0);
});

test('required reason, resolution enum, bounded notes, report reference and strict no-execution input validation',async()=>{
  const f=await fixture();for(const input of [{...f.input,decisionReason:''},{...f.input,decisionReason:'   '},{...f.input,decisionReason:'x'.repeat(1001)},{...f.input,resolutionType:'REPAIRED'},{...f.input,inspectionId:null},{...f.input,decisionNotes:'x'.repeat(4001)},{...f.input,execute:true}])assert.equal((await f.decide('admin',input)).status,400);
  assert.equal(count(f),0);const {decisionNotes:_notes,...withoutNotes}=f.input;assert.ok(_notes);assert.equal((await f.decide('admin',withoutNotes)).status,200);assert.equal((await decision(f)).decisionNotes,'');
});

test('same decision retries return original identity/date; conflicting resolution/reason/notes/reference is HTTP 409',async()=>{
  const f=await fixture();await f.decide();const first=await decision(f);
  for(let n=0;n<3;n++){assert.equal((await f.decide()).status,200);assert.deepEqual(await decision(f),first);}
  for(const change of [{resolutionType:'REFUND'},{decisionReason:'Another reason'},{decisionNotes:'Changed note'},{inspectionId:'00000000-0000-4000-8000-000000000001'}])assert.equal((await f.decide('admin',{...f.input,...change})).status,409);
  assert.equal(count(f),1);assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='international.rma.resolution_decided'").get().n,1);
  assert.deepEqual(await decision(f),first);
});

test('UK-only Inspector, CN-SD, Certified, unauthorized Account/Warehouse/Market return HTTP 403 even with explicit decision grant for scoped negatives',async()=>{
  const f=await fixture();for(const user of ['uk','cn','cert','intl','other','wrongWarehouse','wrongMarket'])assert.equal((await f.decide(user)).status,403,user);
  for(const user of ['other','wrongWarehouse','wrongMarket']){f.grant(user);assert.equal((await f.decide(user)).status,403,user);assert.equal((await f.detail(user)).status,403,user);assert.equal((await f.request(user,`${f.base}/inspection`)).status,403,user);}
  // Read-all is not a decision permission. It cannot turn a warehouse role into
  // a decision maker through the global data-scope exemption.
  f.sqlite.exec("INSERT INTO role_permissions (role_id,permission_code) SELECT id,'data:read:all' FROM roles WHERE code='uk_fulfilment_operator'");assert.equal((await f.decide('uk')).status,403);
  f.sqlite.exec("DELETE FROM role_permissions WHERE permission_code='data:read:all' AND role_id IN (SELECT id FROM roles WHERE code='uk_fulfilment_operator')");
  await f.decide();for(const user of ['uk','cn','cert','intl','other','wrongWarehouse','wrongMarket'])assert.equal((await f.decide(user)).status,403,user);
});

test('event or Audit write failure rolls back complete decision and RMA state',async()=>{
  for(const table of ['asset_events','audit_logs']){
    const f=await fixture();const before=f.sqlite.prepare('SELECT * FROM after_sales_cases').all();const original=invariant(f);
    f.sqlite.exec(`CREATE TRIGGER fail_decision BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'test decision failure'); END`);
    assert.equal((await f.decide()).status,500);assert.deepEqual(f.sqlite.prepare('SELECT * FROM after_sales_cases').all(),before);assert.deepEqual(invariant(f),original);assert.equal(count(f),0);
  }
});

test('transaction guard rejects changed custody/quarantine/location/case/sale/warehouse, without partial decision',async()=>{
  for(const mutate of ["UPDATE asset_locations SET custody='CUSTOMER'","UPDATE assets SET inventory_status='NORMAL'","UPDATE asset_locations SET location_id=NULL","UPDATE after_sales_cases SET service_stage='RECEIVED'","UPDATE after_sales_cases SET status='closed'","UPDATE international_asset_allocations SET status='released'","UPDATE warehouses SET status='inactive' WHERE id='wh-uk'"]){
    const f=await fixture();const original=f.db.batch.bind(f.db);f.db.batch=async(statements)=>{f.sqlite.exec(mutate);return original(statements);};assert.equal((await f.decide()).status,409);assert.equal(count(f),0);assert.equal((await decision(f)),null);
  }
});

test('interleaved identical/conflicting decisions converge to one final decision; losing conflict gets HTTP 409',async()=>{
  for(const conflict of [false,true]){
    const f=await fixture();const original=f.db.batch.bind(f.db);let raced=false;
    f.db.batch=async(statements)=>{if(!raced){raced=true;assert.equal((await f.decide('admin',conflict?{...f.input,resolutionType:'REJECT'}:f.input)).status,200);}return original(statements);};
    assert.equal((await f.decide()).status,conflict?409:200);assert.equal(count(f),1);assert.equal((await decision(f)).resolutionType,conflict?'REJECT':'REPAIR');assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='international.rma.resolution_decided'").get().n,1);
  }
});

test('DB prevents incomplete/invalid first decision and later rewriting/removing decision metadata or sale link',async()=>{
  const f=await fixture();assert.throws(()=>f.sqlite.exec("UPDATE after_sales_cases SET resolution_decision_reason='Partial'"),/Invalid RMA resolution/);await f.decide();
  for(const change of ["cross_border_resolution='REFUND'","resolution_decided_at=NULL","resolution_decision_reason='Overwrite'","resolution_decision_notes='Overwrite'","resolution_decided_by='uk'","resolution_inspection_id=NULL","asset_id='other'"]){assert.throws(()=>f.sqlite.exec(`UPDATE after_sales_cases SET ${change}`),/immutable/);}
  assert.equal((await decision(f)).resolutionType,'REPAIR');
});

test('decision permissions cannot view incomplete reports and revocation is enforced from database on every request',async()=>{
  const f=await fixture('in_progress');f.grant('intl');assert.equal((await f.request('intl',`${f.base}/inspection`)).status,403);
  const ready=await fixture();ready.grant('intl');assert.equal((await ready.detail('intl')).status,200);ready.sqlite.exec("DELETE FROM user_roles WHERE user_id='intl' AND role_id='role-international-resolution-manager'");assert.equal((await ready.decide('intl')).status,403);
});

test('lost D1 response after atomic commit returns an error, then identical retry recovers the original single decision',async()=>{
  const f=await fixture();const original=f.db.batch.bind(f.db);f.db.batch=async(statements)=>{await original(statements);throw new Error('response lost after decision commit');};
  assert.equal((await f.decide()).status,500);const first=await decision(f);assert.equal((await f.decide()).status,200);assert.deepEqual(await decision(f),first);assert.equal(count(f),1);assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='international.rma.resolution_decided'").get().n,1);
});

test('0040 preserves lifecycle history/FKs/prior unique constraints and grants no decision privileges to ordinary operators',()=>{
  const db=new DatabaseSync(':memory:');const root=new URL('../apps/api/migrations/',import.meta.url);for(const name of readdirSync(root).filter((name)=>/^\d{4}.*\.sql$/.test(name)&&name<'0040').sort())db.exec(readFileSync(new URL(name,root),'utf8'));
  db.exec("INSERT INTO assets (id,asset_code) VALUES ('migration-asset','MC-MIGRATION'); INSERT INTO asset_events (id,asset_id,event_type,title) VALUES ('old-event','migration-asset','return_inspection_completed','Preserve')");const before=db.prepare('SELECT * FROM asset_events').all();db.exec(readFileSync(new URL('0040_rma_resolution_decision.sql',root),'utf8'));assert.deepEqual(db.prepare('SELECT * FROM asset_events').all(),before);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  for(const index of ['idx_certified_warranty_activation_event','idx_rma_return_events','idx_rma_inspection_events','idx_rma_resolution_event'])assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(index));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM role_permissions rp JOIN roles r ON r.id=rp.role_id WHERE rp.permission_code='international-after-sales:decide' AND r.code IN ('uk_fulfilment_operator','certified_operator','international_operator','warehouse_manager')").get().n,0);
});
