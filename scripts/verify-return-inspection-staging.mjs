import assert from 'node:assert/strict';
import { mkdir,writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

// Fixed Staging endpoints; no Production override is supported.
const api='https://maxcine-api-staging.maxcine-lab.workers.dev';const web='https://maxcine-web-staging.pages.dev';
const assetId='43000000-0000-4000-8000-000000000012';const assetCode='MC-26-P12A-000012';const reference='MC-RMA-26-000001';
const directory='test-results/return-inspection-staging';await mkdir(directory,{recursive:true});
async function login(persona){
  const response=await fetch(`${api}/dev/quick-login`,{method:'POST',headers:{Origin:web,'Content-Type':'application/json'},body:JSON.stringify({persona})});assert.equal(response.status,200,persona);
  const cookie=response.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);
  return (path,body)=>fetch(`${api}${path}`,{method:body?'POST':'GET',headers:{Cookie:cookie,Origin:web,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
}
const uk=await login('UK_FULFILMENT');const admin=await login('ADMIN');
const get=async(request,path)=>{const response=await request(path);assert.equal(response.status,200,path);return response.json();};
const rma=(await get(uk,'/international/rmas')).rmas.find((r)=>r.rmaReference===reference);assert.ok(rma,'Existing Staging RMA required');
const base=`/international/rmas/${rma.id}/inspection`;const before=await get(admin,`/assets/${assetId}`);
const originalInternational=await get(uk,`/international/assets/${assetId}`);const originalOrder=(await get(uk,`/international/orders/${rma.orderId}`)).order;
for(const persona of ['CN_SD_WAREHOUSE','CERTIFIED','INTERNATIONAL']){
  const request=await login(persona);assert.equal((await request(`${base}/start`,{assetCode})).status,403);assert.equal((await request(base)).status,403);
}
assert.equal((await uk(`${base}/start`,{assetCode:'MC-WRONG-000000'})).status,409);
const initial=await get(uk,base);
const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1150}});
let browserStarted=false;let browserCompleted=false;let mismatchBlocked=false;let evidencePreview=false;
try{
  await page.goto(web,{waitUntil:'networkidle'});await page.getByRole('button',{name:/^英国履约/}).click();await page.locator('.system-main').waitFor();await page.waitForLoadState('networkidle');
  await page.goto(`${web}/#/system/uk-fulfilment/rmas/${rma.id}`);
  const section=page.locator('section').filter({has:page.getByRole('heading',{name:/^(RMA Return Inspection|Return Inspection · 检测已完成)$/})});
  await section.waitFor();
  if(initial.inspection?.status!=='INSPECTION_COMPLETED'){
    await page.getByLabel('Inspection Asset Code',{exact:true}).fill('MC-WRONG-000000');await section.getByText('Asset 不匹配',{exact:true}).waitFor();
    const blockedButton=page.getByRole('button',{name:initial.inspection?'Submit Inspection':'Start Inspection',exact:true});assert.equal(await blockedButton.isDisabled(),true);mismatchBlocked=true;
    await page.screenshot({path:`${directory}/wrong-asset.png`,fullPage:true});
    await page.getByLabel('Inspection Asset Code',{exact:true}).fill(assetCode);await section.getByText('设备匹配',{exact:true}).waitFor();
    if(!initial.inspection){await page.getByRole('button',{name:'Start Inspection',exact:true}).click();await section.getByText('INSPECTION_IN_PROGRESS',{exact:true}).waitFor();browserStarted=true;}
    const current=(await get(uk,base)).inspection;assert.ok(current);assert.equal(current.status,'INSPECTION_IN_PROGRESS');
    await page.getByLabel('Observed SN',{exact:true}).fill(current.expectedSn || '');await page.getByLabel('SN Verification',{exact:true}).selectOption(current.expectedSn?'MATCH':'NOT_TESTED');
    for(const item of ['IDENTITY','EXTERIOR','DISPLAY','LENS_CAMERA','POWER','FUNCTIONAL','ACCESSORIES','RETURN_REASON']){
      const result=item==='DISPLAY'?'NOT_APPLICABLE':item==='FUNCTIONAL'?'FAIL':'PASS';await page.getByLabel(`${item} Result`,{exact:true}).selectOption(result);
      await page.getByLabel(`${item} Notes`,{exact:true}).fill(item==='IDENTITY'&&!current.expectedSn?'SN not recorded in Staging fixture':item==='DISPLAY'?'No integrated display on this fixture':item==='FUNCTIONAL'?'Staging inspection fixture: customer-reported issue reproduced':'Staging acceptance observation');
    }
    await page.getByLabel('Issue Reproduced',{exact:true}).selectOption('YES');await page.getByLabel('Condition Assessment',{exact:true}).selectOption('FUNCTIONAL_DEFECT');
    await page.getByLabel('Inspector Notes',{exact:true}).fill('Staging-only synthetic inspection/evidence. Facts recorded; no liability or resolution decision. Keep UK quarantine.');
    assert.equal(await page.getByRole('button',{name:'Submit Inspection',exact:true}).isDisabled(),!current.evidence.some((e)=>e.category==='OVERALL_CONDITION'));
    if(!current.evidence.some((e)=>e.category==='OVERALL_CONDITION')){
      await page.getByLabel('Evidence Category',{exact:true}).selectOption('OVERALL_CONDITION');
      // A tiny synthetic test photo exercises the private upload path; not a
      // claim that a physical customer-returned device was inspected remotely.
      await page.getByLabel('Inspection Photo',{exact:true}).setInputFiles({name:'staging-synthetic-overall.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5XcAAAAASUVORK5CYII=','base64')});
      await page.getByRole('button',{name:'上传照片',exact:true}).click();await section.locator('.certified-evidence-card').first().waitFor();
    }
    const img=section.locator('.certified-evidence-card img').first();await img.waitFor();await img.evaluate((image)=>image.decode());evidencePreview=await img.evaluate((image)=>image.naturalWidth>0);assert.ok(evidencePreview);
    await page.screenshot({path:`${directory}/inspection-form.png`,fullPage:true});
    const finalButton=page.getByRole('button',{name:'Submit Inspection',exact:true});assert.equal(await finalButton.isEnabled(),true);await finalButton.click();browserCompleted=true;
  }
  await page.getByRole('heading',{name:'Return Inspection · 检测已完成',exact:true}).waitFor();await section.getByText('INSPECTION_COMPLETED',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Submit Inspection',exact:true}).count(),0);await page.screenshot({path:`${directory}/completed-report.png`,fullPage:true});
  await page.reload({waitUntil:'networkidle'});await page.getByRole('heading',{name:'Return Inspection · 检测已完成',exact:true}).waitFor();
  const image=page.locator('.certified-evidence-card img').first();await image.evaluate((img)=>img.decode());evidencePreview=await image.evaluate((img)=>img.naturalWidth>0);
  await page.goto(`${web}/#/system/uk-fulfilment/return-quarantine`);await page.getByRole('row').filter({hasText:assetCode}).getByText('QUARANTINED',{exact:true}).waitFor();await page.screenshot({path:`${directory}/quarantine-preserved.png`,fullPage:true});
}catch(error){await page.screenshot({path:`${directory}/failure.png`,fullPage:true});await writeFile(`${directory}/failure-page.txt`,`${page.url()}\n${await page.locator('body').innerText()}`);throw error;}finally{await browser.close();}
const final=(await get(uk,base)).inspection;assert.equal(final.status,'INSPECTION_COMPLETED');assert.equal(final.checklist.length,8);assert.ok(final.evidence.length);assert.ok(final.completedAt);
const payload={assetCode,observedSn:final.observedSn,snVerification:final.snVerification,checklist:final.checklist,findings:final.findings};
for(let i=0;i<3;i++){assert.equal((await uk(`${base}/start`,{assetCode})).status,200);assert.equal((await uk(`${base}/complete`,payload)).status,200);assert.deepEqual((await get(uk,base)).inspection,final);}
assert.equal((await uk(`${base}/complete`,{...payload,assetCode:'MC-WRONG-000000'})).status,409);
assert.equal((await uk(`${base}/complete`,{...payload,findings:{...final.findings,inspectorNotes:'Overwrite denied'}})).status,409);
for(const evidence of final.evidence){
  const response=await uk(evidence.contentUrl);assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/private.*no-store/);
  assert.equal((await fetch(`${api}${evidence.contentUrl}`)).status,401);
  for(const persona of ['CN_SD_WAREHOUSE','CERTIFIED','INTERNATIONAL']){const request=await login(persona);assert.equal((await request(evidence.contentUrl)).status,403);assert.equal((await request(`${base}/complete`,payload)).status,403);}
}
const after=await get(admin,`/assets/${assetId}`);const international=await get(uk,`/international/assets/${assetId}`);
for(const key of ['certifiedWarranty','publicWarranty'])assert.deepEqual(after[key],before[key],key);
for(const key of ['originalSn','currentSn','warrantyStartAt','warrantyEndAt','warrantyOverrideStatus','assetStatus'])assert.equal(after.asset[key],before.asset[key],key);
assert.equal(international.asset.assetStatus,'QUARANTINED');assert.equal(international.asset.warehouseCode,'UK');assert.equal(international.asset.custody,'WAREHOUSE');
for(const key of ['certificationStatus','grade'])assert.equal(international.asset[key],originalInternational.asset[key],key);
const order=(await get(uk,`/international/orders/${rma.orderId}`)).order;for(const key of ['status','allocationStatus','deliveredAt','carrier','trackingNumber','shippedAt'])assert.equal(order[key],originalOrder[key],key);
assert.equal((await get(uk,`/international/rmas/${rma.id}`)).rma.businessStatus,'INSPECTION_COMPLETED');
assert.ok(!(await get(uk,'/international/warehouses/assets?warehouseId=wh-uk')).assets.some((a)=>a.assetId===assetId));
for(const event of ['return_inspection_started','return_inspection_completed'])assert.equal(international.events.filter((e)=>e.eventType===event).length,1);
const audits=(await get(admin,'/admin/audit-logs')).logs;for(const event of ['return_inspection_started','return_inspection_completed'])assert.equal(audits.filter((a)=>a.entityId===final.id&&a.action===`international.rma.${event}`).length,1);
const report={environment:'GitHub Actions / Staging only',rmaReference:reference,assetCode,inspectionId:final.id,status:final.status,startedAt:final.startedAt,completedAt:final.completedAt,checklist:final.checklist,findings:final.findings,evidenceCount:final.evidence.length,evidencePreview,browserStarted,browserCompleted,mismatchBlocked,idempotentRetries:3,events:'return_inspection_started x1 / return_inspection_completed x1',auditTransitions:2,quarantinePreserved:true,originalOrderAllocationCertificationWarrantyUnchanged:true,scope403:['CN_SD_WAREHOUSE','CERTIFIED','INTERNATIONAL without inspection grant'],unauthenticatedEvidence401:true};
await writeFile(`${directory}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
