import { useEffect, useState } from 'react';
import type { SessionUser } from '@maxcine/shared';
import { api, ApiClientError } from './api';
import { Shell } from './OperationsPortal';

type ReturnRma = { id: string; rmaReference: string; assetCode: string; productName: string; reason: string; carrier: string;
  returnTracking: string; returnWarehouse: string; shippedAt: string; receivedAt: string | null; businessStatus: string; canReceiveReturn: boolean; inventoryStatus: string };
type QuarantinedAsset = { rmaId: string; assetId: string; assetCode: string; productName: string; assetStatus: string; custody: string; warehouse: string; location: string; rmaReference: string; receivedAt: string };
const dateTime = (value: string) => value ? new Date(value).toLocaleString('zh-CN') : '—';
const errorText = (error: unknown) => error instanceof ApiClientError ? error.code === 'FORBIDDEN' ? '你没有 UK 退货收货或该 RMA 的操作权限。' : error.message : '操作未完成，请重试。';

export function ReturnReceiving({ user, route, logout }: { user: SessionUser; route: string; logout: () => void }) {
  const base = '/system/uk-fulfilment/return-receiving';
  const quarantine = route.split('?')[0] === '/system/uk-fulfilment/return-quarantine';
  const detailId = route.split('?')[0].match(/\/return-receiving\/([^/]+)$/)?.[1];
  const [rma, setRma] = useState<ReturnRma | null>(null);
  const [rows, setRows] = useState<ReturnRma[]>([]);
  const [assets, setAssets] = useState<QuarantinedAsset[]>([]);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true; setLoading(true); setError(''); setCode(''); setRma(null);
    const load = async () => {
      try {
        if (detailId) { const result = await api<{ rma: ReturnRma }>(`/international/rmas/${detailId}`); if (active) setRma(result.rma); }
        else if (quarantine) { const result = await api<{ assets: QuarantinedAsset[] }>('/international/warehouses/return-quarantine'); if (active) setAssets(result.assets); }
        else { const result = await api<{ rmas: ReturnRma[] }>('/international/rmas/awaiting-return-receipt'); if (active) setRows(result.rmas); }
      } catch (error) { if (active) setError(errorText(error)); }
      finally { if (active) setLoading(false); }
    };
    void load(); return () => { active = false; };
  }, [detailId, quarantine]);
  const matches = Boolean(rma && code.trim() && code.trim().toUpperCase() === rma.assetCode.toUpperCase());
  const receive = async () => {
    if (!rma?.canReceiveReturn || !matches || saving) return;
    setSaving(true); setError('');
    try { setRma((await api<{ rma: ReturnRma }>(`/international/rmas/${rma.id}/receive-return`, { method: 'POST', body: JSON.stringify({ assetCode: code }) })).rma); }
    catch (error) { setError(errorText(error)); }
    finally { setSaving(false); }
  };
  return <Shell user={user} route={route} logout={logout} title={quarantine ? 'UK Return Quarantine' : 'Awaiting Return Receipt'} subtitle="Physical Inventory ≠ Sellable Inventory；退货收货后进入隔离区" >
    {error && <div className="notice notice--error" role="alert">{error}</div>}
    {loading ? <div role="status">正在加载退货…</div> : rma ? <section className="panel transfer-detail"><h2>{rma.receivedAt ? 'UK 退货收货完成' : 'UK Receive Return'}</h2><dl>
      <dt>RMA Reference</dt><dd>{rma.rmaReference}</dd><dt>Status</dt><dd>{rma.businessStatus}</dd><dt>Expected Asset Code</dt><dd>{rma.assetCode}</dd>
      <dt>Product</dt><dd>{rma.productName}</dd><dt>Reason</dt><dd>{rma.reason}</dd><dt>Return Warehouse</dt><dd>{rma.returnWarehouse}</dd>
      <dt>Carrier / Tracking</dt><dd>{rma.carrier} · {rma.returnTracking}</dd><dt>Shipped At</dt><dd>{dateTime(rma.shippedAt)}</dd>
    </dl>{rma.receivedAt ? <div className="notice"><p>RECEIVED · WAREHOUSE · UK Return Quarantine · QUARANTINED</p><p>Received At：{dateTime(rma.receivedAt)}</p><p>设备不可销售、不可预留、不可重新 Listing；原认证和保修保持原样。</p><a href="#/system/uk-fulfilment/return-quarantine">查看 UK 隔离库存</a></div>
      : rma.canReceiveReturn ? <div className="receive-confirmation"><label>输入 Asset Code<input aria-label="输入 Asset Code" value={code} onChange={(event) => setCode(event.target.value)} disabled={saving} /></label>
        {code.trim() && (matches ? <div className="asset-match asset-match--success"><strong>设备匹配</strong><span>Expected：{rma.assetCode}</span><span>Received：{code.trim()}</span></div>
          : <div className="asset-match asset-match--error" role="alert"><strong>Asset 不匹配</strong><span>Expected Asset Code：{rma.assetCode}</span><span>Actual Input：{code.trim()}</span></div>)}
        <p>确认后设备进入 UK 退货隔离区，不恢复可售。</p><button className="button" disabled={!matches || saving} onClick={() => void receive()}>{saving ? '正在收货…' : '确认退货收货'}</button></div>
        : <div className="notice notice--error">该 RMA 不在待收货状态，或你没有收货权限；不能跳过寄回步骤。</div>}
      <a className="button" href={`#${base}`}>返回 Awaiting Return Receipt</a></section>
      : detailId ? <div className="empty-state">无法加载该退货。</div> : quarantine ? <div className="table-wrap"><table><thead><tr>{['Asset Code','Product','Status','Custody','Warehouse','Location','RMA','Received At'].map((name) => <th key={name}>{name}</th>)}</tr></thead><tbody>{assets.map((asset) => <tr key={asset.assetId}><td>{asset.assetCode}</td><td>{asset.productName}</td><td>{asset.assetStatus}</td><td>{asset.custody}</td><td>{asset.warehouse}</td><td>{asset.location}</td><td><a href={`#/system/uk-fulfilment/rmas/${asset.rmaId}`}>{asset.rmaReference}</a></td><td>{dateTime(asset.receivedAt)}</td></tr>)}</tbody></table>{!assets.length && <div className="empty-state">当前没有 UK 退货隔离设备。</div>}</div>
        : <div className="table-wrap"><table><thead><tr>{['RMA Reference','Asset Code','Product','Reason','Carrier','Tracking','Return Warehouse','Shipped At','操作'].map((name) => <th key={name}>{name}</th>)}</tr></thead><tbody>{rows.map((rma) => <tr key={rma.id}><td>{rma.rmaReference}</td><td>{rma.assetCode}</td><td>{rma.productName}</td><td>{rma.reason}</td><td>{rma.carrier}</td><td>{rma.returnTracking}</td><td>{rma.returnWarehouse}</td><td>{dateTime(rma.shippedAt)}</td><td><a href={`#${base}/${rma.id}`}>打开收货</a></td></tr>)}</tbody></table>{!rows.length && <div className="empty-state">当前没有待收货的 UK 退货。</div>}</div>}
  </Shell>;
}
