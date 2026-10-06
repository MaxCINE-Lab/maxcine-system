import { useEffect,useState } from 'react';
import { api,ApiClientError } from './api';

type Decision={rmaId:string;assetId:string;inspectionId:string;resolutionType:string;decisionReason:string;decisionNotes:string;decidedByName:string;decidedAt:string;status:string;executionStatus:string};
type Result={decision:Decision|null;inspectionId:string|null;canDecide:boolean;eligibilityReason:string;warranty:{status:string;policyCode:string|null;start:string|null;end:string|null}};
const options={REPAIR:'REPAIR · 批准维修（未执行）',REPLACE:'REPLACE · 批准更换设备（未执行）',REFUND:'REFUND · 批准退款（未执行）',REJECT:'REJECT · 拒绝本次请求（不结案、不通知客户）'};

export function RmaResolution({rmaId,decided}:{rmaId:string;decided:()=>void}){
  const [data,setData]=useState<Result|null>(null);
  const [loading,setLoading]=useState(true);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState('');
  const [resolution,setResolution]=useState('');
  const [reason,setReason]=useState('');
  const [notes,setNotes]=useState('');
  useEffect(()=>{
    let active=true;
    void api<Result>(`/international/rmas/${rmaId}/resolution`).then((result)=>{if(active)setData(result);}).catch((error)=>{if(active)setError(error instanceof ApiClientError?error.message:'无法加载售后决策。');}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[rmaId]);
  const submit=async()=>{
    if(saving||!data?.canDecide||!data.inspectionId||!resolution||!reason.trim())return;
    setSaving(true);setError('');
    try{
      const result=await api<Result>(`/international/rmas/${rmaId}/resolution`,{method:'POST',body:JSON.stringify({inspectionId:data.inspectionId,resolutionType:resolution,decisionReason:reason,decisionNotes:notes})});
      setData(result);decided();
    }catch(error){
      setError(error instanceof ApiClientError?error.message:'未能确认决策，请重试。');
      // Recover a competing decision or lost response without submitting again.
      try{const latest=await api<Result>(`/international/rmas/${rmaId}/resolution`);setData(latest);if(latest.decision)decided();}catch{/* Keep the readable original error; no success is claimed. */}
    }finally{setSaving(false);}
  };
  return <section className="panel transfer-detail"><h2>{data?.decision?'Resolution Summary · 决策已确认':'Resolution Decision'}</h2>
    <p>Inspection 是检测事实；Resolution 是授权人员的明确决策；Execution 是独立执行记录。本区仅保存决策，维修执行见下方。设备继续隔离，不执行换货、退款或结案。</p>
    <p>检测结果不会自动映射到处理决定。商业保修与消费者法定权利应分别考虑；本页不自动认定责任、拒绝是否合法，也不发送客户通知。</p>
    {error&&<div className="notice notice--error" role="alert">{error}</div>}
    {loading?<div role="status">正在加载决策…</div>:!data?<div className="empty-state">无法读取决策，请刷新页面。</div>:<>
      <dl><dt>Current Internal Warranty</dt><dd>{data.warranty.status} · {data.warranty.policyCode||'无 Certified 商业保修'}</dd><dt>Inspection Reference</dt><dd>{data.inspectionId||'尚无正式完成报告'}</dd></dl>
      {data.decision?<><dl><dt>Resolution Type</dt><dd>{data.decision.resolutionType}</dd><dt>Decision Reason</dt><dd>{data.decision.decisionReason}</dd><dt>Decision Notes</dt><dd>{data.decision.decisionNotes||'—'}</dd><dt>Decided By</dt><dd>{data.decision.decidedByName}</dd><dt>Decided At</dt><dd>{new Date(data.decision.decidedAt).toLocaleString('zh-CN')}</dd><dt>Resolution Status</dt><dd>{data.decision.status}</dd><dt>Execution Status</dt><dd>{data.decision.executionStatus}{data.decision.executionStatus==='NOT_STARTED'?' · 未执行':''}</dd></dl><div className="notice notice--success" role="status">RESOLUTION_DECIDED · 决策已锁定。Quarantine 保持不变。</div></>
        :data.canDecide?<form className="receive-confirmation" onSubmit={(event)=>{event.preventDefault();void submit();}}>
          <label>Select Resolution<select aria-label="Select Resolution" required disabled={saving} value={resolution} onChange={(event)=>setResolution(event.target.value)}><option value="">请选择（无默认决策）</option>{Object.entries(options).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
          <label>Decision Reason<textarea aria-label="Decision Reason" required maxLength={1000} disabled={saving} value={reason} onChange={(event)=>setReason(event.target.value)} /></label>
          <label>Decision Notes (Optional)<textarea aria-label="Decision Notes" maxLength={4000} disabled={saving} value={notes} onChange={(event)=>setNotes(event.target.value)} /></label>
          <p>确认前请审阅上方已完成的检测报告及照片。理由仅保存于受权限保护的业务记录和审计。本轮确认后不可修改或撤销。</p>
          <button className="button" type="submit" disabled={saving||!resolution||!reason.trim()}>{saving?'正在确认…':'Confirm Resolution'}</button>
        </form>:<div className="notice">{data.eligibilityReason} 普通 UK 检测权限不包含决策权限。</div>}
    </>}
  </section>;
}
