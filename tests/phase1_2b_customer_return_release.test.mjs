import assert from 'node:assert/strict';
import test from 'node:test';
import { assetId,postRepairFixture } from './helpers/postRepairFixture.mjs';

const reason='Synthetic test customer-return release. No physical shipment represented.';
async function approved(){const f=await postRepairFixture();await f.inspected();assert.equal((await f.decide()).status,200);return f;}
const endpoint=f=>`${f.base}/customer-return-release`;
const grant=(f,user)=>f.sqlite.prepare("INSERT OR IGNORE INTO user_roles(user_id,role_id) VALUES(?,'role-international-customer-return-manager')").run(user);
const release=(f,user='admin',value=reason)=>f.request(user,endpoint(f),{reason:value});
const count=(f,table,where='1=1')=>f.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get().n;

test('complete REPAIR and current APPROVED certification can be released to the original customer exactly once',async()=>{
 const f=await approved(),before={asset:f.sqlite.prepare('SELECT * FROM assets WHERE id=?').get(assetId),location:f.sqlite.prepare('SELECT * FROM asset_locations WHERE asset_id=?').get(assetId),
  repair:f.sqlite.prepare('SELECT * FROM rma_repair_executions WHERE rma_id=?').get(f.rma.id),
  order:f.sqlite.prepare("SELECT * FROM orders WHERE id='order-test'").get(),allocation:f.sqlite.prepare("SELECT * FROM international_asset_allocations WHERE order_id='order-test'").get()};
 const response=await release(f);assert.equal(response.status,200);const body=await response.json();
 assert.equal(body.state,'CUSTOMER_RETURN_RELEASED');assert.equal(body.release.reason,reason);assert.equal(body.inventory.inventoryStatus,'QUARANTINED');assert.equal(body.inventory.sellable,false);assert.equal(body.rmaOpen,true);
 assert.equal(count(f,'rma_customer_return_releases'),1);assert.equal(count(f,'asset_events',"event_type='customer_return_released'"),1);assert.equal(count(f,'audit_logs',"action='international.rma.customer_return_release'"),1);
 const repeated=await release(f);assert.equal(repeated.status,200);assert.equal((await repeated.json()).release.releasedAt,body.release.releasedAt);
 assert.equal(count(f,'rma_customer_return_releases'),1);assert.equal(count(f,'asset_events',"event_type='customer_return_released'"),1);assert.equal(count(f,'audit_logs',"action='international.rma.customer_return_release'"),1);
 assert.deepEqual(f.sqlite.prepare('SELECT * FROM assets WHERE id=?').get(assetId),before.asset);assert.deepEqual(f.sqlite.prepare('SELECT * FROM asset_locations WHERE asset_id=?').get(assetId),before.location);
 assert.deepEqual(f.sqlite.prepare('SELECT * FROM rma_repair_executions WHERE rma_id=?').get(f.rma.id),before.repair);
 assert.deepEqual(f.sqlite.prepare("SELECT * FROM orders WHERE id='order-test'").get(),before.order);assert.deepEqual(f.sqlite.prepare("SELECT * FROM international_asset_allocations WHERE order_id='order-test'").get(),before.allocation);
 assert.throws(()=>f.sqlite.prepare("INSERT INTO marketplace_listings(id,asset_id,channel_id,sales_account_id,external_listing_id,title,status) VALUES('blocked-listing',?,'channel-ebay-uk','account-test','blocked','blocked','draft')").run(assetId),/QUARANTINED/);
 assert.throws(()=>f.sqlite.prepare("INSERT INTO international_asset_allocations(allocation_id,order_id,asset_id,status) VALUES('blocked-allocation','order-test',?,'reserved')").run(assetId),/QUARANTINED/);
});

test('release permission is explicit and all existing scopes still apply',async()=>{
 const denied=await approved();for(const user of ['uk','cn','cert','intl'])assert.equal((await release(denied,user)).status,403,user);
 const allowed=await approved();grant(allowed,'intl');assert.equal((await release(allowed,'intl')).status,200);
 for(const user of ['other','wrongWarehouse','wrongMarket']){const f=await approved();grant(f,user);assert.equal((await release(f,user)).status,403,user);}
});

test('current certification semantics reject revoked latest version and never fall back to v1',async()=>{
 const f=await approved();const current=f.sqlite.prepare('SELECT id,version FROM current_asset_certifications WHERE asset_id=?').get(assetId);assert.equal(current.version,2);
 f.sqlite.prepare("UPDATE asset_certifications SET certification_status='revoked' WHERE id=?").run(current.id);
 const response=await release(f);assert.equal(response.status,409);assert.equal(count(f,'rma_customer_return_releases'),0);
 const detail=await f.request('admin',endpoint(f));assert.equal(detail.status,200);assert.match((await detail.json()).blockingReason,/Certification/);
});

test('wrong resolution, incomplete repair or reinspection, and suspended latest certification are rejected',async(t)=>{
 await t.test('wrong resolution',async()=>{const f=await postRepairFixture({resolution:'REPLACE'});assert.equal((await release(f)).status,409);});
 await t.test('repair incomplete',async()=>{const f=await postRepairFixture({repair:'not_started'});assert.equal((await release(f)).status,409);});
 await t.test('reinspection incomplete',async()=>{const f=await postRepairFixture();assert.equal((await release(f)).status,409);});
 await t.test('latest certification suspended',async()=>{const f=await approved();f.sqlite.prepare("UPDATE asset_certifications SET certification_status='suspended' WHERE id=(SELECT id FROM current_asset_certifications WHERE asset_id=?)").run(assetId);assert.equal((await release(f)).status,409);});
 await t.test('wrong custody',async()=>{const f=await approved();f.sqlite.prepare("UPDATE asset_locations SET custody='SERVICE_CENTER' WHERE asset_id=?").run(assetId);assert.equal((await release(f)).status,409);});
 await t.test('quarantine removed',async()=>{const f=await approved();f.sqlite.prepare("UPDATE assets SET inventory_status='NORMAL' WHERE id=?").run(assetId);assert.equal((await release(f)).status,409);});
});

test('rejected or missing recertification, wrong physical state, transfer, allocation, and outbound shipment block release',async(t)=>{
 await t.test('rejected',async()=>{const f=await postRepairFixture();await f.inspected();assert.equal((await f.decide('REJECTED')).status,200);assert.equal((await release(f)).status,409);});
 await t.test('missing',async()=>{const f=await postRepairFixture();await f.inspected();assert.equal((await release(f)).status,409);});
 await t.test('wrong warehouse',async()=>{const f=await approved();f.sqlite.prepare("UPDATE asset_locations SET warehouse_id='wh-cn-sd',location_id=NULL WHERE asset_id=?").run(assetId);assert.equal((await release(f)).status,409);});
 await t.test('active transfer',async()=>{const f=await approved();f.sqlite.prepare("INSERT INTO asset_transfers(id,asset_id,from_warehouse_id,to_warehouse_id,status,created_by) VALUES('transfer-conflict',?,'wh-uk','wh-cn-sd','created','admin')").run(assetId);assert.equal((await release(f)).status,409);});
 await t.test('reserved allocation',async()=>{const f=await approved();f.sqlite.prepare("UPDATE assets SET inventory_status='NORMAL' WHERE id=?").run(assetId);f.sqlite.prepare("INSERT INTO international_asset_allocations(allocation_id,order_id,asset_id,status) VALUES('reserved-conflict','order-test',?,'reserved')").run(assetId);f.sqlite.prepare("UPDATE assets SET inventory_status='QUARANTINED' WHERE id=?").run(assetId);assert.equal((await release(f)).status,409);});
 await t.test('outbound shipment exists',async()=>{const f=await approved();f.sqlite.prepare("UPDATE after_sales_cases SET outbound_shipped_at='2026-10-07T00:00:00.000Z' WHERE id=?").run(f.rma.id);assert.equal((await release(f)).status,409);});
});

test('conflicting retry is 409 and concurrent identical retry creates one immutable fact',async()=>{
 const f=await approved();const responses=await Promise.all([release(f),release(f)]);assert.deepEqual(responses.map(value=>value.status).sort(),[200,200]);
 assert.equal(count(f,'rma_customer_return_releases'),1);assert.equal(count(f,'asset_events',"event_type='customer_return_released'"),1);assert.equal(count(f,'audit_logs',"action='international.rma.customer_return_release'"),1);
 assert.equal((await release(f,'admin','Different reason must not overwrite the first release.')).status,409);
 assert.throws(()=>f.sqlite.prepare("UPDATE rma_customer_return_releases SET release_reason='tampered'").run(),/immutable/);
 const conflicting=await approved();const raced=await Promise.all([release(conflicting,'admin','Concurrent reason A'),release(conflicting,'admin','Concurrent reason B')]);
 assert.deepEqual(raced.map(value=>value.status).sort(),[200,409]);assert.equal(count(conflicting,'rma_customer_return_releases'),1);
});

test('guarded batch rolls back release, lifecycle, and audit together',async()=>{
 const f=await approved();f.sqlite.exec("CREATE TRIGGER fail_customer_return_audit BEFORE INSERT ON audit_logs WHEN NEW.action='international.rma.customer_return_release' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END;");
 const response=await release(f);assert.equal(response.status,500);assert.equal(count(f,'rma_customer_return_releases'),0);assert.equal(count(f,'asset_events',"event_type='customer_return_released'"),0);assert.equal(count(f,'audit_logs',"action='international.rma.customer_return_release'"),0);
});
