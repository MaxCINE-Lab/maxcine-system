import { useEffect, useState } from 'react';
import { api, apiResourceUrl, ApiClientError, uploadFormData } from './api';

const items = ['IDENTITY','EXTERIOR','DISPLAY','LENS_CAMERA','POWER','FUNCTIONAL','ACCESSORIES','RETURN_REASON'];
const labels: Record<string,string> = { IDENTITY:'Identity · Asset Code / SN',EXTERIOR:'Exterior · 机身外观',DISPLAY:'Display · 屏幕 / 划痕 / 坏点',LENS_CAMERA:'Lens / Camera · 镜头及成像',POWER:'Power · 开机及充电',FUNCTIONAL:'Functional · 基本功能',ACCESSORIES:'Accessories · 配件完整性',RETURN_REASON:'Return Reason · 客户问题复现' };
const categories: Record<string,string> = { OVERALL_CONDITION:'Overall Condition · 整体状态（必需）',DAMAGE_DEFECT:'Damage / Defect · 损坏或故障',ACCESSORIES:'Accessories · 配件',OTHER:'Other Evidence · 其他' };
type Check = { item:string;result:string;notes:string };
type Findings = { issueReproduced:string;conditionAssessment:string;inspectorNotes:string };
type Evidence = { id:string;category:string;filename:string;contentUrl:string;createdAt:string;createdByName:string;contentType:string };
type Inspection = { id:string;status:string;inspectorName:string;startedAt:string;completedAt:string|null;matchedAssetCode:string;expectedSn:string;observedSn:string;snVerification:string;checklist:Check[];findings:Findings;evidence:Evidence[];canEdit:boolean };
type Result = { inspection:Inspection|null;canStart:boolean };
const errorText = (error:unknown) => error instanceof ApiClientError ? error.message : '检测操作未完成，请稍后重试。';
const time = (value:string|null) => value ? new Date(value).toLocaleString('zh-CN') : '—';

export function ReturnInspection({ rmaId,assetCode,updated }: { rmaId:string;assetCode:string;updated:()=>void }) {
  const [data,setData]=useState<Result|null>(null);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [input,setInput]=useState('');
  const [checklist,setChecklist]=useState<Check[]>(items.map((item)=>({item,result:'',notes:''})));
  const [observedSn,setObservedSn]=useState('');
  const [snVerification,setSnVerification]=useState('');
  const [findings,setFindings]=useState<Findings>({issueReproduced:'',conditionAssessment:'',inspectorNotes:''});
  const [category,setCategory]=useState('OVERALL_CONDITION');
  const [file,setFile]=useState<File|null>(null);
  const [progress,setProgress]=useState(0);
  useEffect(()=>{
    let active=true;
    void api<Result>(`/international/rmas/${rmaId}/inspection`).then((result)=>{if(active){setData(result);setError('');}}).catch((error)=>{if(active)setError(errorText(error));}).finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;};
  },[rmaId]);
  const inspection=data?.inspection;
  const matched=input.trim().toUpperCase()===assetCode.toUpperCase();
  const readonly=inspection?.status==='INSPECTION_COMPLETED';
  const hasOverall=inspection?.evidence.some((e)=>e.category==='OVERALL_CONDITION');
  const valid=matched && checklist.every((c)=>c.result && (c.result!=='NOT_TESTED' || c.notes.trim())) && snVerification
    && findings.issueReproduced && findings.conditionAssessment && findings.inspectorNotes.trim() && hasOverall;
  const action=async(complete:boolean)=>{
    if(busy || !matched || (complete && !valid))return;
    setBusy(true);setError('');
    try{
      const result=await api<Result>(`/international/rmas/${rmaId}/inspection/${complete?'complete':'start'}`,{method:'POST',body:JSON.stringify(complete?{assetCode:input,observedSn,snVerification,checklist,findings}:{assetCode:input})});
      setData(result);updated();
    }catch(error){setError(errorText(error));}finally{setBusy(false);}
  };
  const upload=async()=>{
    if(!file || busy)return;
    setBusy(true);setError('');setProgress(0);
    const form=new FormData();form.set('category',category);form.set('file',file);
    try{setData(await uploadFormData<Result>(`/international/rmas/${rmaId}/inspection/evidence`,form,setProgress));setFile(null);}
    catch(error){setError(errorText(error));}finally{setBusy(false);}
  };
  const change=(index:number,key:'result'|'notes',value:string)=>setChecklist((current)=>current.map((c,i)=>i===index?{...c,[key]:value}:c));
  return <section className="panel transfer-detail"><h2>{readonly?'Return Inspection · 检测已完成':'RMA Return Inspection'}</h2>
    <p>独立退货检测，不覆盖 Certified QC。检测事实不代表责任归属；完成后仍留在 UK Return Quarantine，等待处理决策。</p>
    {error && <div className="notice notice--error" role="alert">{error}</div>}
    {loading ? <div role="status">正在加载检测记录…</div> : !data ? <div className="empty-state">无法加载检测记录，请刷新页面。</div> : <>
      {inspection && <dl><dt>Inspection Status</dt><dd>{inspection.status}</dd><dt>Inspector</dt><dd>{inspection.inspectorName}</dd><dt>Started At</dt><dd>{time(inspection.startedAt)}</dd><dt>Completed At</dt><dd>{time(inspection.completedAt)}</dd></dl>}
      {!readonly && (data.canStart || inspection?.canEdit) && <div className="receive-confirmation">
        <label>输入 Asset Code<input aria-label="Inspection Asset Code" value={input} maxLength={100} disabled={busy} onChange={(e)=>setInput(e.target.value)} /></label>
        {input.trim() && <div className={`asset-match ${matched?'asset-match--success':'asset-match--error'}`} role="status"><strong>{matched?'设备匹配':'Asset 不匹配'}</strong><p>Expected: {assetCode}</p><p>Actual Input: {input}</p></div>}
        {data.canStart && <button className="button" disabled={busy || !matched} onClick={()=>void action(false)}>{busy?'正在开始…':'Start Inspection'}</button>}
      </div>}
      {inspection && (readonly || inspection.canEdit) && <>
        <h3>Identity / SN Verification</h3>
        {readonly ? <dl><dt>Matched Asset Code</dt><dd>{inspection.matchedAssetCode}</dd><dt>Expected SN</dt><dd>{inspection.expectedSn || '未记录'}</dd><dt>Observed SN</dt><dd>{inspection.observedSn || '未检测'}</dd><dt>SN Verification</dt><dd>{inspection.snVerification}</dd></dl> : <>
          <p>Expected SN: {inspection.expectedSn || '未记录'}。不同 SN 只记录异常，不修改 Asset 的原始 SN。</p>
          <label>Observed SN<input aria-label="Observed SN" maxLength={160} value={observedSn} disabled={busy} onChange={(e)=>setObservedSn(e.target.value)} /></label>
          <label>SN Verification<select aria-label="SN Verification" value={snVerification} disabled={busy} onChange={(e)=>setSnVerification(e.target.value)}><option value="">请选择</option>{['MATCH','MISMATCH','NOT_TESTED'].map((value)=><option key={value}>{value}</option>)}</select></label>
          <p>SN MISMATCH 或 NOT_TESTED 时，请在 Identity 备注记录异常 / 未检测原因。</p>
        </>}
        <h3>Return Inspection Checklist</h3><div className="table-wrap"><table><thead><tr><th>Item</th><th>Result</th><th>Notes</th></tr></thead><tbody>{(readonly?inspection.checklist:checklist).map((c,index)=><tr key={c.item}><td>{labels[c.item]}</td><td>{readonly?c.result:<select aria-label={`${c.item} Result`} disabled={busy} required value={c.result} onChange={(e)=>change(index,'result',e.target.value)}><option value="">请选择（无默认结果）</option>{['PASS','FAIL','NOT_APPLICABLE','NOT_TESTED'].map((result)=><option key={result}>{result}</option>)}</select>}</td><td>{readonly?c.notes || '—':<textarea aria-label={`${c.item} Notes`} disabled={busy} maxLength={1000} value={c.notes} onChange={(e)=>change(index,'notes',e.target.value)} />}</td></tr>)}</tbody></table></div>
        {!readonly && <p>不适用项目选择 NOT_APPLICABLE。NOT_TESTED 必须说明原因，绝不视为 PASS。</p>}
        <h3>Photo Evidence</h3>
        {!readonly && <div className="receive-confirmation"><label>Evidence Category<select aria-label="Evidence Category" disabled={busy} value={category} onChange={(e)=>setCategory(e.target.value)}>{Object.entries(categories).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label><label>Inspection Photo<input aria-label="Inspection Photo" type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={(e)=>setFile(e.target.files?.[0] || null)} /></label><button className="button" disabled={busy || !file} onClick={()=>void upload()}>上传照片</button>{busy && progress>0 && <div role="status">上传进度 {progress}%</div>}<p>至少一张 Overall Condition 照片，单张最大 25MB。仅授权人员可以预览。</p></div>}
        <div className="certified-evidence-grid">{inspection.evidence.map((e)=><article className="certified-evidence-card" key={e.id}><a href={apiResourceUrl(e.contentUrl)} target="_blank" rel="noreferrer"><img src={apiResourceUrl(e.contentUrl)} alt={e.filename} /></a><strong>{categories[e.category]}</strong><span>{e.filename} · {e.contentType} · {e.createdByName} · {time(e.createdAt)}</span></article>)}</div>
        {!inspection.evidence.length && <div className="empty-state">尚未上传照片证据。</div>}
        <h3>Inspection Findings</h3>
        {readonly ? <dl><dt>Issue Reproduced</dt><dd>{inspection.findings.issueReproduced}</dd><dt>Condition Assessment</dt><dd>{inspection.findings.conditionAssessment}</dd><dt>Inspector Notes</dt><dd>{inspection.findings.inspectorNotes}</dd></dl> : <>
          <label>Issue Reproduced<select aria-label="Issue Reproduced" disabled={busy} value={findings.issueReproduced} onChange={(e)=>setFindings({...findings,issueReproduced:e.target.value})}><option value="">请选择</option>{['YES','NO','INCONCLUSIVE'].map((value)=><option key={value}>{value}</option>)}</select></label>
          <label>Condition Assessment<select aria-label="Condition Assessment" disabled={busy} value={findings.conditionAssessment} onChange={(e)=>setFindings({...findings,conditionAssessment:e.target.value})}><option value="">请选择</option>{['GOOD','COSMETIC_DAMAGE','FUNCTIONAL_DEFECT','PHYSICAL_DAMAGE','INCOMPLETE','OTHER'].map((value)=><option key={value}>{value}</option>)}</select></label>
          <label>Inspector Notes<textarea aria-label="Inspector Notes" disabled={busy} maxLength={4000} value={findings.inspectorNotes} onChange={(e)=>setFindings({...findings,inspectorNotes:e.target.value})} /></label>
          <button className="button" disabled={busy || !valid} onClick={()=>void action(true)}>{busy?'正在提交…':'Submit Inspection'}</button>
        </>}
        {readonly && <div className="notice notice--success" role="status">INSPECTION_COMPLETED · 报告已锁定。设备仍隔离、不可售，等待售后处理决策。</div>}
      </>}
      {!inspection && !data.canStart && <div className="empty-state">仅已收货并隔离的 RMA 可以开始检测。</div>}
      {inspection && !readonly && !inspection.canEdit && <p>由指定检测员继续完成；当前账号不可编辑。</p>}
    </>}
  </section>;
}
