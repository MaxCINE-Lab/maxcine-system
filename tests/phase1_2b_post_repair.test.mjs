import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync } from 'node:fs';
import { URL } from 'node:url';
import { assetId,assetCode,postRepairFixture } from './helpers/postRepairFixture.mjs';
const historyTables=['assets','asset_locations','orders','international_asset_allocations','marketplace_listings','asset_public_warranties','asset_public_warranty_entitlements','after_sales_cases','rma_return_inspections','rma_return_inspection_evidence','rma_repair_executions'];
const history=f=>historyTables.map(t=>f.sqlite.prepare(`SELECT * FROM ${t}`).all());
const oldTasks=f=>f.sqlite.prepare("SELECT * FROM asset_inspection_tasks WHERE process_code<>'POST_REPAIR_RECERTIFICATION'").all();
const oldCerts=f=>f.sqlite.prepare('SELECT * FROM asset_certifications WHERE version=1').all();
const events=f=>f.sqlite.prepare("SELECT event_type,COUNT(*) n FROM asset_events WHERE source='post-repair-recertification' GROUP BY event_type ORDER BY event_type").all().map(r=>({...r}));
const row=f=>f.sqlite.prepare('SELECT * FROM rma_post_repair_inspections').get();

test('valid Start uses canonical task assignment and distinct purpose; original facts and certification untouched',async()=>{
 const f=await postRepairFixture(),before=history(f),tasks=oldTasks(f),certs=oldCerts(f);assert.equal((await f.data()).canStart,true);
 assert.equal((await f.start()).status,200);const data=await f.data();assert.equal(data.purpose,'POST_REPAIR_RECERTIFICATION');assert.equal(data.inspection.status,'IN_PROGRESS');assert.equal(data.inspection.inspectorId,'admin');
 const task=f.sqlite.prepare('SELECT * FROM asset_inspection_tasks WHERE id=?').get(data.inspection.taskId);assert.equal(task.process_code,'POST_REPAIR_RECERTIFICATION');assert.equal(task.assigned_to,'admin');
 assert.deepEqual(history(f),before);assert.deepEqual(oldTasks(f),tasks);assert.deepEqual(oldCerts(f),certs);assert.deepEqual(events(f),[{event_type:'post_repair_reinspection_started',n:1}]);
});
test('save/read draft persists checklist/findings without certification; identical save is a no-op',async()=>{
 const f=await postRepairFixture();await f.start();const draft={...f.input,grade:null,checklist:f.input.checklist.map(c=>({...c,result:'NOT_TESTED',notes:''})),findings:{issueRemains:'INCONCLUSIVE',functionalCondition:'INCONCLUSIVE',inspectorNotes:''}};
 assert.equal((await f.save('admin',draft)).status,200);const saved=await f.data();assert.equal(saved.inspection.grade,null);assert.equal(saved.inspection.checklist.every(c=>c.result==='NOT_TESTED'),true);
 assert.equal((await f.save('admin',draft)).status,200);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='international.rma.post_repair_draft'").get().n,1);
 assert.equal(saved.decision,null);assert.equal(saved.certificationHistory.length,1);
});
test('explicit Complete locks independent report/evidence and does not implicitly certify',async()=>{
 const f=await postRepairFixture(),before=history(f),tasks=oldTasks(f);await f.inspected();const data=await f.data();assert.equal(data.inspection.status,'COMPLETED');assert.equal(data.decision,null);assert.equal(data.certificationHistory.length,1);
 assert.ok(data.inspection.completedAt);assert.equal(data.inspection.canEdit,false);assert.equal(data.inspection.evidenceSnapshot.length,1);assert.deepEqual(history(f),before);assert.deepEqual(oldTasks(f),tasks);
 assert.equal((await f.save()).status,409);assert.equal((await f.upload()).status,409);
});
test('APPROVED creates exactly one v2 on same canonical Asset while preserving v1 and all original business facts',async()=>{
 const f=await postRepairFixture(),before=history(f),original=oldCerts(f),tasks=oldTasks(f);await f.inspected();assert.equal((await f.decide()).status,200);
 const data=await f.data();assert.equal(data.decision.decision,'APPROVED');assert.equal(data.certificationHistory.length,2);
 const cert=f.sqlite.prepare('SELECT * FROM asset_certifications WHERE version=2').get();assert.equal(cert.asset_id,assetId);assert.equal(cert.purpose,'POST_REPAIR_RECERTIFICATION');assert.equal(cert.post_repair_inspection_id,data.inspection.id);assert.equal(cert.inspection_task_id,data.inspection.taskId);assert.equal(cert.certification_status,'certified');assert.equal(cert.final_qc,1);
 assert.equal(f.sqlite.prepare('SELECT id FROM current_asset_certifications').get().id,cert.id);assert.deepEqual(oldCerts(f),original);assert.deepEqual(history(f),before);assert.deepEqual(oldTasks(f),tasks);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM assets').get().n,1);assert.equal(data.inventoryReleasePending,true);assert.equal(data.sellable,false);
 assert.deepEqual(events(f),[{event_type:'certification_issued',n:1},{event_type:'post_repair_reinspection_completed',n:1},{event_type:'post_repair_reinspection_started',n:1},{event_type:'recertification_approved',n:1}]);
});
test('REJECTED in isolated fixture issues no certification, preserves history/quarantine and locks decision',async()=>{
 const f=await postRepairFixture(),before=history(f),certs=oldCerts(f);await f.inspected();assert.equal((await f.decide('REJECTED')).status,200);
 const d=await f.data();assert.equal(d.decision.certificationId,null);assert.equal(d.certificationHistory.length,1);assert.equal((await f.decide('REJECTED')).status,200);assert.equal((await f.decide('APPROVED')).status,409);
 assert.deepEqual(history(f),before);assert.deepEqual(oldCerts(f),certs);assert.equal(events(f).find(e=>e.event_type==='recertification_rejected').n,1);assert.equal(events(f).some(e=>e.event_type==='certification_issued'),false);
});
test('REPLACE / REFUND / REJECT resolutions cannot start reinspection',async()=>{for(const resolution of ['REPLACE','REFUND','REJECT']){const f=await postRepairFixture({resolution});assert.equal((await f.start()).status,409);assert.equal(row(f),undefined);}});
test('Repair NOT_STARTED or IN_PROGRESS is insufficient; missing formal completion event also rejects',async()=>{
 for(const repair of ['not_started','in_progress']){const f=await postRepairFixture({repair});assert.equal((await f.start()).status,409);}
 const f=await postRepairFixture();f.sqlite.exec("DELETE FROM asset_events WHERE event_type='repair_completed'");assert.equal((await f.start()).status,409);
});
test('Complete before Start, decision before completion, and wrong report reference are conflicts',async()=>{
 const f=await postRepairFixture();assert.equal((await f.complete()).status,409);assert.equal((await f.decide()).status,409);await f.start();assert.equal((await f.decide()).status,409);await f.upload();await f.complete();
 assert.equal((await f.decide('APPROVED','admin',{inspectionId:crypto.randomUUID()})).status,409);
});
test('Wrong Asset / RMA association cannot start/save/complete and never changes Asset SN',async()=>{
 const f=await postRepairFixture();assert.equal((await f.start('admin','MC-WRONG')).status,409);await f.start();const before=history(f);
 assert.equal((await f.save('admin',{...f.input,assetCode:'MC-WRONG'})).status,409);assert.equal((await f.complete('admin',{...f.input,assetCode:'MC-WRONG'})).status,409);assert.deepEqual(history(f),before);
});
test('duplicate Start/Complete preserve task, dates, actor, events; completed restart and conflicting completion are 409',async()=>{
 const f=await postRepairFixture();await f.start();const started=await f.data();for(let n=0;n<3;n++)assert.equal((await f.start()).status,200);assert.deepEqual((await f.data()).inspection,started.inspection);
 await f.upload();await f.complete();const done=await f.data();for(let n=0;n<3;n++)assert.equal((await f.complete()).status,200);assert.deepEqual((await f.data()).inspection,done.inspection);
 assert.equal((await f.start()).status,409);assert.equal((await f.complete('admin',{...f.input,grade:'B'})).status,409);assert.equal(events(f).every(e=>e.n===1),true);
});
test('duplicate APPROVED retains v2 identity/date and one decision/event; changed reason or outcome conflicts',async()=>{
 const f=await postRepairFixture();await f.inspected();await f.decide();const data=await f.data();for(let n=0;n<3;n++)assert.equal((await f.decide()).status,200);assert.deepEqual(await f.data(),data);
 assert.equal((await f.decide('REJECTED')).status,409);assert.equal((await f.decide('APPROVED','admin',{reason:'Changed reason'})).status,409);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM asset_certifications').get().n,2);
});
test('ordinary UK / CN-SD / Certified / International / Repair / decision-only permissions do not grant post-repair powers',async()=>{
 const f=await postRepairFixture();f.sqlite.prepare("INSERT INTO user_roles(user_id,role_id) VALUES('intl','role-international-repair-operator')").run();f.sqlite.prepare("INSERT INTO user_roles(user_id,role_id) VALUES('intl','role-international-resolution-manager')").run();
 for(const user of ['uk','cn','cert','intl']){assert.equal((await f.detail(user)).status,403);assert.equal((await f.start(user)).status,403);assert.equal((await f.save(user)).status,403);assert.equal((await f.complete(user)).status,403);assert.equal((await f.decide('APPROVED',user)).status,403);}
});
test('explicit inspector and certifier are distinct; original assignment reused and other inspector forbidden',async()=>{
 const f=await postRepairFixture();f.grant('uk');f.grant('intl','certifier');assert.equal((await f.start('uk')).status,200);assert.equal((await f.save('uk')).status,200);assert.equal((await f.upload('uk')).status,201);assert.equal((await f.complete('uk')).status,200);
 assert.equal((await f.decide('APPROVED','uk')).status,403);assert.equal((await f.start('intl')).status,403);assert.equal((await f.decide('APPROVED','intl')).status,200);
 const other=await postRepairFixture();other.grant('uk');other.grant('intl');await other.start('uk');assert.equal((await other.save('intl')).status,403);assert.equal((await other.complete('intl')).status,403);assert.equal((await other.upload('intl')).status,403);
});
test('route permission never bypasses Sales Account / Market / Warehouse scope or missing Workspace',async()=>{
 const f=await postRepairFixture();for(const user of ['other','wrongMarket','wrongWarehouse']){f.grant(user);f.grant(user,'certifier');assert.equal((await f.detail(user)).status,403);assert.equal((await f.start(user)).status,403);assert.equal((await f.decide('APPROVED',user)).status,403);}
 f.grant('intl');f.sqlite.prepare("DELETE FROM user_workspaces WHERE user_id='intl'").run();assert.equal((await f.start('intl')).status,403);
});
test('private evidence previews work only under explicit read permission AND correct scopes; no object keys leak',async()=>{
 const f=await postRepairFixture();await f.start();await f.upload();const data=await f.data(),photo=data.inspection.evidence[0];const good=await f.request('admin',photo.contentUrl);assert.equal(good.status,200);assert.equal(good.headers.get('Cache-Control'),'private, no-store');
 assert.equal(JSON.stringify(data).includes('object_key'),false);assert.equal(JSON.stringify(data).includes('post-repair-inspection/'),false);
 for(const user of ['uk','cn','cert','intl','other','wrongMarket','wrongWarehouse']){if(['other','wrongMarket','wrongWarehouse'].includes(user))f.grant(user);assert.equal((await f.request(user,photo.contentUrl)).status,403);}
 f.grant('intl','certifier');assert.equal((await f.request('intl',photo.contentUrl)).status,200);
});
test('legacy Certified endpoints cannot mutate/retrieve new context or bypass decision authority',async()=>{
 const f=await postRepairFixture();await f.start();await f.upload();const d=await f.data(),task=d.inspection.taskId,photo=d.inspection.evidence[0];
 for(const user of ['admin','cert','intl']){assert.equal((await f.request(user,`/certified/tasks/${task}`)).status,403);assert.equal((await f.request(user,`/certified/tasks/${task}/start`,{})).status,403);assert.equal((await f.request(user,`/certified/tasks/${task}/final-qc`,{action:'approve'})).status,403);assert.equal((await f.request(user,`/certified/evidence/${photo.id}/content`)).status,403);}
 assert.equal((await(await f.request('admin','/certified/tasks')).json()).tasks.some(t=>t.id===task),false);
});
test('Start / Complete / APPROVED / REJECTED roll back on Event or Audit failure',async()=>{
 for(const action of ['start','complete','APPROVED','REJECTED'])for(const table of ['asset_events','audit_logs']){
  const f=await postRepairFixture();if(action==='complete'){await f.start();await f.upload();}else if(action!=='start')await f.inspected();
  const before=history(f),reports=f.sqlite.prepare('SELECT * FROM rma_post_repair_inspections').all(),tasks=f.sqlite.prepare('SELECT * FROM asset_inspection_tasks').all(),certs=f.sqlite.prepare('SELECT * FROM asset_certifications').all(),prior=events(f);
  f.sqlite.exec(`CREATE TRIGGER fail_post BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'test post-repair failure'); END`);
  assert.equal((await(action==='start'?f.start():action==='complete'?f.complete():f.decide(action))).status,500);assert.deepEqual(history(f),before);assert.deepEqual(f.sqlite.prepare('SELECT * FROM rma_post_repair_inspections').all(),reports);assert.deepEqual(f.sqlite.prepare('SELECT * FROM asset_inspection_tasks').all(),tasks);assert.deepEqual(f.sqlite.prepare('SELECT * FROM asset_certifications').all(),certs);assert.deepEqual(events(f),prior);
 }
});
test('concurrent duplicate Starts and Completes converge on one report/event',async()=>{
 for(const completing of [false,true]){const f=await postRepairFixture();if(completing){await f.start();await f.upload();}const original=f.db.batch.bind(f.db);let raced=false;
  f.db.batch=async statements=>{if(!raced){raced=true;assert.equal((await(completing?f.complete():f.start())).status,200);}return original(statements);};assert.equal((await(completing?f.complete():f.start())).status,200);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM rma_post_repair_inspections').get().n,1);assert.equal(events(f).every(e=>e.n===1),true);}
});
test('concurrent identical APPROVED requests issue one v2; APPROVED/REJECTED races have a single immutable winner',async()=>{
 for(const [outer,inner] of [['APPROVED','APPROVED'],['APPROVED','REJECTED'],['REJECTED','APPROVED']]){const f=await postRepairFixture();await f.inspected();const original=f.db.batch.bind(f.db);let raced=false;
  f.db.batch=async statements=>{if(!raced){raced=true;assert.equal((await f.decide(inner)).status,200);}return original(statements);};assert.equal((await f.decide(outer)).status,outer===inner?200:409);
  assert.equal((await f.data()).decision.decision,inner);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM asset_certifications').get().n,inner==='APPROVED'?2:1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM rma_recertification_decisions').get().n,1);}
});
test('lost committed responses recover on exact retries without duplicate certification or destroyed private evidence',async()=>{
 for(const action of ['start','upload','complete','decide']){const f=await postRepairFixture();if(action!=='start')await f.start();if(['complete','decide'].includes(action))await f.upload();if(action==='decide')await f.complete();
  const original=f.db.batch.bind(f.db);let lost=true;f.db.batch=async statements=>{const result=await original(statements);if(lost){lost=false;throw new Error('lost post-repair committed response');}return result;};
  const execute=()=>action==='start'?f.start():action==='upload'?f.upload():action==='complete'?f.complete():f.decide();assert.equal((await execute()).status,action==='upload'?201:500);
  assert.equal((await execute()).status,action==='upload'?201:200);assert.equal(events(f).every(e=>e.n===1),true);const d=await f.data();if(d.inspection.evidence[0])assert.equal((await f.request('admin',d.inspection.evidence[0].contentUrl)).status,200);
 }
});
test('APPROVED needs actual Certified readiness, not merely repair PASS or all unchecked items',async()=>{
 for(const change of [p=>({...p,snVerification:'MISMATCH',observedSn:'different-SN',checklist:p.checklist.map(c=>c.item==='IDENTITY'?{...c,notes:'Observed different identity'}:c)}),p=>({...p,grade:'Parts / Repair'}),p=>({...p,findings:{...p.findings,issueRemains:'YES'}}),p=>({...p,findings:{...p.findings,functionalCondition:'DEFECTIVE'}}),p=>({...p,checklist:p.checklist.map(c=>c.item==='FINAL_QC'?{...c,result:'NOT_APPLICABLE'}:c)}),p=>({...p,checklist:p.checklist.map(c=>c.item==='FUNCTIONAL'?{...c,result:'NOT_TESTED'}:c)})]){
  const f=await postRepairFixture();await f.start();await f.upload();assert.equal((await f.complete('admin',change(f.input))).status,200);assert.equal((await f.decide()).status,409);assert.equal((await f.decide('REJECTED')).status,200);
 }
});
test('missing/invalid checklist, findings, grade, SN, reason or photo fail safely; NOT_TESTED not default PASS',async()=>{
 const f=await postRepairFixture();await f.start();assert.equal((await f.complete()).status,409);await f.upload();
 for(const payload of [{...f.input,grade:null},{...f.input,checklist:f.input.checklist.slice(1)},{...f.input,checklist:f.input.checklist.map(c=>({...c,item:'IDENTITY'}))},{...f.input,findings:{...f.input.findings,inspectorNotes:''}},{...f.input,snVerification:'MISMATCH'},{...f.input,checklist:f.input.checklist.map(c=>({...c,result:'NOT_TESTED',notes:''}))}])assert.equal((await f.complete('admin',payload)).status,400);
 await f.complete();assert.equal((await f.decide('APPROVED','admin',{reason:''})).status,400);assert.equal((await f.decide('PASS')).status,400);
});
test('recheck quarantine / repair / order context atomically on completion and decision',async()=>{
 for(const action of ['complete','decide'])for(const sql of ["UPDATE assets SET inventory_status='NORMAL'","UPDATE asset_locations SET custody='CUSTOMER'","UPDATE warehouse_locations SET code='OTHER' WHERE code='RETURN-QUARANTINE'","UPDATE orders SET status='shipped'","DELETE FROM asset_events WHERE event_type='repair_completed'"]){
  const f=await postRepairFixture();await f.start();await f.upload();if(action==='decide')await f.complete();const prior=row(f),original=f.db.batch.bind(f.db);f.db.batch=async statements=>{f.sqlite.exec(sql);return original(statements);};
  assert.equal((await(action==='complete'?f.complete():f.decide())).status,409);assert.deepEqual(row(f),prior);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM asset_certifications').get().n,1);
 }
});
test('APPROVED still blocks Listing / Allocation / ordinary inventory; physical quarantine remains',async()=>{
 const f=await postRepairFixture();await f.inspected();await f.decide();
 f.sqlite.exec("INSERT INTO orders(id,order_no,dealer_id,store_id,created_by,status,channel_id,sales_account_id,fulfilment_warehouse_id) VALUES('next-post-order','NEXT-POST','dealer','store','uk','approved','channel-ebay-uk','account-test','wh-uk')");
 assert.equal((await f.request('uk','/international/orders/next-post-order/bind-asset',{assetId})).status,409);
 assert.equal((await f.request('intl','/marketplace/listings',{assetId,channelId:'channel-ebay-uk',salesAccountId:'account-test',title:'Must remain quarantined',priceMinor:100,currency:'GBP'})).status,409);
 assert.equal((await(await f.request('uk','/international/warehouses/assets?warehouseId=wh-uk')).json()).assets.some(a=>a.assetId===assetId),false);
 assert.equal((await(await f.request('uk','/international/warehouses/return-quarantine')).json()).assets.some(a=>a.assetId===assetId),true);
 assert.throws(()=>f.sqlite.exec(`UPDATE asset_locations SET status='on_hand' WHERE asset_id='${assetId}'`),/quarantin/i);
 assert.throws(()=>f.sqlite.exec(`INSERT INTO international_asset_allocations(allocation_id,order_id,asset_id) VALUES('post-alloc','next-post-order','${assetId}')`),/quarantin/i);
});
test('public warranty remains canonical, private fields never leak, latest certification revocation never falls back to v1',async()=>{
 const f=await postRepairFixture();await f.inspected();await f.decide();const challenge=await(await f.request('uk','/public/warranty/challenges',{})).json();const solved=await(await f.request('uk',`/public/warranty/challenges/${challenge.challengeId}/complete`,{sliderValue:100})).json();
 const response=await f.request('uk',`/public/warranty/${assetCode}?challengeId=${challenge.challengeId}&token=${solved.token}&lang=en`);assert.equal(response.status,200);const text=await response.text();assert.match(text,/ACTIVE/);for(const banned of ['order-test','account-test','post_repair_inspection_id','verification_code_hash','inspectorNotes','UK Return Quarantine'])assert.equal(text.includes(banned),false,banned);
 f.sqlite.exec("UPDATE asset_certifications SET certification_status='revoked' WHERE version=2");const current=(await(await f.request('uk',`/international/assets/${assetId}`)).json()).asset;assert.equal(current.certificationStatus,'revoked');
 const retryChallenge=await(await f.request('uk','/public/warranty/challenges',{})).json(),retrySolved=await(await f.request('uk',`/public/warranty/challenges/${retryChallenge.challengeId}/complete`,{sliderValue:100})).json();
 assert.equal((await f.request('uk',`/public/warranty/${assetCode}?challengeId=${retryChallenge.challengeId}&token=${retrySolved.token}&lang=en`)).status,404);
});
test('DB preserves completed task/report/decision, prior issuance identity and historical evidence',async()=>{
 const f=await postRepairFixture();await f.inspected();await f.decide();const d=await f.data();
 for(const sql of ["UPDATE rma_post_repair_inspections SET status='IN_PROGRESS'","UPDATE rma_recertification_decisions SET decision='REJECTED'","DELETE FROM rma_recertification_decisions",`UPDATE asset_inspection_tasks SET assigned_to='uk' WHERE id='${d.inspection.taskId}'`,"UPDATE asset_certifications SET certification_date='2099-01-01' WHERE version=1","DELETE FROM asset_certifications WHERE version=1",`DELETE FROM asset_inspection_evidence WHERE inspection_task_id='${d.inspection.taskId}'`])assert.throws(()=>f.sqlite.exec(sql),/immutable|cannot be deleted/);
});
test('0042 preserves v1 IDs/values/events/foreign keys and does not enroll existing broad roles',()=>{
 const db=new DatabaseSync(':memory:'),root=new URL('../apps/api/migrations/',import.meta.url);for(const n of readdirSync(root).filter(n=>/^\d{4}.*\.sql$/.test(n)&&n<'0042').sort())db.exec(readFileSync(new URL(n,root),'utf8'));
 db.exec("PRAGMA foreign_keys=ON; INSERT INTO assets(id,asset_code) VALUES('history-asset','MC-HISTORY'); INSERT INTO asset_inspection_tasks(id,asset_id,status,result,grade,final_qc) VALUES('history-task','history-asset','completed','PASS','A',1); INSERT INTO asset_certifications(id,asset_id,inspection_task_id,grade,inspection_result,final_qc,verification_code_hash) VALUES('history-cert','history-asset','history-task','A','PASS',1,'old-hash'); INSERT INTO asset_events(id,asset_id,event_type,title) VALUES('history-event','history-asset','repair_completed','old-event');");
 const before=db.prepare('SELECT * FROM asset_certifications').get();db.exec(readFileSync(new URL('0042_post_repair_recertification.sql',root),'utf8'));const after=db.prepare('SELECT * FROM asset_certifications WHERE id=?').get('history-cert');for(const key of Object.keys(before))assert.equal(after[key],before[key]);assert.equal(after.version,1);assert.equal(db.prepare('SELECT title FROM asset_events WHERE id=?').get('history-event').title,'old-event');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM role_permissions p JOIN roles r ON r.id=p.role_id WHERE p.permission_code LIKE 'post-repair:%' AND r.code NOT IN('super_admin','post_repair_inspector','post_repair_certifier')").get().n,0);assert.equal(db.prepare("SELECT COUNT(*) n FROM user_roles WHERE role_id IN('role-post-repair-inspector','role-post-repair-certifier')").get().n,0);
});
