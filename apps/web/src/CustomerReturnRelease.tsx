import { useEffect,useState } from 'react';
import { api,ApiClientError } from './api';

type Result={state:'NOT_RELEASED'|'CUSTOMER_RETURN_RELEASED';canRelease:boolean;eligible:boolean;blockingReason:string|null;assetCode:string;orderReference:string;
  resolution:string|null;repairStatus:string|null;reinspectionStatus:string|null;rmaOpen:boolean;
  certification:{id:string;version:number;status:string}|null;
  inventory:{warehouse:string|null;custody:string|null;inventoryStatus:string;locationStatus:string|null;locationCode:string|null;sellable:boolean};
  release:{id:string;purpose:string;reason:string;releasedByName:string;releasedAt:string;certificationId:string;certificationVersion:number}|null};
const message=(error:unknown)=>error instanceof ApiClientError?error.message:'操作未完成，请稍后重试。';
const time=(value:string)=>new Date(value).toLocaleString('zh-CN');

export function CustomerReturnRelease({rmaId}:{rmaId:string}){
  const base=`/international/rmas/${rmaId}/customer-return-release`;
  const [data,setData]=useState<Result|null>(null),[reason,setReason]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{let active=true;setError('');void api<Result>(base).then(value=>{if(active)setData(value);}).catch(value=>{if(active)setError(message(value));});return()=>{active=false;};},[base]);
  const submit=async()=>{if(!reason.trim()||busy)return;setBusy(true);setError('');try{setData(await api<Result>(base,{method:'POST',body:JSON.stringify({reason})}));}
    catch(value){setError(message(value));}finally{setBusy(false);}};
  return <section className="panel transfer-detail" data-testid="customer-return-release"><h2>Release for Customer Return</h2>
    <p>这是返还原客户的授权，不是发运或库存释放。设备仍在 UK Return Quarantine，不能销售、Listing 或 Allocation。</p>
    {error&&<div className="notice notice--error" role="alert">{error}</div>}
    {!data?<div role="status">正在加载原客户返还授权…</div>:<><dl>
      <dt>Asset Code</dt><dd>{data.assetCode}</dd><dt>Original Order</dt><dd>{data.orderReference}</dd>
      <dt>Resolution</dt><dd>{data.resolution||'—'}</dd><dt>Repair</dt><dd>{data.repairStatus||'—'}</dd>
      <dt>Reinspection</dt><dd>{data.reinspectionStatus||'—'}</dd><dt>Current Certification</dt><dd>{data.certification?`v${data.certification.version} · ${data.certification.status}`:'—'}</dd>
      <dt>Physical State</dt><dd>{data.inventory.warehouse||'—'} / {data.inventory.custody||'—'} / {data.inventory.locationStatus||'—'}</dd>
      <dt>Inventory</dt><dd>{data.inventory.inventoryStatus} · {data.inventory.locationCode||'—'} · {data.inventory.sellable?'Sellable':'Not sellable'}</dd>
    </dl>
    {data.release?<><div className="notice notice--success" role="status"><strong>CUSTOMER_RETURN_RELEASED</strong><p>已授权返还原客户，尚未发运。设备仍处于隔离库存，不可销售。</p></div>
      <dl><dt>Authorized By</dt><dd>{data.release.releasedByName}</dd><dt>Authorized At</dt><dd>{time(data.release.releasedAt)}</dd><dt>Release Reason</dt><dd>{data.release.reason}</dd>
        <dt>Certification Reference</dt><dd>v{data.release.certificationVersion} · {data.release.certificationId}</dd></dl></>
      :data.canRelease?<div className="receive-confirmation"><label>Release Reason<textarea aria-label="Customer Return Release Reason" required maxLength={1000} value={reason} disabled={busy} onChange={event=>setReason(event.target.value)}/></label>
        <button className="button" disabled={busy||!reason.trim()} onClick={()=>void submit()}>{busy?'正在授权…':'Confirm Customer Return Release'}</button></div>
      :<div className="empty-state">{data.blockingReason||'当前用户没有执行原客户返还授权的权限。'}</div>}</>}
  </section>;
}
