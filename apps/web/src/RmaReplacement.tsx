import { useEffect,useState } from 'react';
import { api,ApiClientError } from './api';

type Certification={version:number|null;status:string|null;grade:string|null}|null;
type Unit={assetId:string;assetCode:string;productName:string;version:string;warehouseCode:string|null;custody:string|null;locationStatus:string|null;inventoryStatus:string;certification:Certification};
type Execution={id:string;status:string;resolutionReference:string;resolutionDecidedAt:string;inspectionId:string;startedByName:string;startedAt:string;
  replacementAssetCode:string|null;selectedByName:string|null;selectedAt:string|null;completedByName:string|null;completedAt:string|null;executionNotes:string};
type Result={resolutionType:string|null;executionStatus:string;execution:Execution|null;canStart:boolean;canSelect:boolean;canComplete:boolean;
  originalAsset:{assetCode:string;productName:string;version:string;inventoryStatus:string;custody:string|null;locationStatus:string|null;locationCode:string|null};
  replacementAsset:(Unit&{committed:boolean;blockers:string[]})|null;candidates:Unit[];shipmentPending:boolean;rmaOpen:boolean;eligibilityReason:string};
const time=(value:string|null)=>value?new Date(value).toLocaleString('zh-CN'):'—';
const message=(error:unknown)=>error instanceof ApiClientError?error.message:'更换操作未完成，请刷新记录后重试。';
const cert=(c:Certification)=>c?`v${c.version} · ${c.status} · ${c.grade??'—'}`:'无有效认证';

export function RmaReplacement({rmaId,updated}:{rmaId:string;updated:()=>void}){
  const [data,setData]=useState<Result|null>(null),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[error,setError]=useState('');
  const [code,setCode]=useState(''),[confirmCode,setConfirmCode]=useState(''),[notes,setNotes]=useState(''),[confirmed,setConfirmed]=useState(false);
  const base=`/international/rmas/${rmaId}/replacement-execution`;
  useEffect(()=>{let active=true;
    void api<Result>(base).then(result=>{if(active)setData(result);}).catch(e=>{if(active)setError(message(e));}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};},[base]);
  const run=async(kind:'start'|'replacement-asset'|'complete',body:Record<string,string>)=>{
    if(saving)return;setSaving(true);setError('');
    try{setData(await api<Result>(`${base}/${kind}`,{method:'POST',body:JSON.stringify(body)}));updated();}
    catch(e){setError(message(e));
      // Recover a lost committed response by reading; never re-select another unit automatically.
      try{setData(await api<Result>(base));}catch{/* Keep the original error. */}}
    finally{setSaving(false);}
  };
  if(data&&data.resolutionType!=='REPLACE')return null;
  const e=data?.execution,r=data?.replacementAsset,completed=e?.status==='REPLACEMENT_COMPLETED';
  const confirmMatches=Boolean(r&&confirmCode.trim().toUpperCase()===r.assetCode.toUpperCase());
  return <section className="panel transfer-detail" data-testid="rma-replacement"><h2>Replacement Execution{completed?' · Replacement prepared — shipment pending':''}</h2>
    <p>仅执行已明确批准的 REPLACE。替换设备是独立 Asset：不覆盖原设备，不改原订单 / Allocation，不发货、不送达、不关闭 RMA，保修不变（替换设备保修将在后续阶段单独处理）。原退回设备继续保持 UK Return Quarantine。</p>
    {error&&<div className="notice notice--error" role="alert">{error}</div>}
    {loading?<div role="status">正在加载更换执行…</div>:!data?<div className="empty-state">无法加载更换执行，请刷新页面。</div>:<>
      <dl><dt>Resolution</dt><dd>{data.resolutionType}</dd><dt>Execution Status</dt><dd>{data.executionStatus}</dd>
        <dt>Original Asset</dt><dd>{data.originalAsset.assetCode} · {data.originalAsset.productName} {data.originalAsset.version}</dd>
        <dt>Original Asset State</dt><dd>{data.originalAsset.custody} / {data.originalAsset.locationStatus} / {data.originalAsset.inventoryStatus}{data.originalAsset.locationCode?` · ${data.originalAsset.locationCode}`:''}</dd>
        <dt>RMA</dt><dd>{data.rmaOpen?'Open':'Closed'}</dd>
        {e&&<><dt>Execution Reference</dt><dd>{e.id}</dd><dt>Decision Reference</dt><dd>{e.resolutionReference} · {time(e.resolutionDecidedAt)}</dd>
          <dt>Started By / At</dt><dd>{e.startedByName} · {time(e.startedAt)}</dd>
          <dt>Selected By / At</dt><dd>{e.selectedByName?`${e.selectedByName} · ${time(e.selectedAt)}`:'—'}</dd>
          <dt>Completed By / At</dt><dd>{e.completedByName?`${e.completedByName} · ${time(e.completedAt)}`:'—'}</dd>
          <dt>Execution Notes</dt><dd>{e.executionNotes||'—'}</dd></>}
      </dl>
      {r&&<><h3>Committed Replacement Asset</h3><dl data-testid="replacement-asset"><dt>Asset Code</dt><dd>{r.assetCode}</dd><dt>Product / Version</dt><dd>{r.productName} {r.version}</dd>
        <dt>Current Certification</dt><dd>{cert(r.certification)}</dd><dt>Inventory</dt><dd>{r.warehouseCode||'—'} / {r.custody} / {r.locationStatus} / {r.inventoryStatus}</dd>
        <dt>Commitment</dt><dd>{r.committed?'Reserved for this RMA · not sellable':'Not committed'}</dd></dl>
        {!!r.blockers.length&&<div className="notice notice--error" role="alert">替换设备已不再符合条件，不能完成：{r.blockers.join(' ')}</div>}</>}
      {data.canStart&&<button className="button" disabled={saving} onClick={()=>void run('start',{})}>Start Replacement Execution</button>}
      {data.canSelect&&<div className="receive-confirmation"><h3>Select Replacement Asset</h3>
        <label>Scan / enter replacement Asset Code<input aria-label="Replacement Asset Code" value={code} maxLength={100} disabled={saving} onChange={ev=>setCode(ev.target.value)}/></label>
        {data.candidates.length?<div className="table-wrap"><table><thead><tr><th>Eligible Asset</th><th>Product / Version</th><th>Certification</th><th>Inventory</th><th /></tr></thead><tbody>
          {data.candidates.map(c=><tr key={c.assetId}><td>{c.assetCode}</td><td>{c.productName} {c.version}</td><td>{cert(c.certification)}</td><td>{c.warehouseCode} / {c.custody} / {c.locationStatus}</td>
            <td><button className="button button--secondary" disabled={saving} onClick={()=>setCode(c.assetCode)}>Use</button></td></tr>)}</tbody></table></div>
          :<div className="empty-state">Scope 内没有同型号、已认证且可用的 UK 库存设备。</div>}
        <button className="button" disabled={saving||!code.trim()} onClick={()=>void run('replacement-asset',{replacementAssetCode:code})}>Commit Replacement Asset</button></div>}
      {data.canComplete&&r&&<form className="receive-confirmation" onSubmit={ev=>{ev.preventDefault();if(confirmed&&confirmMatches&&notes.trim())void run('complete',{replacementAssetCode:confirmCode,executionNotes:notes});}}>
        <h3>Complete Replacement Execution</h3>
        <label>Re-scan replacement Asset Code<input aria-label="Confirm Replacement Asset Code" value={confirmCode} maxLength={100} disabled={saving} onChange={ev=>setConfirmCode(ev.target.value)}/></label>
        {confirmCode.trim()&&<div role="status" className={`asset-match ${confirmMatches?'asset-match--success':'asset-match--error'}`}><strong>{confirmMatches?'设备匹配':'Asset 不匹配'}</strong><p>Expected: {r.assetCode}</p></div>}
        <label>Execution Notes<textarea aria-label="Replacement Execution Notes" required maxLength={4000} value={notes} disabled={saving} onChange={ev=>setNotes(ev.target.value)}/></label>
        <label><input type="checkbox" aria-label="Confirm Replacement Preparation" checked={confirmed} disabled={saving} onChange={ev=>setConfirmed(ev.target.checked)}/> 我确认替换设备已准备，尚未发货；不关闭 RMA，不改变保修</label>
        <button className="button" type="submit" disabled={saving||!confirmed||!confirmMatches||!notes.trim()}>Complete Replacement Execution</button></form>}
      {completed&&<div className="notice notice--success" role="status">Replacement prepared — shipment pending · 原设备仍为 {data.originalAsset.inventoryStatus} · RMA {data.rmaOpen?'open':'closed'} · 保修未改变。</div>}
      {!data.canStart&&!data.canSelect&&!data.canComplete&&!completed&&<p>{data.eligibilityReason}</p>}
    </>}
  </section>;
}
