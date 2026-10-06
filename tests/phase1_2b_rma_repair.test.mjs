import assert from 'node:assert/strict';
import test from 'node:test';
import { Buffer,File } from 'node:buffer';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync } from 'node:fs';
import { URL } from 'node:url';
import { deliveryFixture } from './helpers/deliveryFixture.mjs';
const {FormData}=globalThis;
const assetId='43000000-0000-4000-8000-000000000099';const assetCode='MC-26-TEST-000099';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5XcAAAAASUVORK5CYII=','base64');
const checklist=['IDENTITY','EXTERIOR','DISPLAY','LENS_CAMERA','POWER','FUNCTIONAL','ACCESSORIES','RETURN_REASON'].map((item)=>({item,result:'NOT_APPLICABLE',notes:'Synthetic fixture facts; not a real inspection'}));
async function fixture({resolution='REPAIR',stage='decided'}={}){
  const objects=new Map();const assets={async put(key,value){objects.set(key,value);},async get(key){return objects.has(key)?{body:objects.get(key)}:null;},async delete(key){objects.delete(key);}};
  const f=await deliveryFixture({assets});f.certify();await f.ship();assert.equal((await f.deliver()).status,200);
  const intake=await f.request('uk','/international/rmas',{assetId,orderId:'order-test',reason:'DEFECTIVE',returnWarehouseId:'wh-uk'});assert.equal(intake.status,200);
  const rma=(await intake.json()).rma;const base=`/international/rmas/${rma.id}`;
  assert.equal((await f.request('uk',`${base}/return-shipment`,{carrier:'Royal Mail',returnTracking:'STG-REPAIR-ONLY'})).status,200);
  assert.equal((await f.request('uk',`${base}/receive-return`,{assetCode})).status,200);
  const inspection=(await (await f.request('uk',`${base}/inspection/start`,{assetCode})).json()).inspection;
  const form=new FormData();form.set('category','OVERALL_CONDITION');form.set('file',new File([png],'synthetic-test.png',{type:'image/png'}));assert.equal((await f.request('uk',`${base}/inspection/evidence`,form)).status,201);
  if(stage!=='inspection_in_progress')assert.equal((await f.request('uk',`${base}/inspection/complete`,{assetCode,observedSn:'',snVerification:'NOT_TESTED',checklist,
    findings:{issueReproduced:'YES',conditionAssessment:'FUNCTIONAL_DEFECT',inspectorNotes:'Synthetic test observations; not liability or resolution'}})).status,200);
  if(stage==='decided')assert.equal((await f.request('admin',`${base}/resolution`,{inspectionId:inspection.id,resolutionType:resolution,decisionReason:'Synthetic test approval only',decisionNotes:''})).status,200);
  const input={repairSummary:'Synthetic test repair record; no physical repair performed',workPerformed:'Synthetic module replacement and simulated functional check',repairNotes:'Staging test only; preserve quarantine',
    partsUsed:[{partName:'Synthetic test module',partNumber:'TEST-NOT-PHYSICAL',quantity:1}],postRepairCheck:'PASS'};
  const grant=(user)=>f.sqlite.prepare("INSERT OR IGNORE INTO user_roles(user_id,role_id) VALUES(?,'role-international-repair-operator')").run(user);
  return {...f,objects,rma,base,input,grant,start:(user='admin')=>f.request(user,`${base}/repair/start`,{}),
    complete:(user='admin',payload=input)=>f.request(user,`${base}/repair/complete`,payload),detail:(user='admin')=>f.request(user,`${base}/repair`)};
}
const record=async(f)=>(await (await f.detail()).json()).execution;
const invariant=(f)=>['assets','asset_locations','orders','international_asset_allocations','marketplace_listings','asset_inspection_tasks','asset_certifications','asset_public_warranties','asset_public_warranty_entitlements','rma_return_inspections','rma_return_inspection_evidence'].map((t)=>f.sqlite.prepare(`SELECT * FROM ${t}`).all());
const decision=(f)=>f.sqlite.prepare('SELECT asset_id,order_id,cross_border_resolution,resolution_decision_reason,resolution_decision_notes,resolution_decided_by,resolution_decided_at,resolution_inspection_id,rma_warranty_snapshot_json FROM after_sales_cases').all();
const counts=(f)=>f.sqlite.prepare("SELECT event_type,COUNT(*) AS n FROM asset_events WHERE source='international-rma-repair' GROUP BY event_type ORDER BY event_type").all().map((r)=>({...r}));

test('Admin starts REPAIR only, persists assigned technician/decision/report references and a single formal event/Audit',async()=>{
  const f=await fixture();const before=invariant(f),approved=decision(f);const detail=await (await f.detail()).json();assert.equal(detail.canStart,true);assert.equal(detail.executionStatus,'NOT_STARTED');
  const response=await f.start();assert.equal(response.status,200);const result=await response.json();assert.equal(result.execution.status,'REPAIR_IN_PROGRESS');assert.equal(result.execution.technicianId,'admin');assert.equal(result.execution.startedBy,'admin');assert.ok(result.execution.startedAt);assert.equal(result.execution.resolutionReference,f.rma.id);assert.equal(result.execution.inspectionId,approved[0].resolution_inspection_id);assert.equal(result.canStart,false);assert.equal(result.canComplete,true);
  assert.equal(f.sqlite.prepare('SELECT service_stage FROM after_sales_cases').get().service_stage,'REPAIR_IN_PROGRESS');assert.deepEqual(invariant(f),before);assert.deepEqual(decision(f),approved);
  assert.deepEqual(counts(f),[{event_type:'repair_started',n:1}]);assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='international.rma.repair_started'").get().n,1);
});

test('complete PASS / FAIL / INCONCLUSIVE preserves quarantine, certification, warranties, sale, decision, inspection and private evidence',async()=>{
  for(const postRepairCheck of ['PASS','FAIL','INCONCLUSIVE']){
    const f=await fixture();const before=invariant(f),approved=decision(f);await f.start();const started=await record(f);const response=await f.complete('admin',{...f.input,postRepairCheck});assert.equal(response.status,200);
    const result=await response.json();assert.equal(result.executionStatus,'REPAIR_COMPLETED');assert.equal(result.execution.postRepairCheck,postRepairCheck);assert.equal(result.execution.postCheckStatus,postRepairCheck==='FAIL'?'POST_CHECK_FAILED':postRepairCheck==='PASS'?'POST_CHECK_PASSED':'POST_CHECK_INCONCLUSIVE');assert.equal(result.execution.awaitingReinspection,true);assert.equal(result.execution.completedBy,'admin');assert.ok(result.execution.completedAt);assert.equal(result.execution.startedAt,started.startedAt);assert.equal(result.execution.technicianId,started.technicianId);assert.equal(result.execution.repairSummary,f.input.repairSummary);assert.deepEqual(result.execution.partsUsed,f.input.partsUsed);assert.equal(result.execution.fingerprint,undefined);assert.equal(result.canComplete,false);
    assert.deepEqual(invariant(f),before);assert.deepEqual(decision(f),approved);assert.equal(f.sqlite.prepare('SELECT service_stage,status FROM after_sales_cases').get().service_stage,'REPAIR_COMPLETED');
    assert.equal((await (await f.request('admin',`${f.base}/resolution`)).json()).decision.executionStatus,'REPAIR_COMPLETED');
    assert.deepEqual((await (await f.request('uk','/international/warehouses/assets?warehouseId=wh-uk')).json()).assets,[]);assert.equal((await (await f.request('uk','/international/warehouses/return-quarantine')).json()).assets[0].assetStatus,'QUARANTINED');
    assert.deepEqual(counts(f),[{event_type:'repair_completed',n:1},{event_type:'repair_started',n:1}]);const event=f.sqlite.prepare("SELECT * FROM asset_events WHERE event_type='repair_completed'").get();const metadata=JSON.parse(event.new_value_json);assert.equal(metadata.resolution_type,'REPAIR');assert.equal(metadata.repair_execution_id,result.execution.id);assert.equal(metadata.post_repair_check,postRepairCheck);assert.equal(metadata.repair_notes,undefined);assert.equal(metadata.repair_summary,undefined);assert.equal(event.visibility,'admin_private');
    const audit=JSON.parse(f.sqlite.prepare("SELECT after_json FROM audit_logs WHERE action='international.rma.repair_completed'").get().after_json);assert.equal(audit.repair_summary,f.input.repairSummary);assert.equal(audit.completed_at,result.execution.completedAt);
  }
});

test('REPLACE, REFUND and REJECT decisions cannot start or complete repair',async()=>{
  for(const resolution of ['REPLACE','REFUND','REJECT']){const f=await fixture({resolution});assert.equal((await f.start()).status,409);assert.equal((await f.complete()).status,409);assert.equal((await (await f.detail()).json()).canStart,false);assert.deepEqual(counts(f),[]);assert.equal(await record(f),null);}
});
test('missing decision / uncompleted inspection rejects start; cannot skip NOT_STARTED directly to completion',async()=>{
  for(const stage of ['inspection_in_progress','inspection_completed']){const f=await fixture({stage});assert.equal((await f.start()).status,409);assert.equal((await f.complete()).status,409);assert.equal(await record(f),null);}
  const f=await fixture();assert.equal((await f.complete()).status,409);assert.deepEqual(counts(f),[]);
});
test('invalid RMA state, incomplete report, missing formal decision event and sale mismatch reject start',async()=>{
  for(const mutate of ["UPDATE after_sales_cases SET service_stage='RECEIVED'","UPDATE after_sales_cases SET status='closed'",
    "DELETE FROM asset_events WHERE event_type='rma_resolution_decided'","UPDATE international_asset_allocations SET status='released'",
    "DELETE FROM asset_events WHERE event_type='return_inspection_completed'"]){const f=await fixture();f.sqlite.exec(mutate);assert.equal((await f.start()).status,409);assert.equal(await record(f),null);}
});
test('repeated Start is idempotent with unchanged identity/time/technician; completed execution cannot restart',async()=>{
  const f=await fixture();await f.start();const first=await record(f);for(let n=0;n<3;n++){assert.equal((await f.start()).status,200);assert.deepEqual(await record(f),first);}assert.deepEqual(counts(f),[{event_type:'repair_started',n:1}]);
  await f.complete();assert.equal((await f.start()).status,409);assert.equal((await record(f)).status,'REPAIR_COMPLETED');
});
test('identical Complete retries preserve dates/actor and one record/event; conflicting Summary/Work/Notes/Parts/Check are 409',async()=>{
  const f=await fixture();await f.start();await f.complete();const first=await record(f);for(let n=0;n<3;n++){assert.equal((await f.complete()).status,200);assert.deepEqual(await record(f),first);}
  for(const change of [{repairSummary:'Different summary'},{workPerformed:'Different work'},{repairNotes:'Different note'},{partsUsed:[]},{postRepairCheck:'FAIL'}])assert.equal((await f.complete('admin',{...f.input,...change})).status,409);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM rma_repair_executions').get().n,1);assert.deepEqual(counts(f),[{event_type:'repair_completed',n:1},{event_type:'repair_started',n:1}]);assert.deepEqual(await record(f),first);
});
test('required summary/work/check, strict no-decision/no-asset fields, bounded text and structured Parts validate',async()=>{
  const f=await fixture();await f.start();for(const input of [{...f.input,repairSummary:''},{...f.input,workPerformed:'   '},{...f.input,postRepairCheck:''},
    {...f.input,repairSummary:'x'.repeat(1001)},{...f.input,workPerformed:'x'.repeat(4001)},{...f.input,repairNotes:'x'.repeat(4001)},
    {...f.input,partsUsed:[{partName:'',quantity:1}]},{...f.input,partsUsed:[{partName:'Module',quantity:0}]},{...f.input,partsUsed:[{partName:'Module',quantity:1.5}]},
    {...f.input,partsUsed:Array.from({length:31},()=>({partName:'Module',quantity:1}))},{...f.input,resolutionType:'REFUND'},{...f.input,inventoryStatus:'NORMAL'}])assert.equal((await f.complete('admin',input)).status,400);
  assert.equal((await record(f)).status,'REPAIR_IN_PROGRESS');assert.equal((await f.request('admin',`${f.base}/repair/start`,{technicianId:'uk'})).status,400);
  const {repairNotes:_notes,partsUsed:_parts,...minimal}=f.input;assert.ok(_notes&&_parts);assert.equal((await f.complete('admin',minimal)).status,200);assert.deepEqual((await record(f)).partsUsed,[]);
});
test('UK warehouse, Certified, CN-SD, ordinary International and decision-only role have no implicit repair authority',async()=>{
  const f=await fixture();f.sqlite.prepare("INSERT INTO user_roles(user_id,role_id) VALUES('intl','role-international-resolution-manager')").run();
  for(const user of ['uk','cert','cn','intl']){assert.equal((await f.start(user)).status,403);assert.equal((await f.complete(user)).status,403);}assert.equal(await record(f),null);
});
test('explicit Repair Operator succeeds within scope but cannot edit inspection or decision; Admin can complete assigned technician work',async()=>{
  const f=await fixture();f.grant('intl');const review=await f.request('intl',`${f.base}/inspection`);assert.equal(review.status,200);const inspection=(await review.json()).inspection;assert.equal((await f.request('intl',inspection.evidence[0].contentUrl)).status,200);
  assert.equal((await f.request('intl',`${f.base}/inspection/start`,{assetCode})).status,403);assert.equal((await f.request('intl',`${f.base}/resolution`,{inspectionId:inspection.id,resolutionType:'REPAIR',decisionReason:'Synthetic test approval only',decisionNotes:''})).status,403);
  assert.equal((await f.start('intl')).status,200);assert.equal((await record(f)).technicianId,'intl');assert.equal((await f.complete('intl')).status,200);assert.equal((await record(f)).completedBy,'intl');
  const other=await fixture();other.grant('intl');await other.start('intl');assert.equal((await other.complete('admin')).status,200);assert.equal((await record(other)).technicianId,'intl');assert.equal((await record(other)).completedBy,'admin');
});
test('explicit repair grant does not bypass unauthorized Sales Account, Market or Warehouse Scope; revocation enforced per request',async()=>{
  const f=await fixture();for(const user of ['other','wrongWarehouse','wrongMarket']){f.grant(user);assert.equal((await f.start(user)).status,403);assert.equal((await f.detail(user)).status,403);assert.equal((await f.complete(user)).status,403);}
  f.grant('intl');await f.start('intl');f.sqlite.prepare("DELETE FROM user_roles WHERE user_id='intl' AND role_id='role-international-repair-operator'").run();assert.equal((await f.complete('intl')).status,403);
});
test('non-admin global read and another authorized technician cannot acquire completion/decision authority',async()=>{
  const f=await fixture();f.sqlite.prepare("INSERT INTO role_permissions(role_id,permission_code) SELECT id,'data:read:all' FROM roles WHERE code='uk_fulfilment_operator'").run();assert.equal((await f.start('uk')).status,403);
  f.sqlite.prepare("DELETE FROM role_permissions WHERE permission_code='data:read:all' AND role_id IN(SELECT id FROM roles WHERE code='uk_fulfilment_operator')").run();
  f.grant('intl');f.grant('uk');await f.start('intl');assert.equal((await f.complete('uk')).status,403);assert.equal((await (await f.detail('uk')).json()).canComplete,false);
});
test('Start event or Audit failure rolls back execution row, case stage and all related data',async()=>{
  for(const table of ['asset_events','audit_logs']){const f=await fixture();const before=invariant(f),cases=f.sqlite.prepare('SELECT * FROM after_sales_cases').all();f.sqlite.exec(`CREATE TRIGGER fail_repair BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'test repair failure'); END`);
    assert.equal((await f.start()).status,500);assert.equal(await record(f),null);assert.deepEqual(f.sqlite.prepare('SELECT * FROM after_sales_cases').all(),cases);assert.deepEqual(invariant(f),before);assert.deepEqual(counts(f),[]);}
});
test('Complete event or Audit failure rolls back record, case state and history to IN_PROGRESS',async()=>{
  for(const table of ['asset_events','audit_logs']){const f=await fixture();await f.start();const before=await record(f),cases=f.sqlite.prepare('SELECT * FROM after_sales_cases').all();f.sqlite.exec(`CREATE TRIGGER fail_repair BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'test repair failure'); END`);
    assert.equal((await f.complete()).status,500);assert.deepEqual(await record(f),before);assert.deepEqual(f.sqlite.prepare('SELECT * FROM after_sales_cases').all(),cases);assert.deepEqual(counts(f),[{event_type:'repair_started',n:1}]);}
});
test('guarded transactions recheck mutable quarantine, warehouse, sale and report references before Start/Complete',async()=>{
  for(const completing of [false,true])for(const mutate of ["UPDATE asset_locations SET custody='CUSTOMER'","UPDATE assets SET inventory_status='NORMAL'","UPDATE asset_locations SET location_id=NULL",
    "UPDATE warehouses SET status='inactive' WHERE id='wh-uk'","UPDATE international_asset_allocations SET status='released'","DELETE FROM asset_events WHERE event_type='return_inspection_completed'"]){
    const f=await fixture();if(completing)await f.start();const prior=await record(f);const original=f.db.batch.bind(f.db);f.db.batch=async(statements)=>{f.sqlite.exec(mutate);return original(statements);};
    assert.equal((await (completing?f.complete():f.start())).status,409);assert.deepEqual(await record(f),prior);assert.equal(counts(f).some((e)=>e.event_type==='repair_completed'),false);
  }
});
test('interleaved duplicate Starts and identical/conflicting Completes converge on one immutable execution',async()=>{
  const start=await fixture();const originalStart=start.db.batch.bind(start.db);let started=false;start.db.batch=async(statements)=>{if(!started){started=true;assert.equal((await start.start()).status,200);}return originalStart(statements);};assert.equal((await start.start()).status,200);assert.equal(start.sqlite.prepare('SELECT COUNT(*) AS n FROM rma_repair_executions').get().n,1);assert.deepEqual(counts(start),[{event_type:'repair_started',n:1}]);
  for(const conflicting of [false,true]){const f=await fixture();await f.start();const original=f.db.batch.bind(f.db);let raced=false;f.db.batch=async(statements)=>{if(!raced){raced=true;assert.equal((await f.complete('admin',conflicting?{...f.input,postRepairCheck:'FAIL'}:f.input)).status,200);}return original(statements);};
    assert.equal((await f.complete()).status,conflicting?409:200);assert.deepEqual(counts(f),[{event_type:'repair_completed',n:1},{event_type:'repair_started',n:1}]);assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='international.rma.repair_completed'").get().n,1);}
});
test('lost committed responses return errors then retries recover unchanged execution and event counts',async()=>{
  for(const completing of [false,true]){const f=await fixture();if(completing)await f.start();const original=f.db.batch.bind(f.db);let first=true;f.db.batch=async(statements)=>{const result=await original(statements);if(first){first=false;throw new Error('test response lost after committed repair');}return result;};
    assert.equal((await (completing?f.complete():f.start())).status,500);const committed=await record(f);assert.equal((await (completing?f.complete():f.start())).status,200);assert.deepEqual(await record(f),committed);assert.equal(counts(f).every((event)=>event.n===1),true);}
});
test('DB blocks stage without execution, changes to assigned identity/start time and all completed-record changes',async()=>{
  const f=await fixture();assert.throws(()=>f.sqlite.exec("UPDATE after_sales_cases SET service_stage='REPAIR_COMPLETED'"),/Invalid repair case state/);await f.start();
  for(const change of ["technician_id='uk'","started_at='2026-01-01'","resolution_reference='other'","inspection_id='other'","status='REPAIR_IN_PROGRESS'"]){assert.throws(()=>f.sqlite.exec(`UPDATE rma_repair_executions SET ${change}`),/immutable|Invalid repair completion/);}
  await f.complete();for(const change of ["repair_summary='Edited'","completed_at=NULL","status='REPAIR_IN_PROGRESS'"]){assert.throws(()=>f.sqlite.exec(`UPDATE rma_repair_executions SET ${change}`),/immutable|Invalid repair completion/);}
  assert.throws(()=>f.sqlite.exec("UPDATE after_sales_cases SET service_stage='REPAIR_IN_PROGRESS'"),/Invalid repair case state/);
  assert.throws(()=>f.sqlite.exec("UPDATE after_sales_cases SET cross_border_resolution='REFUND'"),/immutable/);
  assert.throws(()=>f.sqlite.exec('DELETE FROM rma_repair_executions'),/cannot be deleted/);
});
test('quarantined completed repair remains unavailable for order allocation and listing',async()=>{
  const f=await fixture();await f.start();await f.complete();
  f.sqlite.exec("INSERT INTO orders(id,order_no,dealer_id,store_id,created_by,status,channel_id,sales_account_id,fulfilment_warehouse_id) VALUES('next-repair-order','NEXT-REPAIR','dealer','store','uk','approved','channel-ebay-uk','account-test','wh-uk')");
  assert.equal((await f.request('uk','/international/orders/next-repair-order/bind-asset',{assetId})).status,409);
  assert.equal((await f.request('intl','/marketplace/listings',{assetId,channelId:'channel-ebay-uk',salesAccountId:'account-test',title:'Returned repair must not be listed',priceMinor:100,currency:'GBP'})).status,409);
  assert.throws(()=>f.sqlite.exec(`INSERT INTO international_asset_allocations(allocation_id,order_id,asset_id,status) VALUES('new-allocation','next-repair-order','${assetId}','reserved')`),/quarantin/i);
  assert.throws(()=>f.sqlite.exec(`INSERT INTO marketplace_listings(id,asset_id,channel_id,sales_account_id,title,price_minor) VALUES('bad-listing','${assetId}','channel-ebay-uk','account-test','Bad',100)`),/quarantin/i);
  assert.throws(()=>f.sqlite.exec(`UPDATE asset_locations SET status='on_hand' WHERE asset_id='${assetId}'`),/quarantin/i);
});
test('0041 preserves existing events/FKs/unique indices and assigns no implicit Repair privileges',()=>{
  const db=new DatabaseSync(':memory:');const root=new URL('../apps/api/migrations/',import.meta.url);const names=readdirSync(root).filter((n)=>/^\d{4}.*\.sql$/.test(n)).sort();
  for(const name of names.filter((n)=>n<'0041'))db.exec(readFileSync(new URL(name,root),'utf8'));
  db.exec("PRAGMA foreign_keys=ON; INSERT INTO assets(id,asset_code) VALUES('migration-asset','MC-MIGRATION'); INSERT INTO asset_events(id,asset_id,event_type,title) VALUES('old-event','migration-asset','note_added','preserve');");
  db.exec(readFileSync(new URL('0041_rma_repair_execution.sql',root),'utf8'));assert.equal(db.prepare('SELECT title FROM asset_events WHERE id=?').get('old-event').title,'preserve');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  for(const index of ['idx_certified_warranty_activation_event','idx_rma_return_events','idx_rma_inspection_events','idx_rma_resolution_event','idx_rma_repair_events'])assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(index));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM role_permissions p JOIN roles r ON r.id=p.role_id WHERE p.permission_code='international-repair:execute' AND r.code NOT IN('super_admin','international_repair_operator')").get().n,0);assert.equal(db.prepare("SELECT COUNT(*) AS n FROM user_roles WHERE role_id='role-international-repair-operator'").get().n,0);
});
