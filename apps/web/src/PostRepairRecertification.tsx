import { useCallback,useEffect,useState } from 'react';
import { api,apiResourceUrl,ApiClientError,uploadFormData } from './api';

const items=['IDENTITY','EXTERIOR','DISPLAY','LENS_CAMERA','POWER','FUNCTIONAL','REPAIRED_FUNCTION','ACCESSORIES','FINAL_QC'];
const labels:Record<string,string>={IDENTITY:'Identity / SN',EXTERIOR:'Exterior / Physical Condition',DISPLAY:'Display (where applicable)',LENS_CAMERA:'Lens / Camera (where applicable)',POWER:'Power',FUNCTIONAL:'Core Functional Operation',REPAIRED_FUNCTION:'Repaired Function / Defect Area',ACCESSORIES:'Accessories',FINAL_QC:'Final QC Readiness'};
type Check={item:string;result:string;notes:string};
type Findings={issueRemains:string;functionalCondition:string;inspectorNotes:string};
type Photo={id:string;category:string;filename:string;contentType:string;contentUrl:string;createdAt:string;createdByName:string};
type Inspection={id:string;taskId:string;status:string;inspectorName:string;startedAt:string;completedAt:string|null;expectedSn:string;observedSn:string;snVerification:string;grade:string|null;checklist:Check[];findings:Partial<Findings>;canEdit:boolean;evidence:Photo[]};
type Decision={decision:string;reason:string;notes:string;decidedByName:string;decidedAt:string;certificationId:string|null};
type Result={executionStatus:string;inspection:Inspection|null;decision:Decision|null;canStart:boolean;canDecide:boolean;eligibilityReason:string;certificationHistory:{id:string;version:number;purpose:string;grade:string;status:string;issuedAt:string}[]};
const blankChecks=()=>items.map(item=>({item,result:'NOT_TESTED',notes:''}));
const time=(value:string|null)=>value?new Date(value.includes('T')?value:value.replace(' ','T')+'Z').toLocaleString('zh-CN'):'—';
const message=(error:unknown)=>error instanceof ApiClientError?error.message:'操作未完成，请刷新后重试。';

export function PostRepairRecertification({rmaId,assetCode}:{rmaId:string;assetCode:string}){
  const [data,setData]=useState<Result|null>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[success,setSuccess]=useState('');
  const [code,setCode]=useState(''),[observedSn,setObservedSn]=useState(''),[sn,setSn]=useState('NOT_TESTED'),[grade,setGrade]=useState('');
  const [checks,setChecks]=useState<Check[]>(blankChecks),[findings,setFindings]=useState<Findings>({issueRemains:'INCONCLUSIVE',functionalCondition:'INCONCLUSIVE',inspectorNotes:''});
  const [category,setCategory]=useState('OVERALL_CONDITION'),[photo,setPhoto]=useState<File|null>(null),[progress,setProgress]=useState(0);
  const [decision,setDecision]=useState(''),[reason,setReason]=useState(''),[notes,setNotes]=useState('');
  const base=`/international/rmas/${rmaId}/post-repair-inspection`;
  const hydrate=useCallback((result:Result)=>{setData(result);const i=result.inspection;if(!i)return;
    setChecks(i.checklist.length?i.checklist:blankChecks());setObservedSn(i.observedSn);setSn(i.snVerification);setGrade(i.grade||'');
    setFindings({issueRemains:i.findings.issueRemains||'INCONCLUSIVE',functionalCondition:i.findings.functionalCondition||'INCONCLUSIVE',inspectorNotes:i.findings.inspectorNotes||''});},[]);
  useEffect(()=>{let active=true;void api<Result>(base).then(result=>{if(active)hydrate(result);}).catch(e=>{if(active)setError(message(e));}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[base,hydrate]);
  const i=data?.inspection,readonly=Boolean(i&&(i.status==='COMPLETED'||!i.canEdit)),matched=code.trim().toUpperCase()===assetCode.toUpperCase();
  const payload=()=>({assetCode:code,observedSn,snVerification:sn,grade:grade||null,checklist:checks,findings});
  const valid=matched&&grade&&findings.inspectorNotes.trim()&&checks.every(c=>c.result!=='NOT_TESTED'||c.notes.trim())&&i?.evidence.some(e=>e.category==='OVERALL_CONDITION');
  const action=async(kind:'start'|'save'|'complete'|'decision')=>{
    if(busy||!data||(kind!=='decision'&&!matched)||(kind==='complete'&&!valid)||(kind==='decision'&&(!decision||!reason.trim())))return;
    setBusy(true);setError('');setSuccess('');
    try{const result=await api<Result>(kind==='decision'?`/international/rmas/${rmaId}/recertification-decision`:kind==='save'?base:`${base}/${kind}`,{
      method:kind==='save'?'PATCH':'POST',body:JSON.stringify(kind==='start'?{assetCode:code}:kind==='decision'?{inspectionId:i!.id,decision,reason,notes}:payload())});
      hydrate(result);setSuccess(kind==='save'?'复检草稿已保存。':kind==='start'?'维修后复检已开始。':kind==='complete'?'复检已完成；等待显式再认证决定。':'再认证决定已保存；设备继续隔离。');}
    catch(e){setError(message(e));try{setData(await api<Result>(base));}catch{/* Keep original error; do not overwrite local facts. */}}
    finally{setBusy(false);}
  };
  const upload=async()=>{if(!photo||busy)return;setBusy(true);setError('');setProgress(0);const form=new FormData();form.set('category',category);form.set('file',photo);
    try{setData(await uploadFormData<Result>(`${base}/evidence`,form,setProgress));setPhoto(null);}catch(e){setError(message(e));}finally{setBusy(false);}};
  return <section className="panel transfer-detail" data-testid="post-repair"><h2>Post-Repair Reinspection / Re-Certification</h2>
    <p>Repair Completed ≠ Certified。独立 POST_REPAIR_RECERTIFICATION 报告，不覆盖原 Certified / Return Inspection。即使批准再认证，设备仍为 UK / WAREHOUSE / QUARANTINED，不可售、不可 Listing / Allocation。</p>
    {error&&<div className="notice notice--error" role="alert">{error}</div>}{success&&<div className="notice notice--success" role="status">{success}</div>}
    {loading?<div role="status">正在加载维修后复检…</div>:!data?<div className="empty-state">无法加载复检，请刷新。</div>:<>
      <dl><dt>Repair Execution</dt><dd>{data.executionStatus}</dd><dt>Post-Repair Reinspection Status</dt><dd>{i?.status||'NOT_STARTED'}</dd>
        {i&&<><dt>Inspector</dt><dd>{i.inspectorName}</dd><dt>Started At</dt><dd>{time(i.startedAt)}</dd><dt>Completed At</dt><dd>{time(i.completedAt)}</dd><dt>Inspection Task / Assignment</dt><dd>{i.taskId}</dd></>}
      </dl>
      {(!i&&data.canStart||i?.canEdit)&&<div className="receive-confirmation"><label>输入 Asset Code<input aria-label="Post-Repair Asset Code" value={code} maxLength={100} disabled={busy} onChange={e=>setCode(e.target.value)}/></label>
        {code.trim()&&<div role="status" className={`asset-match ${matched?'asset-match--success':'asset-match--error'}`}><strong>{matched?'设备匹配':'Asset 不匹配'}</strong><p>Expected: {assetCode}</p><p>Actual Input: {code}</p></div>}
        {!i&&<button className="button" disabled={busy||!matched} onClick={()=>void action('start')}>Start Post-Repair Reinspection</button>}
      </div>}
      {!i&&!data.canStart&&<div className="empty-state">{data.eligibilityReason} 需要独立复检执行权限。</div>}
      {i&&<><h3>Identity / Certified Grade</h3><p>Expected SN: {i.expectedSn||'未记录'}。观察 SN 仅记录事实，不修改 Asset SN。</p>
        {readonly?<dl><dt>Observed SN</dt><dd>{i.observedSn||'未检测'}</dd><dt>SN Verification</dt><dd>{i.snVerification}</dd><dt>Grade</dt><dd>{i.grade||'未记录'}</dd></dl>:<>
          <label>Observed SN<input aria-label="Post-Repair Observed SN" value={observedSn} maxLength={160} disabled={busy} onChange={e=>setObservedSn(e.target.value)}/></label>
          <label>SN Verification<select aria-label="Post-Repair SN Verification" value={sn} disabled={busy} onChange={e=>setSn(e.target.value)}>{['NOT_TESTED','MATCH','MISMATCH'].map(v=><option key={v}>{v}</option>)}</select></label>
          <label>Certified Grade<select aria-label="Post-Repair Grade" value={grade} disabled={busy} onChange={e=>setGrade(e.target.value)}><option value="">请选择</option>{['A+','A','B+','B','Parts / Repair'].map(v=><option key={v}>{v}</option>)}</select></label>
        </>}
        <h3>Post-Repair Checklist</h3><div className="table-wrap"><table><thead><tr><th>Item</th><th>Result</th><th>Notes</th></tr></thead><tbody>{(readonly?i.checklist:checks).map((c,index)=><tr key={c.item}><td>{labels[c.item]}</td><td>{readonly?c.result:<select aria-label={`Post-Repair ${c.item} Result`} disabled={busy} value={c.result} onChange={e=>setChecks(current=>current.map((v,n)=>n===index?{...v,result:e.target.value}:v))}>{['NOT_TESTED','PASS','FAIL','NOT_APPLICABLE'].map(v=><option key={v}>{v}</option>)}</select>}</td><td>{readonly?c.notes||'—':<textarea aria-label={`Post-Repair ${c.item} Notes`} disabled={busy} maxLength={1000} value={c.notes} onChange={e=>setChecks(current=>current.map((v,n)=>n===index?{...v,notes:e.target.value}:v))}/>}</td></tr>)}</tbody></table></div>
        <p>未检测绝不默认为通过。必要 Identity / Power / Functional / Repaired Function / Final QC 必须 PASS，其他项目可按实际选 N/A；事实不会自动生成认证。</p>
        <h3>Post-Repair Findings</h3>{readonly?<dl><dt>Issue Remains Reproducible</dt><dd>{i.findings.issueRemains||'未记录'}</dd><dt>Functional Condition</dt><dd>{i.findings.functionalCondition||'未记录'}</dd><dt>Inspector Notes</dt><dd>{i.findings.inspectorNotes||'—'}</dd></dl>:<>
          <label>Issue Remains Reproducible<select aria-label="Post-Repair Issue Remains" disabled={busy} value={findings.issueRemains} onChange={e=>setFindings({...findings,issueRemains:e.target.value})}>{['INCONCLUSIVE','YES','NO'].map(v=><option key={v}>{v}</option>)}</select></label>
          <label>Functional Condition<select aria-label="Post-Repair Functional Condition" disabled={busy} value={findings.functionalCondition} onChange={e=>setFindings({...findings,functionalCondition:e.target.value})}>{['INCONCLUSIVE','GOOD','DEFECTIVE'].map(v=><option key={v}>{v}</option>)}</select></label>
          <label>Inspector Notes<textarea aria-label="Post-Repair Inspector Notes" maxLength={4000} disabled={busy} value={findings.inspectorNotes} onChange={e=>setFindings({...findings,inspectorNotes:e.target.value})}/></label>
          <button className="button button--secondary" disabled={busy||!matched} onClick={()=>void action('save')}>Save Reinspection Draft</button>
        </>}
        <h3>Private Post-Repair Evidence</h3>{!readonly&&<div className="receive-confirmation"><label>Evidence Category<select aria-label="Post-Repair Evidence Category" value={category} disabled={busy} onChange={e=>setCategory(e.target.value)}>{['OVERALL_CONDITION','REPAIRED_AREA','ACCESSORIES','OTHER'].map(v=><option key={v}>{v}</option>)}</select></label>
          <label>Photo<input aria-label="Post-Repair Photo" type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={e=>setPhoto(e.target.files?.[0]||null)}/></label><button className="button" disabled={busy||!photo} onClick={()=>void upload()}>Upload Reinspection Photo</button>{busy&&progress>0&&<p role="status">{progress}%</p>}</div>}
        {!i.evidence.length&&<div className="empty-state">至少需要一张 Overall Condition 照片。JPG / PNG / WebP，最大 25MB；仅授权人员可以查看。</div>}
        <div className="certified-evidence-grid">{i.evidence.map(e=><article className="certified-evidence-card" key={e.id}><a href={apiResourceUrl(e.contentUrl)} target="_blank" rel="noreferrer"><img src={apiResourceUrl(e.contentUrl)} alt={e.filename}/></a><strong>{e.category}</strong><span>{e.filename} · {e.contentType} · {e.createdByName} · {time(e.createdAt)}</span></article>)}</div>
        {!readonly&&<button className="button" disabled={busy||!valid} onClick={()=>void action('complete')}>Complete Post-Repair Reinspection</button>}
        {i.status==='COMPLETED'&&<div className="notice notice--success">REINSPECTION_COMPLETED · 报告已锁定，不等于再认证已批准。</div>}
      </>}
      {i?.status==='COMPLETED'&&<><h3>Explicit Re-Certification Decision</h3>{data.decision?<dl><dt>Decision</dt><dd>{data.decision.decision}</dd><dt>Reason</dt><dd>{data.decision.reason}</dd><dt>Notes</dt><dd>{data.decision.notes||'—'}</dd><dt>Decided By</dt><dd>{data.decision.decidedByName}</dd><dt>Decided At</dt><dd>{time(data.decision.decidedAt)}</dd><dt>New Certification</dt><dd>{data.decision.certificationId||'Not issued'}</dd></dl>:data.canDecide?<div className="receive-confirmation">
        <label>Re-Certification Decision<select aria-label="Re-Certification Decision" value={decision} disabled={busy} onChange={e=>setDecision(e.target.value)}><option value="">明确选择（无自动批准）</option>{['APPROVED','REJECTED'].map(v=><option key={v}>{v}</option>)}</select></label>
        <label>Decision Reason<textarea aria-label="Re-Certification Reason" required maxLength={1000} value={reason} disabled={busy} onChange={e=>setReason(e.target.value)}/></label>
        <label>Decision Notes<textarea aria-label="Re-Certification Notes" maxLength={4000} value={notes} disabled={busy} onChange={e=>setNotes(e.target.value)}/></label>
        <button className="button" disabled={busy||!decision||!reason.trim()} onClick={()=>void action('decision')}>Confirm Re-Certification Decision</button></div>:<p>等待有独立再认证决定权限的人员审核。</p>}
        {data.decision&&<div className="notice notice--success" role="status">{data.decision.decision==='APPROVED'?'Certified again · Inventory release pending':'REJECTED · No new Certification issued'} · QUARANTINED · Not sellable。RMA 未关闭，保修不变。</div>}
      </>}
      <h3>Append-only Certification History</h3><div className="table-wrap"><table><thead><tr><th>Version</th><th>Reference</th><th>Purpose</th><th>Grade / Status</th><th>Issued At</th></tr></thead><tbody>{data.certificationHistory.map(c=><tr key={c.id}><td>v{c.version}</td><td>{c.id}</td><td>{c.purpose}</td><td>{c.grade} / {c.status}</td><td>{time(c.issuedAt)}</td></tr>)}</tbody></table></div>
    </>}
  </section>;
}
