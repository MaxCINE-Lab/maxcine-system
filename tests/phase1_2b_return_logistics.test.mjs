import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { URL } from 'node:url';
import { deliveryFixture } from './helpers/deliveryFixture.mjs';

const assetId = '43000000-0000-4000-8000-000000000099';
const assetCode = 'MC-26-TEST-000099';
const shipment = { carrier: 'Royal Mail', returnTracking: 'RM-RETURN-LOGISTICS' };
async function fixture() {
  const f = await deliveryFixture(); f.certify(); await f.ship(); assert.equal((await f.deliver()).status,200);
  const response = await f.request('uk','/international/rmas',{ orderId:'order-test',assetId,reason:'DEFECTIVE',returnWarehouseId:'wh-uk' });
  assert.equal(response.status,200); const { rma }=await response.json();
  const ship = (user='uk',input=shipment) => f.request(user,`/international/rmas/${rma.id}/return-shipment`,input);
  const receive = (user='uk',code=assetCode) => f.request(user,`/international/rmas/${rma.id}/receive-return`,{ assetCode:code });
  return { ...f,rma,shipReturn:ship,receive };
}
const count=(f,event)=>f.sqlite.prepare('SELECT COUNT(*) AS n FROM asset_events WHERE event_type=?').get(event).n;
const invariant=(f)=>({ records:['orders','international_asset_allocations','asset_certifications','asset_public_warranties','asset_public_warranty_entitlements'].map((table)=>f.sqlite.prepare(`SELECT * FROM ${table}`).all()),
  warranty:f.sqlite.prepare('SELECT asset_status,warranty_start_at,warranty_end_at,warranty_override_status,certified_warranty_policy_code,warranty_source_order_id,warranty_activated_at FROM assets').all() });

test('normal return shipment then UK receipt records reverse chain and quarantines without changing original business history',async()=>{
  const f=await fixture(); const original=invariant(f);
  const shipped=await f.shipReturn(); assert.equal(shipped.status,200); const {rma}=await shipped.json();
  assert.equal(rma.businessStatus,'RETURN_IN_TRANSIT'); assert.equal(rma.custody,'RETURN_TRANSIT'); assert.equal(rma.locationStatus,'in_transit'); assert.ok(rma.shippedAt); assert.equal(rma.returnTracking,shipment.returnTracking);
  let queue=await (await f.request('uk','/international/rmas/awaiting-return-receipt')).json(); assert.equal(queue.rmas.length,1);
  assert.equal((await f.receive()).status,200); const detail=(await (await f.request('uk',`/international/rmas/${f.rma.id}`)).json()).rma;
  assert.equal(detail.businessStatus,'RECEIVED'); assert.equal(detail.custody,'WAREHOUSE'); assert.equal(detail.inventoryStatus,'QUARANTINED'); assert.equal(detail.locationStatus,'returned'); assert.equal(detail.locationCode,'RETURN-QUARANTINE'); assert.ok(detail.receivedAt);
  const l=f.sqlite.prepare('SELECT * FROM asset_locations').get(); assert.equal(l.warehouse_id,'wh-uk'); assert.equal(l.location_id,'loc-uk-return-quarantine');
  queue=await (await f.request('uk','/international/rmas/awaiting-return-receipt')).json(); assert.deepEqual(queue.rmas,[]);
  const quarantine=await (await f.request('uk','/international/warehouses/return-quarantine')).json(); assert.equal(quarantine.assets[0].assetStatus,'QUARANTINED'); assert.equal(quarantine.assets[0].assetCode,assetCode);
  const sellable=await (await f.request('uk','/international/warehouses/assets?warehouseId=wh-uk')).json(); assert.deepEqual(sellable.assets,[]);
  assert.deepEqual(invariant(f),original); assert.equal(count(f,'return_shipped'),1); assert.equal(count(f,'return_received'),1);
  const events=f.sqlite.prepare("SELECT * FROM asset_events WHERE source='international-return-logistics'").all();
  for(const e of events){ const m=JSON.parse(e.new_value_json); assert.equal(m.rma_id,f.rma.id); assert.equal(m.return_tracking,shipment.returnTracking); assert.equal(m.order_id,'order-test'); }
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action IN ('international.rma.return_shipped','international.rma.return_received')").get().n,2);
});

test('wrong Asset cannot receive; cannot skip shipment; carrier and tracking required',async()=>{
  const f=await fixture(); assert.equal((await f.receive()).status,409);
  for(const input of [{carrier:'',returnTracking:'x'},{carrier:'Royal Mail',returnTracking:''},{...shipment,receivedAt:'2020-01-01'}]) assert.equal((await f.shipReturn('uk',input)).status,400);
  assert.equal((await f.shipReturn()).status,200);
  const before=f.sqlite.prepare('SELECT * FROM asset_locations').all(); assert.equal((await f.receive('uk','MC-WRONG-000000')).status,409); assert.deepEqual(f.sqlite.prepare('SELECT * FROM asset_locations').all(),before); assert.equal(count(f,'return_received'),0);
  assert.equal((await f.receive('uk',` ${assetCode.toLowerCase()} `)).status,200);
  assert.equal((await f.receive('uk','MC-WRONG-000000')).status,409);
});

test('shipment and receipt retries are idempotent including shipment retry after receipt',async()=>{
  const f=await fixture(); const first=(await (await f.shipReturn()).json()).rma;
  for(let i=0;i<3;i++) assert.deepEqual((await (await f.shipReturn()).json()).rma,first);
  assert.equal((await f.shipReturn('uk',{...shipment,returnTracking:'OTHER'})).status,409);
  const received=(await (await f.receive()).json()).rma;
  for(let i=0;i<3;i++) assert.deepEqual((await (await f.receive()).json()).rma,received);
  assert.equal((await (await f.shipReturn()).json()).rma.shippedAt,first.shippedAt);
  assert.equal(count(f,'return_shipped'),1); assert.equal(count(f,'return_received'),1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action LIKE 'international.rma.return_%'").get().n,2);
});

test('CN, Certified, unauthorized account, wrong Warehouse and Market are 403 before and after receiving',async()=>{
  const f=await fixture();
  for(const user of ['cn','cert','other','wrongWarehouse','wrongMarket']){
    assert.equal((await f.shipReturn(user)).status,403,user); assert.equal((await f.receive(user)).status,403,user);
  }
  assert.equal((await f.receive('intl')).status,403,'International role without UK receiving grant');
  assert.equal((await f.shipReturn('intl')).status,200); assert.equal((await f.receive()).status,200);
  for(const user of ['cn','cert','other','wrongWarehouse','wrongMarket']){
    assert.equal((await f.shipReturn(user)).status,403); assert.equal((await f.receive(user)).status,403);
  }
  for(const user of ['other','wrongWarehouse','wrongMarket']) assert.deepEqual((await (await f.request(user,'/international/warehouses/return-quarantine')).json()).assets,[]);
});

test('quarantine is a durable DB sales hold: API/direct allocation, new and activated listing, sellable location blocked',async()=>{
  const f=await fixture();
  f.sqlite.exec(`INSERT INTO marketplace_listings (id,asset_id,channel_id,sales_account_id,title,status,price_minor) VALUES ('43000000-0000-4000-8000-000000000090','${assetId}','channel-ebay-uk','account-test','Old draft','draft',100);`);
  await f.shipReturn(); await f.receive();
  f.sqlite.exec("INSERT INTO orders (id,order_no,dealer_id,store_id,created_by,status,channel_id,sales_account_id,fulfilment_warehouse_id) VALUES ('next-order','NEXT','dealer','store','uk','approved','channel-ebay-uk','account-test','wh-uk')");
  assert.equal((await f.request('uk','/international/orders/next-order/bind-asset',{assetId})).status,409);
  const listing={assetId,channelId:'channel-ebay-uk',salesAccountId:'account-test',title:'Do not sell returned device',priceMinor:100,currency:'GBP'};
  assert.equal((await f.request('intl','/marketplace/listings',listing)).status,409);
  assert.equal((await f.request('intl','/marketplace/listings/43000000-0000-4000-8000-000000000090/activate',{})).status,409);
  assert.throws(()=>f.sqlite.exec(`INSERT INTO international_asset_allocations (allocation_id,asset_id,order_id,status) VALUES ('bad-reservation','${assetId}','next-order','reserved')`),/QUARANTINED/);
  assert.throws(()=>f.sqlite.exec("UPDATE marketplace_listings SET status='active'"),/QUARANTINED/);
  assert.throws(()=>f.sqlite.exec(`INSERT INTO marketplace_listings (id,asset_id,channel_id,sales_account_id,title,price_minor) VALUES ('bad-listing','${assetId}','channel-ebay-uk','account-test','Bad',100)`),/QUARANTINED/);
  assert.throws(()=>f.sqlite.exec("UPDATE asset_locations SET status='on_hand'"),/QUARANTINED/);
  assert.equal(f.sqlite.prepare('SELECT inventory_status FROM assets').get().inventory_status,'QUARANTINED');
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM international_asset_allocations WHERE status='fulfilled'").get().n,1);
});

test('each event or audit write failure rolls back the whole logistics action',async()=>{
  for(const receive of [false,true]) for(const table of ['asset_events','audit_logs']){
    const f=await fixture(); if(receive) await f.shipReturn();
    const before=['after_sales_cases','assets','asset_locations'].map((t)=>f.sqlite.prepare(`SELECT * FROM ${t}`).all());
    f.sqlite.exec(`CREATE TRIGGER fail_return BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'test logistics write failure'); END`);
    assert.equal((await (receive?f.receive():f.shipReturn())).status,500);
    assert.deepEqual(['after_sales_cases','assets','asset_locations'].map((t)=>f.sqlite.prepare(`SELECT * FROM ${t}`).all()),before);
    assert.equal(count(f,receive?'return_received':'return_shipped'),0);
  }
});

test('atomic guards reject stale custody, closed case, broken sale link or inactive return warehouse',async()=>{
  for(const mutation of ["UPDATE asset_locations SET custody='IN_TRANSIT'","UPDATE after_sales_cases SET status='closed'","UPDATE international_asset_allocations SET status='released'","UPDATE warehouses SET status='inactive' WHERE id='wh-uk'"]){
    const f=await fixture(); const original=f.db.batch.bind(f.db); f.db.batch=async(statements)=>{f.sqlite.exec(mutation);return original(statements);};
    assert.equal((await f.shipReturn()).status,409); assert.equal(count(f,'return_shipped'),0);
  }
  const f=await fixture(); await f.shipReturn(); const original=f.db.batch.bind(f.db);
  f.db.batch=async(statements)=>{f.sqlite.exec("UPDATE asset_locations SET custody='CUSTOMER'");return original(statements);};
  assert.equal((await f.receive()).status,409); assert.equal(count(f,'return_received'),0); assert.equal(f.sqlite.prepare('SELECT inventory_status FROM assets').get().inventory_status,'NORMAL');
});

test('interleaved duplicate shipment/receipt converges to one successful event and original timestamp',async()=>{
  for(const receive of [false,true]){
    const f=await fixture(); if(receive) await f.shipReturn(); const original=f.db.batch.bind(f.db); let raced=false; let committed;
    f.db.batch=async(statements)=>{if(!raced){raced=true;committed=(await (await (receive?f.receive():f.shipReturn())).json()).rma;} return original(statements);};
    const response=await (receive?f.receive():f.shipReturn()); assert.equal(response.status,200); assert.deepEqual((await response.json()).rma,committed); assert.equal(count(f,receive?'return_received':'return_shipped'),1);
  }
});

test('0038 preserves all historical lifecycle rows and warranty unique activation constraint',async()=>{
  const f=await fixture(); assert.equal(count(f,'customer_delivered'),1); assert.equal(count(f,'warranty_activated'),1);
  assert.throws(()=>f.sqlite.exec(`INSERT INTO asset_events (id,asset_id,event_type,title,related_order_id,source) VALUES ('duplicate','${assetId}','warranty_activated','Duplicate','order-test','certified-sale-delivery')`),/UNIQUE/);
  // Validate migration with real foreign keys separately; the route fixture
  // intentionally omits unrelated legacy Dealer/Store records.
  const db=new DatabaseSync(':memory:'); const root=new URL('../apps/api/migrations/',import.meta.url);
  for(const name of readdirSync(root).filter((name)=>/^\d{4}.*\.sql$/.test(name)&&name<'0038').sort()) db.exec(readFileSync(new URL(name,root),'utf8'));
  db.exec(`INSERT INTO assets (id,asset_code) VALUES ('migration-asset','MC-MIGRATION'); INSERT INTO asset_events (id,asset_id,event_type,title) VALUES ('old-event','migration-asset','note_added','Preserve me');`);
  const old=db.prepare('SELECT * FROM asset_events').all(); db.exec(readFileSync(new URL('0038_international_return_logistics.sql',root),'utf8'));
  assert.deepEqual(db.prepare('SELECT * FROM asset_events').all(),old); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
});
