import assert from 'node:assert/strict';
import { mkdir,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';

// Fixed Staging endpoints; synthetic repair records only, no physical repair.
const api='https://maxcine-api-staging.maxcine-lab.workers.dev',web='https://maxcine-web-staging.pages.dev';
const reference='MC-RMA-26-000001',assetCode='MC-26-P12A-000012',assetId='43000000-0000-4000-8000-000000000012';
const directory='test-results/rma-repair-staging';await mkdir(directory,{recursive:true});
const input={repairSummary:'STAGING B-5D1 SYNTHETIC repair execution record only; no physical device was repaired.',
  workPerformed:'STAGING SIMULATION ONLY: recorded a synthetic module replacement and simulated post-repair functional check. Not a real repair or Certified QC.',
  repairNotes:'Keep UK Return Quarantine. Warranty, certification and original sale unchanged. Await separate reinspection/re-certification.',
  partsUsed:[{partName:'Synthetic test module (no physical part used)',partNumber:'STG-NONPHYSICAL-TEST',quantity:1}],postRepairCheck:'PASS'};
async function login(persona){
  const response=await fetch(`${api}/dev/quick-login`,{method:'POST',headers:{Origin:web,'Content-Type':'application/json'},body:JSON.stringify({persona}),signal:AbortSignal.timeout(30000)});assert.equal(response.status,200,persona);
  const cookie=response.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);
  return (path,body)=>fetch(`${api}${path}`,{method:body?'POST':'GET',headers:{Cookie:cookie,Origin:web,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});
}
const get=async(request,path)=>{const response=await request(path);assert.equal(response.status,200,path);return response.json();};
const admin=await login('ADMIN'),uk=await login('UK_FULFILMENT');
const rma=(await get(admin,'/international/rmas')).rmas.find((r)=>r.rmaReference===reference);assert.ok(rma);
const base=`/international/rmas/${rma.id}`;const beforeDecision=(await get(admin,`${base}/resolution`)).decision;assert.equal(beforeDecision.resolutionType,'REPAIR');
const beforeInspection=(await get(admin,`${base}/inspection`)).inspection;assert.equal(beforeInspection.status,'INSPECTION_COMPLETED');
const beforeAsset=await get(admin,`/assets/${assetId}`),beforeInternational=await get(uk,`/international/assets/${assetId}`),beforeOrder=(await get(uk,`/international/orders/${rma.orderId}`)).order;
const digest=async(path)=>{const response=await admin(path);assert.equal(response.status,200);return createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');};
const evidenceHashes=await Promise.all(beforeInspection.evidence.map((e)=>digest(e.contentUrl)));
const requests=[];
for(const persona of ['UK_FULFILMENT','CN_SD_WAREHOUSE','CERTIFIED','INTERNATIONAL']){
  const request=await login(persona);assert.equal((await request(`${base}/repair/start`,{})).status,403,persona);assert.equal((await request(`${base}/repair/complete`,input)).status,403,persona);requests.push({persona,request});
}
const initial=await get(admin,`${base}/repair`);assert.ok(['NOT_STARTED','REPAIR_IN_PROGRESS','REPAIR_COMPLETED'].includes(initial.executionStatus));
const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1150}});page.setDefaultTimeout(30000);page.setDefaultNavigationTimeout(45000);
let ukPage,browserStarted=false,browserCompleted=false,missingFieldsBlocked=false,noDefaultPostCheck=false,startRetries=0;
try{
  await page.goto(web,{waitUntil:'networkidle'});await page.getByRole('button',{name:/^管理员/}).click();await page.locator('.system-main').waitFor();await page.waitForLoadState('networkidle');
  await page.goto(`${web}/#/system/international/rmas/${rma.id}`);await page.getByRole('heading',{name:'Resolution Review',exact:true}).waitFor();const panel=page.getByTestId('rma-repair');await panel.waitFor();
  const image=page.locator('.certified-evidence-card img').first();await image.waitFor();await image.evaluate((img)=>img.decode());assert.ok(await image.evaluate((img)=>img.naturalWidth>0));
  assert.equal(await page.getByRole('button',{name:'Submit Inspection',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Confirm Resolution',exact:true}).count(),0);
  if(initial.executionStatus==='NOT_STARTED'){
    await panel.getByRole('button',{name:'Start Repair',exact:true}).waitFor();await page.screenshot({path:`${directory}/before-start.png`,fullPage:true});
    await panel.getByRole('button',{name:'Start Repair',exact:true}).click();await page.getByRole('heading',{name:'REPAIR_IN_PROGRESS',exact:true}).waitFor();browserStarted=true;
  }
  if(initial.executionStatus!=='REPAIR_COMPLETED'){
    const started=(await get(admin,`${base}/repair`)).execution;assert.equal(started.status,'REPAIR_IN_PROGRESS');
    for(let n=0;n<3;n++){assert.equal((await admin(`${base}/repair/start`,{})).status,200);assert.deepEqual((await get(admin,`${base}/repair`)).execution,started);startRetries++;}
    assert.equal(await panel.getByRole('button',{name:'Complete Repair',exact:true}).isDisabled(),true);missingFieldsBlocked=true;
    assert.equal(await panel.getByLabel('Post-Repair Functional Check',{exact:true}).inputValue(),'');noDefaultPostCheck=true;
    await panel.getByLabel('Repair Summary',{exact:true}).fill(input.repairSummary);await panel.getByLabel('Work Performed',{exact:true}).fill(input.workPerformed);await panel.getByLabel('Repair Notes',{exact:true}).fill(input.repairNotes);
    await panel.getByRole('button',{name:'Add Part',exact:true}).click();await panel.getByLabel('Part Name 1',{exact:true}).fill(input.partsUsed[0].partName);await panel.getByLabel('Part Number 1',{exact:true}).fill(input.partsUsed[0].partNumber);await panel.getByLabel('Part Quantity 1',{exact:true}).fill('1');
    await panel.getByLabel('Post-Repair Functional Check',{exact:true}).selectOption('PASS');await page.screenshot({path:`${directory}/repair-form.png`,fullPage:true});
    await panel.getByRole('button',{name:'Complete Repair',exact:true}).click();await panel.getByRole('heading',{name:'Repair Execution · 维修记录已完成',exact:true}).waitFor();await page.getByRole('heading',{name:'REPAIR_COMPLETED',exact:true}).waitFor();browserCompleted=true;
  }
  await panel.getByRole('heading',{name:'Repair Execution · 维修记录已完成',exact:true}).waitFor();await panel.getByText(input.repairSummary,{exact:true}).waitFor();
  assert.equal(await panel.getByRole('button',{name:'Start Repair',exact:true}).count(),0);assert.equal(await panel.getByRole('button',{name:'Complete Repair',exact:true}).count(),0);assert.equal(await panel.getByLabel('Repair Summary',{exact:true}).count(),0);
  await page.screenshot({path:`${directory}/repair-completed.png`,fullPage:true});await page.reload({waitUntil:'networkidle'});await panel.getByRole('heading',{name:'Repair Execution · 维修记录已完成',exact:true}).waitFor();await page.getByRole('heading',{name:'REPAIR_COMPLETED',exact:true}).waitFor();
  ukPage=await browser.newPage({viewport:{width:1440,height:1150}});ukPage.setDefaultTimeout(30000);
  await ukPage.goto(web,{waitUntil:'networkidle'});await ukPage.getByRole('button',{name:/^英国履约/}).click();await ukPage.locator('.system-main').waitFor();await ukPage.waitForLoadState('networkidle');
  await ukPage.goto(`${web}/#/system/uk-fulfilment/return-quarantine`);await ukPage.getByRole('row').filter({hasText:assetCode}).getByText('QUARANTINED',{exact:true}).waitFor();await ukPage.screenshot({path:`${directory}/quarantine-unchanged.png`,fullPage:true});
}catch(error){const failed=ukPage??page;await failed.screenshot({path:`${directory}/failure.png`,fullPage:true});await writeFile(`${directory}/failure-page.txt`,`${failed.url()}\n${await failed.locator('body').innerText()}`);throw error;}finally{await browser.close();}
const final=(await get(admin,`${base}/repair`)).execution;assert.equal(final.status,'REPAIR_COMPLETED');assert.equal(final.repairSummary,input.repairSummary);assert.equal(final.workPerformed,input.workPerformed);assert.equal(final.repairNotes,input.repairNotes);assert.deepEqual(final.partsUsed,input.partsUsed);assert.equal(final.postRepairCheck,'PASS');assert.equal(final.awaitingReinspection,true);assert.ok(final.startedAt&&final.completedAt&&final.technicianId&&final.completedBy);
for(let n=0;n<3;n++){assert.equal((await admin(`${base}/repair/complete`,input)).status,200);assert.deepEqual((await get(admin,`${base}/repair`)).execution,final);}
assert.equal((await admin(`${base}/repair/start`,{})).status,409);assert.equal((await admin(`${base}/repair/complete`,{...input,repairSummary:'Attempt to overwrite'})).status,409);
for(const {persona,request} of requests){assert.equal((await request(`${base}/repair/start`,{})).status,403,persona);assert.equal((await request(`${base}/repair/complete`,input)).status,403,persona);}
const currentDecision=(await get(admin,`${base}/resolution`)).decision;
const {executionStatus:beforeExecutionStatus,...approved}=beforeDecision;const {executionStatus:afterExecutionStatus,...afterDecision}=currentDecision;
assert.ok(beforeExecutionStatus);assert.equal(afterExecutionStatus,'REPAIR_COMPLETED');assert.deepEqual(afterDecision,approved);
assert.deepEqual((await get(admin,`${base}/inspection`)).inspection,beforeInspection);assert.deepEqual(await Promise.all(beforeInspection.evidence.map((e)=>digest(e.contentUrl))),evidenceHashes);
const afterAsset=await get(admin,`/assets/${assetId}`),international=await get(uk,`/international/assets/${assetId}`),order=(await get(uk,`/international/orders/${rma.orderId}`)).order;
for(const key of ['certifiedWarranty','publicWarranty'])assert.deepEqual(afterAsset[key],beforeAsset[key]);
for(const key of ['originalSn','currentSn','warrantyStartAt','warrantyEndAt','warrantyOverrideStatus','assetStatus'])assert.equal(afterAsset.asset[key],beforeAsset.asset[key],key);
for(const key of ['certificationStatus','grade','custody','warehouseCode','inventoryStatus','assetStatus','locationStatus','locationName'])assert.equal(international.asset[key],beforeInternational.asset[key],key);
assert.equal(international.asset.custody,'WAREHOUSE');assert.equal(international.asset.warehouseCode,'UK');assert.equal(international.asset.inventoryStatus,'QUARANTINED');
for(const key of ['status','allocationStatus','deliveredAt','carrier','trackingNumber','shippedAt'])assert.equal(order[key],beforeOrder[key],key);
assert.ok(!(await get(uk,'/international/warehouses/assets?warehouseId=wh-uk')).assets.some((a)=>a.assetId===assetId));assert.equal((await get(admin,base)).rma.businessStatus,'REPAIR_COMPLETED');
const events={};const audits=(await get(admin,'/admin/audit-logs')).logs;
for(const event of ['repair_started','repair_completed']){events[event]=international.events.filter((e)=>e.eventType===event).length;assert.equal(events[event],1);assert.equal(audits.filter((a)=>a.entityId===rma.id&&a.action===`international.rma.${event}`).length,1);}
const report={environment:'GitHub Actions / Staging only',rmaReference:reference,assetCode,execution:final,browserStarted,browserCompleted,previouslyStarted:initial.executionStatus!=='NOT_STARTED',previouslyCompleted:initial.executionStatus==='REPAIR_COMPLETED',missingFieldsBlocked,noDefaultPostCheck,startRetries,completeRetries:3,conflict409:true,scope403:requests.map((r)=>r.persona),resolutionInspectionEvidenceUnchanged:true,originalOrderAllocationCertificationInternalPublicWarrantyUnchanged:true,quarantineUnchanged:true,sellable:false,lifecycleCounts:events,auditCounts:{repair_started:1,repair_completed:1},physicalRepairPerformed:false};
await writeFile(`${directory}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
