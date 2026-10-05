import { useEffect, useMemo, useState } from 'react';
import type { SessionUser } from '@maxcine/shared';
import { api, ApiClientError } from './api';
import { Shell } from './OperationsPortal';

type Warranty = { status: string; policyCode: string | null; start: string | null; end: string | null; sourceOrderId: string | null };
type Rma = { id: string; rmaReference: string; assetCode: string; productName: string; orderReference: string; orderId: string;
  marketRegion: string; reason: string; reasonNote: string; businessStatus: string; returnWarehouse: string;
  carrier: string; returnTracking: string; createdAt: string; warrantySnapshot: Warranty };
type Context = { assetId: string; assetCode: string; productName: string; orderId: string; orderReference: string; marketRegion: string;
  warehouses: { id: string; code: string; name: string }[]; reasons: string[]; activeRma: { id: string; rmaReference: string | null } | null; warranty: Warranty };
const reasonNames: Record<string, string> = { DEFECTIVE: 'DEFECTIVE · 设备故障', DAMAGED: 'DAMAGED · 设备损坏', NOT_AS_DESCRIBED: 'NOT_AS_DESCRIBED · 与描述不符', BUYER_REMORSE: 'BUYER_REMORSE · 改变主意', WRONG_ITEM: 'WRONG_ITEM · 商品错误', OTHER: 'OTHER · 其他' };
const errorText = (error: unknown) => error instanceof ApiClientError ? error.code === 'FORBIDDEN' ? '你没有操作该 RMA / 市场 / 退货仓库的权限。' : error.message : '操作未完成，请稍后重试。';
const dateTime = (value: string) => value ? new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`).toLocaleString('zh-CN') : '—';

export function RmaIntake({ user, route, logout }: { user: SessionUser; route: string; logout: () => void }) {
  const base = route.startsWith('/system/international') ? '/system/international/rmas' : '/system/uk-fulfilment/rmas';
  const path = route.split('?')[0];
  const orderId = path.endsWith('/new') ? new URLSearchParams(route.split('?')[1]).get('orderId') : null;
  const detailId = !path.endsWith('/new') ? path.match(/\/rmas\/([^/]+)$/)?.[1] : null;
  const requestIdentity = useMemo(() => ({ orderId, key: crypto.randomUUID() }), [orderId]);
  const [context, setContext] = useState<Context | null>(null);
  const [rma, setRma] = useState<Rma | null>(null);
  const [rmas, setRmas] = useState<Rma[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [reason, setReason] = useState('DEFECTIVE');
  const [note, setNote] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [carrier, setCarrier] = useState('');
  const [tracking, setTracking] = useState('');
  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setContext(null); setRma(null); setReason('DEFECTIVE'); setNote(''); setCarrier(''); setTracking('');
    const load = async () => {
      try {
        if (orderId) {
          const data = await api<{ context: Context }>(`/international/rmas/intake-context?orderId=${encodeURIComponent(orderId)}`);
          if (active) { setContext(data.context); setWarehouseId(data.context.warehouses.find((w) => w.code === 'UK')?.id || data.context.warehouses[0]?.id || ''); }
        } else if (detailId) {
          const data = await api<{ rma: Rma }>(`/international/rmas/${detailId}`);
          if (active) setRma(data.rma);
        } else if (path.endsWith('/new')) throw new Error('请选择已送达订单。');
        else {
          const data = await api<{ rmas: Rma[] }>('/international/rmas');
          if (active) setRmas(data.rmas);
        }
      } catch (reason) { if (active) setError(errorText(reason)); }
      finally { if (active) setLoading(false); }
    };
    void load(); return () => { active = false; };
  }, [orderId, detailId, path]);
  const submit = async () => {
    if (!context || context.activeRma || !warehouseId || saving) return;
    setSaving(true); setError('');
    try {
      const result = await api<{ rma: Rma }>('/international/rmas', { method: 'POST', body: JSON.stringify({
        orderId: context.orderId, assetId: context.assetId, reason, reasonNote: note, returnWarehouseId: warehouseId,
        carrier, returnTracking: tracking, idempotencyKey: requestIdentity.key
      }) });
      setRma(result.rma); setContext(null);
      location.hash = `${base}/${result.rma.id}`;
    } catch (reason) { setError(errorText(reason)); }
    finally { setSaving(false); }
  };
  return <Shell user={user} route={route} title={orderId ? 'Open RMA' : detailId ? 'RMA 退货授权' : 'Open RMAs'} subtitle="仅记录退货授权；尚未发回或收货" logout={logout}>
    {error && <div className="notice notice--error" role="alert">{error}</div>}
    {loading ? <div role="status">正在加载 RMA…</div> : rma ? <section className="panel transfer-detail"><h2>退货已授权</h2><p>RMA 已建立，客户可以退回至指定仓库；设备仍由客户持有，尚未收货。</p><dl>
      <dt>RMA Reference</dt><dd>{rma.rmaReference}</dd><dt>Status</dt><dd>{rma.businessStatus}</dd>
      <dt>Asset Code</dt><dd>{rma.assetCode}</dd><dt>Product</dt><dd>{rma.productName}</dd><dt>Order</dt><dd>{rma.orderReference}</dd>
      <dt>Market</dt><dd>{rma.marketRegion}</dd><dt>Reason</dt><dd>{reasonNames[rma.reason] || rma.reason}</dd>
      <dt>Note</dt><dd>{rma.reasonNote || '—'}</dd><dt>Return Warehouse</dt><dd>{rma.returnWarehouse}</dd>
      <dt>Carrier</dt><dd>{rma.carrier || '尚未填写'}</dd><dt>Return Tracking</dt><dd>{rma.returnTracking || '客户尚未寄出 / 未填写'}</dd>
      <dt>Created At</dt><dd>{dateTime(rma.createdAt)}</dd><dt>Warranty Snapshot</dt><dd>{rma.warrantySnapshot?.status || 'not_activated'}{rma.warrantySnapshot?.policyCode && ` · ${rma.warrantySnapshot.policyCode}`}</dd>
    </dl><p>此退货授权不代表免费维修或任何 Resolution 决定，保修保持原样。</p><a className="button" href={`#${base}`}>返回 Open RMAs</a></section>
      : context ? context.activeRma ? <div className="notice notice--error">该设备已有活动 RMA / 售后工单，不能重复创建。{context.activeRma.rmaReference && <a href={`#${base}/${context.activeRma.id}`}>打开 {context.activeRma.rmaReference}</a>}</div>
        : <form className="panel receive-confirmation" onSubmit={(event) => { event.preventDefault(); void submit(); }}><h2>Open RMA</h2><dl><dt>Asset Code</dt><dd>{context.assetCode}</dd><dt>Order Reference</dt><dd>{context.orderReference}</dd><dt>Market</dt><dd>{context.marketRegion}</dd><dt>Warranty</dt><dd>{context.warranty.status} · {context.warranty.policyCode || '无 Certified 商业保修'}</dd></dl>
          <p>商业保修不生效也可以申请退货授权。本轮不会改变 Custody 或 Warranty。</p>
          <label>Return Reason<select aria-label="Return Reason" value={reason} onChange={(event) => setReason(event.target.value)} disabled={saving}>{context.reasons.map((code) => <option key={code} value={code}>{reasonNames[code]}</option>)}</select></label>
          <label>Optional Note<textarea aria-label="Optional Note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={1000} disabled={saving} /></label>
          <label>Return Warehouse<select aria-label="Return Warehouse" value={warehouseId} onChange={(event) => setWarehouseId(event.target.value)} disabled={saving}>{!context.warehouses.length && <option value="">没有可用退货仓库</option>}{context.warehouses.map((warehouse) => <option value={warehouse.id} key={warehouse.id}>{warehouse.code} · {warehouse.name}</option>)}</select></label>
          <label>Carrier (Optional)<input aria-label="Return Carrier" value={carrier} onChange={(event) => setCarrier(event.target.value)} maxLength={80} disabled={saving} /></label>
          <label>Return Tracking (Optional)<input aria-label="Return Tracking" value={tracking} onChange={(event) => setTracking(event.target.value)} maxLength={160} disabled={saving} /></label>
          <button className="button" type="submit" disabled={saving || !warehouseId}>{saving ? '正在创建…' : '创建并授权退货'}</button>
        </form> : detailId || orderId || path.endsWith('/new') ? <div className="empty-state">无法加载 RMA；请返回已送达订单重试。</div>
        : <div className="table-wrap"><table><thead><tr>{['RMA Reference','Asset Code','Product','Order','Reason','Status','Return Warehouse','Tracking','Created At','操作'].map((label) => <th key={label}>{label}</th>)}</tr></thead><tbody>{rmas.map((item) => <tr key={item.id}><td>{item.rmaReference}</td><td>{item.assetCode}</td><td>{item.productName}</td><td>{item.orderReference}</td><td>{reasonNames[item.reason] || item.reason}</td><td>{item.businessStatus}</td><td>{item.returnWarehouse}</td><td>{item.carrier} {item.returnTracking || '未填写'}</td><td>{dateTime(item.createdAt)}</td><td><a href={`#${base}/${item.id}`}>打开</a></td></tr>)}</tbody></table>{!rmas.length && <div className="empty-state"><h2>当前没有活动 RMA。</h2><p>从已送达订单使用 Open RMA 创建退货授权。</p></div>}</div>}
  </Shell>;
}
