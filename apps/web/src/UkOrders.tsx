import { useEffect, useState } from 'react';
import type { SessionUser } from '@maxcine/shared';
import { api, ApiClientError } from './api';
import { Shell } from './OperationsPortal';

type CertifiedWarranty = { status: string; reason: string; policyCode: string | null; start: string | null; end: string | null; sourceOrderId: string | null };
type Order = { id: string; orderNo: string; externalOrderId: string; channel: string; salesAccount: string; currency: string; status: string; assetCode: string; productName: string; currentSn: string | null; grade: string | null; certificationStatus: string | null; warehouseCode: string | null; custody: string; locationStatus: string; allocationStatus: string; shippingAddress: string; createdAt: string; carrier: string; trackingNumber: string; shippedAt: string; deliveredAt: string; canShip?: number; canDeliver?: boolean; canRecoverWarranty?: boolean; certifiedWarranty?: CertifiedWarranty };
const errorText = (error: unknown) => error instanceof ApiClientError ? error.code === 'FORBIDDEN' ? '你没有操作该订单的权限。' : error.message : '操作未完成，请稍后重试。';
const dateTime = (value: string) => value ? new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`).toLocaleString('zh-CN') : '—';

export function UkOrders({ user, route, logout }: { user: SessionUser; route: string; logout: () => void }) {
  const orderId = route.split('?')[0].match(/^\/system\/uk-fulfilment\/orders\/([^/]+)$/)?.[1];
  const deliveryView = route.split('?')[0] === '/system/uk-fulfilment/deliveries';
  const [orders, setOrders] = useState<Order[]>([]);
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [assetCode, setAssetCode] = useState('');
  const [carrier, setCarrier] = useState('');
  const [tracking, setTracking] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setOrder(null); setAssetCode(''); setCarrier(''); setTracking('');
    const load = async () => {
      try {
        if (orderId) {
          const data = await api<{ order: Order }>(`/international/orders/${orderId}`);
          if (active) { setOrder(data.order); setCarrier(data.order.carrier || ''); setTracking(data.order.trackingNumber || ''); }
        } else {
          const data = await api<{ orders: Order[] }>(`/international/orders${deliveryView ? '?view=delivery' : ''}`);
          if (active) setOrders(data.orders);
        }
      } catch (reason) { if (active) setError(errorText(reason)); }
      finally { if (active) setLoading(false); }
    };
    void load();
    return () => { active = false; };
  }, [orderId, deliveryView]);
  const matches = Boolean(order && assetCode.trim() && assetCode.trim().toUpperCase() === order.assetCode.toUpperCase());
  const ship = async () => {
    if (!order || !matches || !order.canShip || !carrier.trim() || !tracking.trim() || saving) return;
    setSaving(true); setError('');
    try {
      await api(`/international/orders/${order.id}/ship`, { method: 'POST', body: JSON.stringify({ assetCode: assetCode.trim(), carrier: carrier.trim(), trackingNumber: tracking.trim() }) });
      setOrder({ ...order, status: 'shipped', allocationStatus: 'fulfilled', custody: 'IN_TRANSIT', locationStatus: 'in_transit', canShip: 0, carrier: carrier.trim(), trackingNumber: tracking.trim(), shippedAt: new Date().toISOString() });
      const result = await api<{ order: Order }>(`/international/orders/${order.id}`);
      setOrder(result.order);
    } catch (reason) { setError(errorText(reason)); }
    finally { setSaving(false); }
  };
  const visible = orders.filter((item) => `${item.id} ${item.orderNo} ${item.externalOrderId} ${item.assetCode}`.toLowerCase().includes(search.trim().toLowerCase()));
  const deliver = async () => {
    if (!order || (!order.canDeliver && !order.canRecoverWarranty) || saving) return;
    setSaving(true); setError('');
    try {
      const result = await api<{ deliveredAt: string; certifiedWarranty: CertifiedWarranty }>(`/international/orders/${order.id}/deliver`, { method: 'POST', body: '{}' });
      setOrder({ ...order, status: 'delivered', custody: 'CUSTOMER', locationStatus: 'delivered', warehouseCode: null, deliveredAt: result.deliveredAt, certifiedWarranty: result.certifiedWarranty, canDeliver: false, canRecoverWarranty: false });
      const refreshed = await api<{ order: Order }>(`/international/orders/${order.id}`);
      setOrder(refreshed.order);
    } catch (reason) { setError(errorText(reason)); }
    finally { setSaving(false); }
  };
  return <Shell user={user} route={route} title={orderId ? '订单履约' : deliveryView ? '待确认送达' : '待发货订单'} subtitle="UK 客户订单履约" logout={logout}>
    {error && <div className="notice notice--error" role="alert">{error}</div>}
    {loading ? <div role="status" className="certified-loading">正在加载订单…</div> : orderId ? !order ? <div className="empty-state"><h2>无法加载订单。</h2><a href="#/system/uk-fulfilment/orders">返回待发货订单</a></div> : <div className="receiving-layout">
      {order.status === 'shipped' && <section className="panel transfer-detail"><h2>订单已发货</h2><dl><dt>Order ID</dt><dd>{order.id}</dd><dt>Asset Code</dt><dd>{order.assetCode}</dd><dt>Carrier</dt><dd>{order.carrier}</dd><dt>Tracking</dt><dd>{order.trackingNumber}</dd><dt>Shipped At</dt><dd>{dateTime(order.shippedAt)}</dd></dl><a className="button" href="#/system/uk-fulfilment/orders">返回待发货订单</a></section>}
      {order.status === 'shipped' && order.canDeliver && <section className="panel receive-confirmation"><h2>确认客户已收到设备</h2><p>仅在确认客户已收到此订单后操作。符合条件的 Certified 设备将自动激活内部商业保修。</p><button className="button" disabled={saving} onClick={() => void deliver()}>{saving ? '正在确认送达…' : '标记已送达'}</button></section>}
      {order.status === 'delivered' && <section className="panel transfer-detail" role="status"><h2>已送达</h2><dl><dt>Delivered At</dt><dd>{dateTime(order.deliveredAt)}</dd><dt>Asset Code</dt><dd>{order.assetCode}</dd><dt>Custody</dt><dd>CUSTOMER</dd><dt>Location Status</dt><dd>{order.locationStatus}</dd></dl><a href="#/system/uk-fulfilment/deliveries">返回待确认送达</a></section>}
      {order.canRecoverWarranty && <section className="panel receive-confirmation"><p>旧送达记录尚未评估内部 Certified Warranty。重试不会改变原送达时间。</p><button className="button" disabled={saving} onClick={() => void deliver()}>{saving ? '正在评估…' : '补齐内部保修评估'}</button></section>}
      {order.status === 'delivered' && order.certifiedWarranty && <section className="panel transfer-detail"><h2>{order.certifiedWarranty.status === 'not_activated' ? 'Certified Warranty not activated' : 'MaxCINE Certified Warranty'}</h2>{order.certifiedWarranty.policyCode ? <><div className={`asset-match asset-match--${order.certifiedWarranty.status === 'active' ? 'success' : 'error'}`} role="status"><strong>{order.certifiedWarranty.status === 'active' ? 'Active' : order.certifiedWarranty.status}</strong></div><dl><dt>Policy</dt><dd>{order.certifiedWarranty.policyCode}</dd><dt>Start</dt><dd>{dateTime(order.certifiedWarranty.start || '')}</dd><dt>End</dt><dd>{dateTime(order.certifiedWarranty.end || '')}</dd><dt>Source Order</dt><dd>{order.certifiedWarranty.sourceOrderId}</dd></dl><p>12 个月 MaxCINE Certified 商业保修，不替代消费者依法享有的权利。</p></> : <p>{order.certifiedWarranty.reason}</p>}</section>}
      <section className="panel transfer-detail"><h2>Order</h2><dl><dt>Internal Order ID</dt><dd>{order.id}<br />{order.orderNo}</dd><dt>External Order ID</dt><dd>{order.externalOrderId || '—'}</dd><dt>Channel</dt><dd>{order.channel}</dd><dt>Sales Account</dt><dd>{order.salesAccount}</dd><dt>Currency</dt><dd>{order.currency}</dd><dt>Order Status</dt><dd>{order.status}</dd></dl></section>
      <section className="panel transfer-detail"><h2>Expected Asset</h2><dl><dt>Asset Code</dt><dd>{order.assetCode}</dd><dt>Product</dt><dd>{order.productName}</dd><dt>SN 尾号</dt><dd>{order.currentSn?.slice(-6) || '—'}</dd><dt>Grade</dt><dd>{order.grade || '—'}</dd><dt>Certification Status</dt><dd>{order.certificationStatus || '—'}</dd><dt>Current Warehouse</dt><dd>{order.custody === 'WAREHOUSE' ? order.warehouseCode : '—'}</dd><dt>Custody</dt><dd>{order.custody}</dd><dt>Allocation Status</dt><dd>{order.allocationStatus}</dd></dl></section>
      <section className="panel transfer-detail"><h2>Shipping</h2><dl><dt>Buyer / Shipping Address</dt><dd>{order.shippingAddress || '未提供收货信息'}</dd></dl></section>
      {!['shipped', 'delivered'].includes(order.status) && (order.canShip ? <section className="panel receive-confirmation"><label>输入 Asset Code<input aria-label="输入 Asset Code" value={assetCode} onChange={(event) => setAssetCode(event.target.value)} autoComplete="off" placeholder="手工输入设备 Asset Code" disabled={saving} /></label>
        {assetCode.trim() && <div className={`asset-match asset-match--${matches ? 'success' : 'error'}`} role="status"><strong>{matches ? '设备匹配' : 'Asset 不匹配'}</strong><span>Expected Asset Code：{order.assetCode}</span><span>{matches ? 'Received' : 'Actual Input'}：{assetCode.trim()}</span>{!matches && <span>扫描/输入的设备与订单绑定设备不一致。</span>}</div>}
        <label>Carrier<input aria-label="Carrier" value={carrier} onChange={(event) => setCarrier(event.target.value)} placeholder="例如 Royal Mail" maxLength={80} disabled={saving} /></label><label>Tracking Number<input aria-label="Tracking Number" value={tracking} onChange={(event) => setTracking(event.target.value)} placeholder="输入运单号" maxLength={160} disabled={saving} /></label>
        <button className="button" disabled={!matches || !carrier.trim() || !tracking.trim() || saving} onClick={() => void ship()}>{saving ? '正在发货…' : '确认发货'}</button>
      </section> : <div className="notice notice--error">该设备当前不在 UK 可发库存中，或未被此订单有效预留。请刷新订单后重试。</div>)}
      <a href="#/system/uk-fulfilment/orders">返回待发货订单</a>
    </div> : <><div className="certified-toolbar"><a href="#/system/uk-fulfilment/orders">待发货订单</a>{user.permissions.includes('international-order:deliver') && <a href="#/system/uk-fulfilment/deliveries">待确认送达</a>}<input aria-label="搜索订单" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索订单 ID / Asset Code" /></div><div className="table-wrap"><table><thead><tr>{['Internal Order ID', 'External Order ID', 'Channel', 'Product', 'Expected Asset Code', 'Order Status', 'Allocation Status', 'Created At', '收货信息', '操作'].map((label) => <th key={label}>{label}</th>)}</tr></thead><tbody>{visible.map((item) => <tr key={item.id}><td>{item.id}<small>{item.orderNo}</small></td><td>{item.externalOrderId}</td><td>{item.channel}</td><td>{item.productName}</td><td>{item.assetCode}</td><td>{item.status}</td><td>{item.allocationStatus}</td><td>{dateTime(item.createdAt)}</td><td>{item.shippingAddress}</td><td><a className="button button--secondary" href={`#/system/uk-fulfilment/orders/${item.id}`}>打开</a></td></tr>)}</tbody></table>{!visible.length && <div className="empty-state"><h2>{deliveryView ? '当前没有待确认送达的订单。' : '当前没有待发货订单。'}</h2><p>{deliveryView ? '已送达订单会自动从此列表移除。' : '已发货订单会自动从此列表移除。'}</p></div>}</div></>}
  </Shell>;
}
