import assert from 'node:assert/strict';
import { mkdir,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';

// Staging only. The sole write is an explicit decision, never execution.
const api='https://maxcine-api-staging.maxcine-lab.workers.dev';const web='https://maxcine-web-staging.pages.dev';
const assetId='43000000-0000-4000-8000-000000000012';const assetCode='MC-26-P12A-000012';const reference='MC-RMA-26-000001';
const directory='test-results/rma-resolution-staging';await mkdir(directory,{recursive:true});
async function login(persona){
  const response=await fetch(`${api}/dev/quick-login`,{method:'POST',headers:{Origin:web,'Content-Type':'application/json'},body:JSON.stringify({persona}),signal:AbortSignal.timeout(30000)});assert.equal(response.status,200,persona);
  const cookie=response.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);
  return (path,body)=>fetch(`${api}${path}`,{method:body?'POST':'GET',headers:{Cookie:cookie,Origin:web,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});
}
const admin=await login('ADMIN');const uk=await login('UK_FULFILMENT');
const get=async(request,path)=>{const response=await request(path);assert.equal(response.status,200,path);return response.json();};
const rma=(await get(admin,'/international/rmas')).rmas.find((r)=>r.rmaReference===reference);assert.ok(rma,'Existing completed inspection fixture required');
const base=`/international/rmas/${rma.id}`;const beforeInspection=(await get(admin,`${base}/inspection`)).inspection;assert.equal(beforeInspection.status,'INSPECTION_COMPLETED');
const beforeAsset=await get(admin,`/assets/${assetId}`);const beforeInternational=await get(uk,`/international/assets/${assetId}`);const beforeOrder=(await get(uk,`/international/orders/${rma.orderId}`)).order;
const input={inspectionId:beforeInspection.id,resolutionType:'REPAIR',decisionReason:'STAGING B-5C2: Authorized manual review approves REPAIR decision only; no repair, replacement, refund or warranty action executed.',decisionNotes:'Customer issue reproduced / FUNCTIONAL_DEFECT. Keep UK Return Quarantine. Await a separate execution stage.'};
const digest=async(path)=>{const response=await admin(path);assert.equal(response.status,200);return createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');};
const evidenceBefore=await Promise.all(beforeInspection.evidence.map((e)=>digest(e.contentUrl)));
const scopedRequests=[];
for(const persona of ['UK_FULFILMENT','CN_SD_WAREHOUSE','CERTIFIED','INTERNATIONAL']){const request=await login(persona);assert.equal((await request(`${base}/resolution`,input)).status,403,persona);scopedRequests.push({persona,request});}
const initial=await get(admin,`${base}/resolution`);
const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1150}});page.setDefaultTimeout(30000);page.setDefaultNavigationTimeout(45000);
let browserDecided=false;let evidencePreview=false;let noDefaultDecision=false;let missingReasonBlocked=false;
let quarantinePage;
try{
  await page.goto(web,{waitUntil:'networkidle'});await page.getByRole('button',{name:/^管理员/}).click();await page.locator('.system-main').waitFor();await page.waitForLoadState('networkidle');
  await page.goto(`${web}/#/system/international/rmas/${rma.id}`);await page.getByRole('heading',{name:'Resolution Review',exact:true}).waitFor();
  assert.equal(await page.getByLabel('Inspector Notes',{exact:true}).count(),0,'Inspection is read-only');assert.equal(await page.getByRole('button',{name:'上传照片',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Submit Inspection',exact:true}).count(),0);
  const image=page.locator('.certified-evidence-card img').first();await image.waitFor();await image.evaluate((img)=>img.decode());evidencePreview=await image.evaluate((img)=>img.naturalWidth>0);assert.ok(evidencePreview);
  await page.screenshot({path:`${directory}/inspection-review.png`,fullPage:true});
  if(!initial.decision){
    assert.equal(rma.businessStatus,'INSPECTION_COMPLETED');
    const select=page.getByLabel('Select Resolution',{exact:true});assert.equal(await select.inputValue(),'');noDefaultDecision=true;
    assert.equal(await page.getByRole('button',{name:'Confirm Resolution',exact:true}).isDisabled(),true);await select.selectOption('REPAIR');
    assert.equal(await page.getByRole('button',{name:'Confirm Resolution',exact:true}).isDisabled(),true);missingReasonBlocked=true;
    await page.getByLabel('Decision Reason',{exact:true}).fill(input.decisionReason);await page.getByLabel('Decision Notes',{exact:true}).fill(input.decisionNotes);
    await page.screenshot({path:`${directory}/decision-form.png`,fullPage:true});await page.getByRole('button',{name:'Confirm Resolution',exact:true}).click();
    await page.getByRole('heading',{name:'Resolution Summary · 决策已确认',exact:true}).waitFor();await page.getByRole('heading',{name:'RESOLUTION_DECIDED',exact:true}).waitFor();browserDecided=true;
  }
  await page.getByRole('heading',{name:'Resolution Summary · 决策已确认',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Confirm Resolution',exact:true}).count(),0);
  await page.getByText(input.decisionReason,{exact:true}).waitFor();await page.screenshot({path:`${directory}/resolution-decided.png`,fullPage:true});
  await page.reload({waitUntil:'networkidle'});await page.getByRole('heading',{name:'Resolution Summary · 决策已确认',exact:true}).waitFor();await page.getByRole('heading',{name:'RESOLUTION_DECIDED',exact:true}).waitFor();
  // UK workspace access is distinct from Admin decision authority. Use the
  // warehouse persona for the physical inventory view; never relax its guard.
  quarantinePage=await browser.newPage({viewport:{width:1440,height:1150}});quarantinePage.setDefaultTimeout(30000);
  await quarantinePage.goto(web,{waitUntil:'networkidle'});await quarantinePage.getByRole('button',{name:/^英国履约/}).click();await quarantinePage.locator('.system-main').waitFor();await quarantinePage.waitForLoadState('networkidle');
  await quarantinePage.goto(`${web}/#/system/uk-fulfilment/return-quarantine`);await quarantinePage.getByRole('row').filter({hasText:assetCode}).getByText('QUARANTINED',{exact:true}).waitFor();await quarantinePage.screenshot({path:`${directory}/quarantine-unchanged.png`,fullPage:true});
}catch(error){const failedPage=quarantinePage??page;await failedPage.screenshot({path:`${directory}/failure.png`,fullPage:true});await writeFile(`${directory}/failure-page.txt`,`${failedPage.url()}\n${await failedPage.locator('body').innerText()}`);throw error;}finally{await browser.close();}
const final=(await get(admin,`${base}/resolution`)).decision;assert.equal(final.resolutionType,'REPAIR');assert.equal(final.decisionReason,input.decisionReason);assert.equal(final.decisionNotes,input.decisionNotes);assert.equal(final.status,'RESOLUTION_DECIDED');assert.equal(final.executionStatus,'NOT_STARTED');assert.ok(final.decidedBy);assert.ok(final.decidedAt);
for(let n=0;n<3;n++){assert.equal((await admin(`${base}/resolution`,input)).status,200);assert.deepEqual((await get(admin,`${base}/resolution`)).decision,final);}
assert.equal((await admin(`${base}/resolution`,{...input,resolutionType:'REFUND'})).status,409);assert.equal((await admin(`${base}/resolution`,{...input,decisionReason:'Attempt to overwrite'})).status,409);
for(const {persona,request} of scopedRequests)assert.equal((await request(`${base}/resolution`,input)).status,403,persona);
assert.deepEqual((await get(admin,`${base}/inspection`)).inspection,beforeInspection);assert.deepEqual(await Promise.all(beforeInspection.evidence.map((e)=>digest(e.contentUrl))),evidenceBefore);
const afterAsset=await get(admin,`/assets/${assetId}`);const international=await get(uk,`/international/assets/${assetId}`);const order=(await get(uk,`/international/orders/${rma.orderId}`)).order;
for(const key of ['certifiedWarranty','publicWarranty'])assert.deepEqual(afterAsset[key],beforeAsset[key],key);for(const key of ['originalSn','currentSn','warrantyStartAt','warrantyEndAt','warrantyOverrideStatus','assetStatus'])assert.equal(afterAsset.asset[key],beforeAsset.asset[key],key);
for(const key of ['certificationStatus','grade','custody','warehouseCode','inventoryStatus','assetStatus','locationStatus','locationName'])assert.equal(international.asset[key],beforeInternational.asset[key],key);
assert.equal(international.asset.custody,'WAREHOUSE');assert.equal(international.asset.warehouseCode,'UK');assert.equal(international.asset.inventoryStatus,'QUARANTINED');
for(const key of ['status','allocationStatus','deliveredAt','carrier','trackingNumber','shippedAt'])assert.equal(order[key],beforeOrder[key],key);
assert.ok(!(await get(uk,'/international/warehouses/assets?warehouseId=wh-uk')).assets.some((a)=>a.assetId===assetId));assert.equal((await get(admin,base)).rma.businessStatus,'RESOLUTION_DECIDED');
assert.equal(international.events.filter((e)=>e.eventType==='rma_resolution_decided').length,1);const audits=(await get(admin,'/admin/audit-logs')).logs;assert.equal(audits.filter((a)=>a.entityId===rma.id&&a.action==='international.rma.resolution_decided').length,1);
const report={environment:'GitHub Actions / Staging only',rmaReference:reference,assetCode,decision:final,browserDecided,browserDecisionPreviouslyPersisted:Boolean(initial.decision),browserReadOnlyReloadVerified:true,evidencePreview,noDefaultDecision,missingReasonBlocked,inspectionUnchanged:true,evidenceHashesUnchanged:true,quarantineUnchanged:true,originalOrderAllocationCertificationWarrantyUnchanged:true,idempotentRetries:3,conflictingDecision409:true,lifecycleCount:1,auditCount:1,scope403:scopedRequests.map((entry)=>entry.persona),executionStarted:false};await writeFile(`${directory}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
