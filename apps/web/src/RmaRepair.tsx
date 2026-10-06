import { useEffect,useState } from 'react';
import { api,ApiClientError } from './api';

type Part={partName:string;partNumber:string;quantity:number};
type Execution={id:string;status:string;resolutionReference:string;resolutionDecidedAt:string;inspectionId:string;technicianName:string;startedBy:string;startedAt:string;
  completedByName:string|null;completedAt:string|null;repairSummary:string;workPerformed:string;repairNotes:string;partsUsed:Part[];postRepairCheck:string|null;postCheckStatus:string|null};
type Result={execution:Execution|null;executionStatus:string;resolutionType:string|null;canStart:boolean;canComplete:boolean;eligibilityReason:string};
const time=(value:string|null)=>value?new Date(value).toLocaleString('zh-CN'):'—';
const message=(error:unknown)=>error instanceof ApiClientError?error.message:'维修操作未完成，请刷新记录后重试。';

export function RmaRepair({rmaId,updated}:{rmaId:string;updated:(status:string)=>void}){
  const [data,setData]=useState<Result|null>(null);
  const [loading,setLoading]=useState(true);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState('');
  const [summary,setSummary]=useState('');
  const [work,setWork]=useState('');
  const [notes,setNotes]=useState('');
  const [parts,setParts]=useState<Part[]>([]);
  const [check,setCheck]=useState('');
  useEffect(()=>{
    let active=true;
    void api<Result>(`/international/rmas/${rmaId}/repair`).then((result)=>{if(active)setData(result);}).catch((error)=>{if(active)setError(message(error));}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[rmaId]);
  const e=data?.execution;
  const completed=e?.status==='REPAIR_COMPLETED';
  const valid=summary.trim()&&work.trim()&&check&&parts.every((p)=>p.partName.trim()&&Number.isInteger(p.quantity)&&p.quantity>=1&&p.quantity<=999);
  const submit=async(complete:boolean)=>{
    if(saving||!data||(complete?(!data.canComplete||!valid):!data.canStart))return;
    setSaving(true);setError('');
    try{
      const result=await api<Result>(`/international/rmas/${rmaId}/repair/${complete?'complete':'start'}`,{method:'POST',body:JSON.stringify(complete
        ?{repairSummary:summary,workPerformed:work,repairNotes:notes,partsUsed:parts,postRepairCheck:check}:{})});
      setData(result);updated(result.executionStatus);
    }catch(error){
      setError(message(error));
      // A committed request whose response was lost is recovered by a read,
      // never by restarting or overwriting a finished execution.
      try{const latest=await api<Result>(`/international/rmas/${rmaId}/repair`);setData(latest);if(latest.execution)updated(latest.executionStatus);}catch{/* Preserve original error. */}
    }finally{setSaving(false);}
  };
  const changePart=(index:number,part:Partial<Part>)=>setParts((current)=>current.map((p,i)=>i===index?{...p,...part}:p));
  if(data&&data.resolutionType!=='REPAIR')return null;
  return <section className="panel transfer-detail" data-testid="rma-repair"><h2>{completed?'Repair Execution · 维修记录已完成':'Repair Execution'}</h2>
    <p>仅执行已明确批准的 REPAIR。维修后基础检查不是 Certified QC；即使 PASS，设备仍在 UK Return Quarantine，不可售、不可 Listing / Allocation，保修和原认证不变。</p>
    {error&&<div className="notice notice--error" role="alert">{error}</div>}
    {loading?<div role="status">正在加载维修执行…</div>:!data?<div className="empty-state">无法加载维修记录，请刷新页面。</div>:<>
      <dl><dt>Resolution</dt><dd>{data.resolutionType}</dd><dt>Execution Status</dt><dd>{data.executionStatus}</dd>
        {e&&<><dt>Repair Reference</dt><dd>{e.id}</dd><dt>Decision Reference</dt><dd>{e.resolutionReference} · {time(e.resolutionDecidedAt)}</dd><dt>Inspection Reference</dt><dd>{e.inspectionId}</dd>
          <dt>Technician</dt><dd>{e.technicianName}</dd><dt>Repair Started At</dt><dd>{time(e.startedAt)}</dd></>}
      </dl>
      {!e?(data.canStart?<><p>开始后将当前操作者记录为本次维修技师；不移动设备，不改变原处理决定。</p><button className="button" disabled={saving} onClick={()=>void submit(false)}>{saving?'正在开始…':'Start Repair'}</button></>:<div className="notice">{data.eligibilityReason} 需要独立 Repair Execution 权限，仓库 / 检测 / 决策权限不自动包含维修权限。</div>)
        :completed?<><dl><dt>Repair Completed At</dt><dd>{time(e.completedAt)}</dd><dt>Completed By</dt><dd>{e.completedByName}</dd>
          <dt>Repair Summary</dt><dd>{e.repairSummary}</dd><dt>Work Performed</dt><dd>{e.workPerformed}</dd><dt>Repair Notes</dt><dd>{e.repairNotes||'—'}</dd>
          <dt>Post-Repair Functional Check</dt><dd>{e.postRepairCheck} · {e.postCheckStatus}</dd></dl><h3>Parts Used</h3>
          {e.partsUsed.length?<ul>{e.partsUsed.map((p,index)=><li key={index}>{p.partName} · {p.partNumber||'未记录 Part Number'} · Quantity: {p.quantity}</li>)}</ul>:<p>未使用 / 未记录配件。</p>}
          <div className="notice notice--success" role="status">REPAIR_COMPLETED{e.postRepairCheck==='FAIL'?' / POST_CHECK_FAILED':e.postRepairCheck==='INCONCLUSIVE'?' / POST_CHECK_INCONCLUSIVE':''} · 记录已锁定。Awaiting Reinspection / Re-Certification。设备继续隔离，绝不表示 Certified 已恢复。</div></>
        :data.canComplete?<form className="receive-confirmation" onSubmit={(event)=>{event.preventDefault();void submit(true);}}>
          <label>Repair Summary<textarea aria-label="Repair Summary" required maxLength={1000} disabled={saving} value={summary} onChange={(event)=>setSummary(event.target.value)} /></label>
          <label>Work Performed<textarea aria-label="Work Performed" required maxLength={4000} disabled={saving} value={work} onChange={(event)=>setWork(event.target.value)} /></label>
          <label>Repair Notes (Optional)<textarea aria-label="Repair Notes" maxLength={4000} disabled={saving} value={notes} onChange={(event)=>setNotes(event.target.value)} /></label>
          <h3>Parts Used</h3><p>仅记录维修使用信息；不扣减库存、不涉及成本或采购。</p>
          {parts.map((p,index)=><div className="receive-confirmation" key={index}>
            <label>Part Name<input aria-label={`Part Name ${index+1}`} required disabled={saving} maxLength={160} value={p.partName} onChange={(event)=>changePart(index,{partName:event.target.value})} /></label>
            <label>Part Number / SKU (Optional)<input aria-label={`Part Number ${index+1}`} disabled={saving} maxLength={160} value={p.partNumber} onChange={(event)=>changePart(index,{partNumber:event.target.value})} /></label>
            <label>Quantity<input aria-label={`Part Quantity ${index+1}`} type="number" required min={1} max={999} step={1} disabled={saving} value={p.quantity} onChange={(event)=>changePart(index,{quantity:Number(event.target.value)})} /></label>
            <button type="button" className="button button--secondary" disabled={saving} onClick={()=>setParts((current)=>current.filter((_,i)=>i!==index))}>移除此配件</button>
          </div>)}
          <button type="button" className="button button--secondary" disabled={saving||parts.length>=30} onClick={()=>setParts((current)=>[...current,{partName:'',partNumber:'',quantity:1}])}>Add Part</button>
          <label>Post-Repair Functional Check<select aria-label="Post-Repair Functional Check" required disabled={saving} value={check} onChange={(event)=>setCheck(event.target.value)}><option value="">请选择（无默认通过）</option>{['PASS','FAIL','INCONCLUSIVE'].map((value)=><option key={value}>{value}</option>)}</select></label>
          <p>填写内容在 Complete Repair 时统一保存并锁定。FAIL / INCONCLUSIVE 可以完成事实记录，但不会自动启动再次维修、退款或其他决策。</p>
          <button className="button" type="submit" disabled={saving||!valid}>{saving?'正在完成…':'Complete Repair'}</button>
        </form>:<div className="notice">{data.eligibilityReason} 只有本次获授权维修技师或管理员可以完成；当前记录只读。</div>}
    </>}
  </section>;
}
