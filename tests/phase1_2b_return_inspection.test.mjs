import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync,readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Buffer,File } from 'node:buffer';
import { URL } from 'node:url';
import { deliveryFixture } from './helpers/deliveryFixture.mjs';
const { FormData } = globalThis;

const assetId='43000000-0000-4000-8000-000000000099'; const assetCode='MC-26-TEST-000099';
const items=['IDENTITY','EXTERIOR','DISPLAY','LENS_CAMERA','POWER','FUNCTIONAL','ACCESSORIES','RETURN_REASON'];
const complete={assetCode,observedSn:'SN-ORIGINAL',snVerification:'MATCH',checklist:items.map((item)=>({item,result:item==='DISPLAY'?'NOT_APPLICABLE':'PASS',notes:''})),findings:{issueReproduced:'YES',conditionAssessment:'FUNCTIONAL_DEFECT',inspectorNotes:'Observed defect. No resolution decision.'}};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5XcAAAAASUVORK5CYII=','base64');
async function fixture(received=true){
  const objects=new Map(); const bucket={async put(key,value){objects.set(key,value);},async delete(key){objects.delete(key);},async get(key){return objects.has(key)?{body:objects.get(key)}:null;}};
  const f=await deliveryFixture({assets:bucket}); f.certify(); await f.ship(); await f.deliver();
  f.sqlite.exec("UPDATE assets SET original_sn='SN-ORIGINAL',current_sn='SN-ORIGINAL'");
  const rma=(await (await f.request('uk','/international/rmas',{assetId,orderId:'order-test',reason:'DEFECTIVE',returnWarehouseId:'wh-uk'})).json()).rma;
  await f.request('uk',`/international/rmas/${rma.id}/return-shipment`,{carrier:'Royal Mail',returnTracking:'RM-INSPECTION'});
  if(received) await f.request('uk',`/international/rmas/${rma.id}/receive-return`,{assetCode});
  const base=`/international/rmas/${rma.id}/inspection`;
  const upload=(user='uk',category='OVERALL_CONDITION',bytes=png,type='image/png')=>{
    const form=new FormData(); form.set('category',category);form.set('file',new File([bytes],'return.png',{type}));return f.request(user,`${base}/evidence`,form);
  };
  return {...f,objects,rma,base,upload,start:(user='uk',code=assetCode)=>f.request(user,`${base}/start`,{assetCode:code}),finish:(user='uk',input=complete)=>f.request(user,`${base}/complete`,input)};
}
const eventCount=(f,event)=>f.sqlite.prepare('SELECT COUNT(*) AS n FROM asset_events WHERE event_type=?').get(event).n;
const snapshot=(f)=>['assets','asset_locations','orders','international_asset_allocations','asset_inspection_tasks','asset_certifications','asset_public_warranties','asset_public_warranty_entitlements'].map((t)=>f.sqlite.prepare(`SELECT * FROM ${t}`).all());
const report=async(f)=>(await (await f.request('uk',f.base)).json()).inspection;

test('independent return inspection persists checklist/findings/private evidence and leaves all original data and quarantine unchanged',async()=>{
  const f=await fixture(); const original=snapshot(f);
  assert.equal((await f.start()).status,200); let r=await report(f); assert.equal(r.status,'INSPECTION_IN_PROGRESS');assert.equal(r.inspectorName,'uk');assert.ok(r.startedAt);
  assert.equal((await f.upload()).status,201); r=await report(f); assert.equal(r.evidence.length,1); assert.equal(r.evidence[0].contentType,'image/png'); assert.equal(r.evidence[0].createdBy,'uk');assert.ok(r.evidence[0].createdAt);
  const content=await f.request('uk',r.evidence[0].contentUrl);assert.equal(content.status,200);assert.match(content.headers.get('cache-control'),/private.*no-store/);assert.equal(content.headers.get('x-content-type-options'),'nosniff');assert.deepEqual(Buffer.from(await content.arrayBuffer()),png);
  assert.equal((await f.finish()).status,200);r=await report(f);assert.equal(r.status,'INSPECTION_COMPLETED');assert.ok(r.completedAt);assert.equal(r.canEdit,false);assert.equal(r.checklist.length,8);assert.deepEqual(r.findings,complete.findings);assert.equal(r.snVerification,'MATCH');assert.equal(r.evidenceSnapshot.length,1);
  assert.deepEqual(snapshot(f),original);assert.equal(f.sqlite.prepare('SELECT service_stage FROM after_sales_cases').get().service_stage,'INSPECTION_COMPLETED');
  assert.equal(eventCount(f,'return_inspection_started'),1);assert.equal(eventCount(f,'return_inspection_completed'),1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action IN ('international.rma.return_inspection_started','international.rma.return_inspection_completed')").get().n,2);
  const stock=await (await f.request('uk','/international/warehouses/return-quarantine')).json();assert.equal(stock.assets[0].assetStatus,'QUARANTINED');assert.deepEqual((await (await f.request('uk','/international/warehouses/assets?warehouseId=wh-uk')).json()).assets,[]);
  for(const e of f.sqlite.prepare("SELECT * FROM asset_events WHERE source='international-return-inspection'").all())assert.equal(JSON.parse(e.new_value_json).inspection_id,r.id);
});

test('cannot start before receipt or on Wrong Asset; wrong input rejects start/complete including retries',async()=>{
  const before=await fixture(false);assert.equal((await before.start()).status,409);assert.equal(eventCount(before,'return_inspection_started'),0);
  const f=await fixture();assert.equal((await f.start('uk','MC-WRONG')).status,409);assert.equal((await f.finish()).status,409);await f.start();await f.upload();
  assert.equal((await f.finish('uk',{...complete,assetCode:'MC-WRONG'})).status,409);assert.equal(eventCount(f,'return_inspection_completed'),0);
  await f.finish();assert.equal((await f.start('uk','MC-WRONG')).status,409);assert.equal((await f.finish('uk',{...complete,assetCode:'MC-WRONG'})).status,409);
});

test('complete requires checklist, findings, overall photo and explicit NOT_TESTED explanation',async()=>{
  const f=await fixture();await f.start();assert.equal((await f.finish()).status,409);await f.upload('uk','OTHER');assert.equal((await f.finish()).status,409);await f.upload();
  assert.equal((await f.finish('uk',{...complete,checklist:complete.checklist.slice(1)})).status,400);
  assert.equal((await f.finish('uk',{...complete,checklist:complete.checklist.map(()=>complete.checklist[0])})).status,400);
  assert.equal((await f.finish('uk',{...complete,findings:{...complete.findings,issueReproduced:''}})).status,400);
  const input={...complete,checklist:complete.checklist.map((c)=>c.item==='POWER'?{...c,result:'NOT_TESTED'}:c)};
  assert.equal((await f.finish('uk',input)).status,400); input.checklist.find((c)=>c.item==='POWER').notes='No charger available';assert.equal((await f.finish('uk',input)).status,200);assert.equal((await report(f)).checklist.find((c)=>c.item==='POWER').result,'NOT_TESTED');
});

test('SN mismatch is recorded as an anomaly without mutating Asset SN or original certification',async()=>{
  const f=await fixture();const original=snapshot(f);await f.start();await f.upload();
  assert.equal((await f.finish('uk',{...complete,observedSn:'DIFFERENT'})).status,400);
  const input={...complete,observedSn:'DIFFERENT',snVerification:'MISMATCH',checklist:complete.checklist.map((c)=>c.item==='IDENTITY'?{...c,result:'FAIL',notes:'Serial number differs; pending manual review'}:c)};
  assert.equal((await f.finish('uk',input)).status,200);assert.equal((await report(f)).snVerification,'MISMATCH');assert.deepEqual(snapshot(f),original);
});

test('start/complete are idempotent; completed report/evidence immutable and changed payload rejected',async()=>{
  const f=await fixture();await f.start();const first=await report(f);for(let i=0;i<3;i++)assert.equal((await f.start()).status,200);assert.equal((await report(f)).startedAt,first.startedAt);await f.upload();await f.finish();const final=await report(f);
  for(let i=0;i<3;i++){assert.equal((await f.finish()).status,200);assert.deepEqual(await report(f),final);assert.equal((await f.start()).status,200);}
  assert.equal((await f.finish('uk',{...complete,findings:{...complete.findings,inspectorNotes:'Overwrite'}})).status,409);assert.equal((await f.upload()).status,409);
  assert.equal(eventCount(f,'return_inspection_started'),1);assert.equal(eventCount(f,'return_inspection_completed'),1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM rma_return_inspections').get().n,1);
  assert.throws(()=>f.sqlite.exec("UPDATE rma_return_inspections SET findings_json='{}'"),/immutable/);assert.throws(()=>f.sqlite.exec('DELETE FROM rma_return_inspection_evidence'),/immutable/);
});

test('CN, Certified, unauthorized Sales Account, wrong Warehouse/Market and unassigned user cannot operate or view private photos',async()=>{
  const f=await fixture();await f.start();await f.upload();const r=await report(f);
  for(const user of ['cn','cert','other','wrongWarehouse','wrongMarket','intl']){
    assert.equal((await f.start(user)).status,403,user);assert.equal((await f.finish(user)).status,403,user);assert.equal((await f.upload(user)).status,403,user);assert.equal((await f.request(user,f.base)).status,403,user);assert.equal((await f.request(user,r.evidence[0].contentUrl)).status,403,user);
  }
  f.sqlite.exec("UPDATE rma_return_inspections SET inspector_id='admin'");assert.equal((await f.finish()).status,403);assert.equal((await f.upload()).status,403);assert.equal((await f.finish('admin')).status,200);
});

test('photos reject videos, SVG, MIME spoofing, empty or oversize data; R2 cleanup on DB failure',async()=>{
  const f=await fixture();await f.start();
  for(const [bytes,type] of [[png,'video/mp4'],[Buffer.from('<svg></svg>'),'image/svg+xml'],[Buffer.from('not a photo'),'image/png'],[new Uint8Array(),'image/png'],[new Uint8Array(25*1024*1024+1),'image/png']])assert.equal((await f.upload('uk','OTHER',bytes,type)).status,400);
  assert.equal(f.objects.size,0);f.sqlite.exec("CREATE TRIGGER fail_evidence BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT,'test evidence failure'); END");
  assert.equal((await f.upload()).status,500);assert.equal(f.objects.size,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM rma_return_inspection_evidence').get().n,0);
});

test('lifecycle/audit failures roll back both start and completion atomically',async()=>{
  for(const completing of [false,true])for(const table of ['asset_events','audit_logs']){
    const f=await fixture();if(completing){await f.start();await f.upload();}
    const state=['after_sales_cases','rma_return_inspections'].map((t)=>f.sqlite.prepare(`SELECT * FROM ${t}`).all());
    f.sqlite.exec(`CREATE TRIGGER fail_inspection BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'test inspection failure'); END`);
    assert.equal((await (completing?f.finish():f.start())).status,500);assert.deepEqual(['after_sales_cases','rma_return_inspections'].map((t)=>f.sqlite.prepare(`SELECT * FROM ${t}`).all()),state);
    assert.equal(eventCount(f,completing?'return_inspection_completed':'return_inspection_started'),0);
  }
});

test('atomic guards recheck custody/quarantine/RMA/sale/warehouse and preserve original state on stale requests',async()=>{
  for(const completing of [false,true])for(const mutation of ["UPDATE asset_locations SET custody='CUSTOMER'","UPDATE assets SET inventory_status='NORMAL'","UPDATE after_sales_cases SET status='closed'","UPDATE international_asset_allocations SET status='released'","UPDATE warehouses SET status='inactive' WHERE id='wh-uk'"]){
    const f=await fixture();if(completing){await f.start();await f.upload();}const original=f.db.batch.bind(f.db);f.db.batch=async(statements)=>{f.sqlite.exec(mutation);return original(statements);};
    assert.equal((await (completing?f.finish():f.start())).status,409);assert.equal(eventCount(f,completing?'return_inspection_completed':'return_inspection_started'),0);
  }
});

test('interleaved start and complete retries converge to a single immutable report and one event per transition',async()=>{
  for(const completing of [false,true]){
    const f=await fixture();if(completing){await f.start();await f.upload();}const original=f.db.batch.bind(f.db);let raced=false;
    f.db.batch=async(statements)=>{if(!raced){raced=true;assert.equal((await (completing?f.finish():f.start())).status,200);}return original(statements);};
    assert.equal((await (completing?f.finish():f.start())).status,200);assert.equal(eventCount(f,completing?'return_inspection_completed':'return_inspection_started'),1);
  }
});

test('0039 preserves historical lifecycle and foreign keys including previous uniqueness guards',()=>{
  const db=new DatabaseSync(':memory:');const root=new URL('../apps/api/migrations/',import.meta.url);
  for(const name of readdirSync(root).filter((name)=>/^\d{4}.*\.sql$/.test(name)&&name<'0039').sort())db.exec(readFileSync(new URL(name,root),'utf8'));
  db.exec("INSERT INTO assets (id,asset_code) VALUES ('migration-asset','MC-MIGRATION'); INSERT INTO asset_events (id,asset_id,event_type,title,source) VALUES ('old-event','migration-asset','return_received','Preserve','international-return-logistics')");const before=db.prepare('SELECT * FROM asset_events').all();
  db.exec(readFileSync(new URL('0039_rma_return_inspection.sql',root),'utf8'));assert.deepEqual(db.prepare('SELECT * FROM asset_events').all(),before);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  for(const index of ['idx_certified_warranty_activation_event','idx_rma_return_events','idx_rma_inspection_events'])assert.ok(db.prepare('SELECT name FROM sqlite_master WHERE type=\'index\' AND name=?').get(index));
});
