import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

// Staging only. No configurable Production endpoint.
const api='https://maxcine-api-staging.maxcine-lab.workers.dev';
const web='https://maxcine-web-staging.pages.dev';
const reference='MC-RMA-26-000001'; const assetId='43000000-0000-4000-8000-000000000012';
const assetCode='MC-26-P12A-000012'; const orderId='44000000-0000-4000-8000-000000000003';
const directory='test-results/return-logistics-staging'; await mkdir(directory,{recursive:true});
async function login(persona){
  const response=await fetch(`${api}/dev/quick-login`,{method:'POST',headers:{Origin:web,'Content-Type':'application/json'},body:JSON.stringify({persona})});
  assert.equal(response.status,200,persona); const cookie=response.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
  return async(path,body)=>fetch(`${api}${path}`,{method:body?'POST':'GET',headers:{Cookie:cookie,Origin:web,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
}
const uk=await login('UK_FULFILMENT'); const admin=await login('ADMIN');
const get=async(request,path)=>{const response=await request(path);assert.equal(response.status,200,path);return response.json();};
const list=await get(uk,'/international/rmas'); const initial=list.rmas.find((rma)=>rma.rmaReference===reference); assert.ok(initial,'Use existing authorized RMA fixture');
const rmaId=initial.id;
const before=await get(admin,`/assets/${assetId}`); const originalOrder=(await get(uk,`/international/orders/${orderId}`)).order;
const beforeInternational=await get(uk,`/international/assets/${assetId}`);
const warrantyKeys=['warrantyStartAt','warrantyEndAt','warrantyPolicy','warrantyOverrideStatus','warrantyOverrideReason','assetStatus','currentSn','originalSn'];
const warrantySnapshot=(result)=>Object.fromEntries(warrantyKeys.map((key)=>[key,result.asset[key]]));
const shippedInput={carrier:'Royal Mail',returnTracking:'RM-STG-RETURN-000012'};
for(const persona of ['CN_SD_WAREHOUSE','CERTIFIED']){
  const request=await login(persona);
  assert.equal((await request(`/international/rmas/${rmaId}/return-shipment`,shippedInput)).status,403,`${persona} shipment`);
  assert.equal((await request(`/international/rmas/${rmaId}/receive-return`,{assetCode})).status,403,`${persona} receive`);
}
const intl=await login('INTERNATIONAL');
assert.equal((await intl(`/international/rmas/${rmaId}/receive-return`,{assetCode})).status,403,'No dedicated UK receiving permission');
if(!initial.shippedAt) assert.equal((await uk(`/international/rmas/${rmaId}/receive-return`,{assetCode})).status,409,'Cannot skip return shipment');
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1150}});
let browserShipped=false; let browserReceived=false; let mismatchBlocked=false;
try{
  await page.goto(web,{waitUntil:'networkidle'}); await page.getByRole('button',{name:/^英国履约/}).click();
  await page.locator('.system-main').waitFor(); await page.waitForLoadState('networkidle');
  await page.goto(`${web}/#/system/uk-fulfilment/rmas/${rmaId}`);
  if(!initial.shippedAt){
    await page.getByRole('heading',{name:'Record Return Shipment',exact:true}).waitFor();
    await page.getByLabel('Return Carrier',{exact:true}).fill(shippedInput.carrier);
    await page.getByLabel('Return Tracking',{exact:true}).fill(shippedInput.returnTracking);
    await page.screenshot({path:`${directory}/shipment-form.png`,fullPage:true});
    await page.getByRole('button',{name:'确认客户已寄回',exact:true}).click();
    await page.getByRole('heading',{name:'客户退货已寄回',exact:true}).waitFor(); browserShipped=true;
    await page.screenshot({path:`${directory}/in-transit.png`,fullPage:true});
  }
  const shipped=(await get(uk,`/international/rmas/${rmaId}`)).rma;
  assert.ok(shipped.shippedAt);
  const repeatInput={carrier:shipped.carrier,returnTracking:shipped.returnTracking};
  for(let n=0;n<3;n++){
    const response=await uk(`/international/rmas/${rmaId}/return-shipment`,repeatInput); assert.equal(response.status,200); assert.equal((await response.json()).rma.shippedAt,shipped.shippedAt);
  }
  if(!shipped.receivedAt){
    assert.equal(shipped.custody,'RETURN_TRANSIT'); assert.equal(shipped.businessStatus,'RETURN_IN_TRANSIT');
    await page.goto(`${web}/#/system/uk-fulfilment/return-receiving`);
    await page.getByRole('row').filter({hasText:reference}).getByRole('link',{name:'打开收货',exact:true}).click();
    await page.getByLabel('输入 Asset Code',{exact:true}).fill('MC-WRONG-000000');
    await page.getByText('Asset 不匹配',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'确认退货收货',exact:true}).isDisabled(),true);
    const rejected=await uk(`/international/rmas/${rmaId}/receive-return`,{assetCode:'MC-WRONG-000000'}); assert.equal(rejected.status,409); mismatchBlocked=true;
    assert.equal((await get(uk,`/international/rmas/${rmaId}`)).rma.receivedAt,null);
    await page.screenshot({path:`${directory}/wrong-asset.png`,fullPage:true});
    await page.getByLabel('输入 Asset Code',{exact:true}).fill(assetCode); await page.getByText('设备匹配',{exact:true}).waitFor();
    await page.screenshot({path:`${directory}/matched.png`,fullPage:true});
    await page.getByRole('button',{name:'确认退货收货',exact:true}).click(); browserReceived=true;
    await page.getByRole('heading',{name:'UK 退货收货完成',exact:true}).waitFor();
    await page.screenshot({path:`${directory}/received.png`,fullPage:true});
    await page.getByRole('link',{name:'查看 UK 隔离库存',exact:true}).click();
  }else await page.goto(`${web}/#/system/uk-fulfilment/return-quarantine`);
  const stockRow=page.getByRole('row').filter({hasText:assetCode}); await stockRow.waitFor();
  await stockRow.getByText('QUARANTINED',{exact:true}).waitFor();
  await page.screenshot({path:`${directory}/quarantine.png`,fullPage:true});
  await page.goto(`${web}/#/system/uk-fulfilment/inventory`); await page.waitForLoadState('networkidle');
  assert.equal(await page.getByRole('row').filter({hasText:assetCode}).count(),0);
  await page.screenshot({path:`${directory}/sellable-inventory.png`,fullPage:true});
}catch(error){ await page.screenshot({path:`${directory}/failure.png`,fullPage:true});await writeFile(`${directory}/failure-page.txt`,`${page.url()}\n${await page.locator('body').innerText()}`);throw error; }
finally{await browser.close();}
const final=(await get(uk,`/international/rmas/${rmaId}`)).rma;
assert.equal(final.businessStatus,'RECEIVED');assert.equal(final.custody,'WAREHOUSE');assert.equal(final.inventoryStatus,'QUARANTINED');assert.equal(final.locationStatus,'returned');assert.equal(final.locationCode,'RETURN-QUARANTINE');assert.ok(final.receivedAt);
for(let n=0;n<3;n++){
  const response=await uk(`/international/rmas/${rmaId}/receive-return`,{assetCode});assert.equal(response.status,200);assert.deepEqual((await response.json()).rma,final);
}
assert.equal((await uk(`/international/rmas/${rmaId}/receive-return`,{assetCode:'MC-WRONG-000000'})).status,409);
assert.ok(!(await get(uk,'/international/rmas/awaiting-return-receipt')).rmas.some((rma)=>rma.id===rmaId));
assert.ok(!(await get(uk,'/international/warehouses/assets?warehouseId=wh-uk')).assets.some((asset)=>asset.assetId===assetId));
const quarantined=(await get(uk,'/international/warehouses/return-quarantine')).assets.find((asset)=>asset.assetId===assetId);
assert.equal(quarantined.warehouse,'UK');assert.equal(quarantined.location,'UK Return Quarantine');
const after=await get(admin,`/assets/${assetId}`);const order=(await get(uk,`/international/orders/${orderId}`)).order;
assert.deepEqual(warrantySnapshot(after),warrantySnapshot(before));assert.deepEqual(after.certifiedWarranty,before.certifiedWarranty);assert.deepEqual(after.publicWarranty,before.publicWarranty);
for(const field of ['status','allocationStatus','deliveredAt','carrier','trackingNumber','shippedAt'])assert.equal(order[field],originalOrder[field],field);
const asset=await get(uk,`/international/assets/${assetId}`);
assert.equal(asset.asset.warehouseCode,'UK');assert.equal(asset.asset.assetStatus,'QUARANTINED');assert.equal(asset.asset.certificationStatus,beforeInternational.asset.certificationStatus);assert.equal(asset.asset.grade,beforeInternational.asset.grade);
for(const eventType of ['rma_opened','return_shipped','return_received'])assert.equal(asset.events.filter((event)=>event.eventType===eventType).length,1);
// A quarantined Asset must be rejected before even a draft Listing is created.
const listing=await admin('/marketplace/listings',{assetId,channelId:'channel-ebay-uk',salesAccountId:'account-ebay-uk-staging',title:'Blocked quarantine validation',priceMinor:100,currency:'GBP'});assert.equal(listing.status,409);
const blockedAllocation=await admin('/international/orders/43000000-0000-4000-8003-000000000012/bind-asset',{assetId});
assert.equal(blockedAllocation.status,409);assert.match(await blockedAllocation.text(),/Quarantine/);
const report={environment:'GitHub Actions / Staging only',rmaReference:reference,assetCode,status:final.businessStatus,custody:final.custody,inventoryStatus:final.inventoryStatus,locationStatus:final.locationStatus,warehouse:quarantined.warehouse,location:quarantined.location,shippedAt:final.shippedAt,receivedAt:final.receivedAt,tracking:final.returnTracking,browserShipped,browserReceived,mismatchBlocked,shipmentRetries:3,receiveRetries:3,lifecycle:'rma_opened x1 / return_shipped x1 / return_received x1',warrantyUnchanged:true,publicWarrantyUnchanged:true,originalOrderUnchanged:true,originalAllocationUnchanged:true,originalCertificationUnchanged:true,sellableInventoryExcluded:true,awaitingReceiptExcluded:true,newListingBlocked:true,newAllocationBlocked:true,scope403:['CN_SD_WAREHOUSE','CERTIFIED','INTERNATIONAL without UK receiving grant']};
await writeFile(`${directory}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
