import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import type { OrderStatus, SessionUser } from '@maxcine/shared';
import { api, ApiClientError } from './api';
import { BrowserBarcodeScanner } from './scanner';
import { AdminManagementPortal } from './AdminManagementPortal';
import { GsxPortal } from './GsxPortal';
import { AccountMenu, SystemNavigation, displayRoleText, hasAdminAccess, hasDealerAccess, hasServiceCenterAccess } from './systemNavigation';

type Notice = { tone: 'error' | 'success'; text: string } | null;
type Order = { id: string; orderNo: string; dealerName?: string; storeName: string; status: OrderStatus; totalCents: number; itemCount: number; itemSummary?: string; serialSummary?: string; fulfillmentCarrier?: string; fulfillmentTrackingNumber?: string; createdAt: string };
type OrderDetail = {
  order: Order & { note: string; reviewNote?: string; submittedAt: string | null; reviewedAt: string | null; salePriceCents: number | null; shippingAddress: string; customerProfile: string; screenshotDataUrl: string; packageMaterials?: string; fulfillmentCarrier?: string; fulfillmentTrackingNumber?: string };
  items: Array<{ id: string; productId: string; name: string; sku: string; productVersion?: string; specification?: string; materialCode?: string; warrantyDays?: number | null; quantity: number; unitPriceCents: number }>;
  serials: Array<{ id: string; productId: string; serialNumber: string }>;
  shipment: { carrier: string; trackingNumber: string; shippedAt: string } | null;
};
type AvailableSerialGroup = {
  productId: string;
  productName: string;
  sku: string;
  productVersion: string;
  quantity: number;
  serials: Array<{ assetId: string; serialNumber: string; originalSn: string | null; assetStatus: string; dataQualityStatus: string; sourceChannel: string; shippingWarehouse: string; productNote: string; assetNote: string | null; allocatedToThisOrder: number; updatedAt: string }>;
};

type Props = { user: SessionUser; route: string; logout: () => void };
type InventoryRow = { id: string; sku: string; name: string; availableQuantity: number; reservedQuantity: number; reorderLevel: number };
type NotificationRow = { id: string; title: string; body: string; link: string | null; readAt: string | null; createdAt: string };

const statusName: Record<OrderStatus, string> = { draft: '草稿', submitted: '待审核', approved: '待发货', rejected: '已驳回', picking: '待发货', packed: '待发货', shipped: '已发货', delivered: '已签收', cancelled: '已取消' };
const packageOptions = ['顺丰f1纸箱', '顺丰f2纸箱', '普通纸箱', '定制纸箱', '防水袋', '文件袋', '葫芦泡（白色普通）', '葫芦泡（蓝色加强）'];
const money = (value: number) => `¥${(value / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}`;
const date = (value: string | null | undefined) => value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', hour12: false }).format(new Date(`${value.replace(' ', 'T')}Z`)) : '—';
const errorText = (error: unknown) => error instanceof ApiClientError ? error.message : '操作未完成，请稍后重试。';
const splitLines = (value: string) => value.split(/[\n\r,，、\s]+/).map((item) => item.trim()).filter(Boolean);
function Button({ children, onClick, href, secondary = false, danger = false, disabled = false, type = 'button' }: { children: ReactNode; onClick?: () => void; href?: string; secondary?: boolean; danger?: boolean; disabled?: boolean; type?: 'button' | 'submit' }) { const className = `button ${secondary ? 'button--secondary' : ''} ${danger ? 'button--danger' : ''}`; return href ? <a className={className} href={href}>{children}</a> : <button type={type} className={className} disabled={disabled} onClick={onClick}>{children}</button>; }
function Alert({ notice }: { notice: Notice }) { return notice ? <div className={`notice notice--${notice.tone === 'error' ? 'error' : 'info'}`}>{notice.text}</div> : null; }

export function Shell({ user, route, title, subtitle, children, logout }: { user: SessionUser; route: string; title: string; subtitle: string; children: ReactNode; logout: () => void }) {
  const [open, setOpen] = useState(false);
  const path = route.split('?')[0];
  const warehouse = path.startsWith('/system/warehouse') && user.permissions.includes('order:fulfill');
  const serviceCenter = path.startsWith('/system/service-center');
  return <div className="system"><header className="system-top"><img className="system-light-logo" src="/assets/maxcine-logo-on-light.png" alt="MaxCINE" /><button className="menu-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>菜单</button><a className="global-search" href={`#${warehouse ? '/system/warehouse' : serviceCenter ? '/system/service-center/assets' : '/system/admin/assets'}`}>{warehouse ? '搜索待发货订单' : '搜索资产或订单'}</a><a className="top-notifications" href="#/system/notifications">通知</a><AccountMenu user={user} logout={logout} /></header><aside className={`system-nav ${open ? 'is-open' : ''}`}><img className="system-dark-logo" src="/assets/maxcine-logo-on-dark.png" alt="MaxCINE" /><SystemNavigation user={user} route={route} onNavigate={() => setOpen(false)} /><a href="#/" className="nav-exit">返回官网</a></aside><main className="system-main"><header className="page-title"><span className="eyebrow">MAXCINE / {displayRoleText(user)}</span><h1>{title}</h1><p>{subtitle}</p></header>{children}</main></div>;
}

function AdminDashboard({ user, route, logout }: Props) {
  const [data, setData] = useState<{ summary: Record<string, number> } | null>(null);
  useEffect(() => { api<{ summary: Record<string, number> }>('/admin/dashboard').then(setData).catch(() => undefined); }, []);
  const cards: Array<[string, string, string]> = [['待审核订单', 'submitted', '/system/admin/orders?status=submitted'], ['待处理售后', 'service', '/system/admin/after-sales'], ['待处理定损', 'assessment', '/system/admin/after-sales'], ['待发货订单', 'fulfillment', '/system/admin/orders?status=pending_shipment'], ['库存紧张产品', 'lowStock', '/system/admin/inventory'], ['今日订单', 'today', '/system/admin/orders'], ['本月订单', 'month', '/system/admin/orders']];
  return <Shell user={user} route={route} title="工作台" subtitle="查看订单、库存、履约和售后事项。" logout={logout}>{!data ? <p>正在加载…</p> : <div className="stats operations-stats">{cards.map(([label, key, href]) => <a className="stat" href={`#${href}`} key={key}><p>{label}</p><strong>{data.summary[key]}</strong><span>查看明细</span></a>)}</div>}</Shell>;
}

function Orders({ user, route, logout, warehouse = false }: Props & { warehouse?: boolean }) {
  const params = new URLSearchParams(route.split('?')[1] ?? '');
  const [status, setStatus] = useState(params.get('status') ?? (warehouse ? 'pending_shipment' : 'submitted'));
  const [orders, setOrders] = useState<Order[]>([]);
  const [notice, setNotice] = useState<Notice>(null);
  useEffect(() => { api<{ orders: Order[] }>(`/orders?limit=100${status === 'all' ? '' : `&status=${status}`}`).then((value) => setOrders(value.orders)).catch((error) => setNotice({ tone: 'error', text: errorText(error) })); }, [status]);
  const tabs: Array<[string, string]> = warehouse ? [['pending_shipment', '待处理'], ['shipped', '已发货']] : [['submitted', '待审核'], ['pending_shipment', '待发货'], ['shipped', '已发货'], ['rejected', '已驳回'], ['all', '全部']];
  return <Shell user={user} route={route} title={warehouse ? '发货' : '订单管理'} subtitle={warehouse ? '核对订单、扫描产品 SN，然后一次确认发货。' : '审核订单并安排 SN、包装和快递信息。'} logout={logout}><Alert notice={notice} /><div className="filter-row">{tabs.map(([value, label]) => <button className={`filter ${status === value ? 'active' : ''}`} onClick={() => setStatus(value)} key={value}>{label}</button>)}</div><div className="table-wrap"><table><thead><tr>{warehouse ? <><th>订单编号</th><th>产品</th><th>数量</th><th>经销商</th><th>快递单号</th><th>已预留 SN</th><th>操作</th></> : <><th>订单编号</th><th>店铺</th><th>商品</th><th>订单金额</th><th>状态</th><th>创建时间</th><th>操作</th></>}</tr></thead><tbody>{orders.map((order) => <tr key={order.id}>{warehouse ? <><td>{order.orderNo}</td><td>{order.itemSummary || '—'}</td><td>{order.itemCount}</td><td>{order.dealerName || '—'}</td><td>{order.fulfillmentTrackingNumber || '可发货后补'}</td><td>{order.serialSummary || '待扫描'}</td><td><a href={`#/system/warehouse/order/${order.id}`}>去发货</a></td></> : <><td>{order.orderNo}</td><td>{order.storeName}</td><td>{order.itemSummary || `${order.itemCount} 件`}</td><td>{money(order.totalCents)}</td><td><span className={`status status--${order.status}`}>{statusName[order.status]}</span></td><td>{date(order.createdAt)}</td><td><a href={`#/system/admin/order/${order.id}`}>查看详情</a></td></>}</tr>)}</tbody></table>{!orders.length && <div className="empty-state"><h2>{warehouse ? '暂无待处理订单。' : '暂无符合条件的订单。'}</h2></div>}</div></Shell>;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function OrderPageLegacy({ user, route, logout, warehouse = false, orderId }: Props & { warehouse?: boolean; orderId: string }) {
  const [data, setData] = useState<OrderDetail | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [tracking, setTracking] = useState('');
  const [serialText, setSerialText] = useState('');
  const [carrier, setCarrier] = useState('顺丰速运');
  const [allocationMode, setAllocationMode] = useState<'none' | 'random' | 'manual'>('none');
  const [packageMaterials, setPackageMaterials] = useState<string[]>([]);
  const scanner = useMemo(() => new BrowserBarcodeScanner(), []);
  const load = useCallback(() => api<OrderDetail>(`/orders/${orderId}`).then((value) => { setData(value); setTracking(value.order.fulfillmentTrackingNumber || value.shipment?.trackingNumber || ''); setCarrier(value.order.fulfillmentCarrier || value.shipment?.carrier || '顺丰速运'); setPackageMaterials((value.order.packageMaterials || '').split('、').filter(Boolean)); setSerialText(value.serials.map((item) => item.serialNumber).join('\n')); }).catch((error) => setNotice({ tone: 'error', text: errorText(error) })), [orderId]);
  useEffect(() => { void load(); }, [load]);
  const action = async (path: string, body?: unknown, success?: string) => { try { await api(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }); setNotice({ tone: 'success', text: success ?? '操作已完成。' }); void load(); } catch (error) { setNotice({ tone: 'error', text: errorText(error) }); } };
  const review = async (approved: boolean) => { const note = approved ? '' : window.prompt('请填写审核不通过原因，可说明缺货、黑名单用户、禁售地区或其他原因：') ?? ''; if (!approved && !note.trim()) return; await action(`/orders/${orderId}/review`, { approved, note }, approved ? '订单已审核通过，请继续安排 SN 和快递信息。' : '订单已驳回，经销商可修改原订单后重新提交。'); };
  const saveFulfillment = async () => action(`/orders/${orderId}/fulfillment`, { packageMaterials, carrier, trackingNumber: tracking, allocationMode, serialNumbers: splitLines(serialText) }, '履约安排已保存。');
  const useCamera = async () => { try { await scanner.start((result) => setSerialText((value) => `${value}${value ? '\n' : ''}${result.value.trim()}`)); } catch { setNotice({ tone: 'error', text: '无法启用摄像头，请改用扫描枪或手动输入。' }); } };
  const ship = async () => { if (!splitLines(serialText).length) { setNotice({ tone: 'error', text: '确认发货前必须录入产品 SN。' }); return; } if (!window.confirm('确认发货吗？系统会绑定订单、SN 和保修日期。')) return; await action(`/orders/${orderId}/ship`, { carrier, trackingNumber: tracking, serialNumbers: splitLines(serialText) }, '订单已确认发货。'); };
  const canShip = data && ['approved', 'picking', 'packed'].includes(data.order.status);
  return <Shell user={user} route={route} title={warehouse ? '发货订单' : '订单详情'} subtitle={data?.order.orderNo ?? '正在加载订单'} logout={logout}><Alert notice={notice} />{!data ? <p>正在加载…</p> : <div className="order-layout"><section className="panel detail-header"><div><span className={`status status--${data.order.status}`}>{statusName[data.order.status]}</span><h2>{data.order.orderNo}</h2><p>{data.order.storeName}</p></div><div className="action-list">{!warehouse && data.order.status === 'submitted' && <><Button onClick={() => review(true)}>审核通过</Button><Button secondary onClick={() => review(false)}>驳回订单</Button></>}{!warehouse && ['approved', 'picking', 'packed'].includes(data.order.status) && <Button danger onClick={() => action(`/orders/${orderId}/cancel`, undefined, '订单已取消，预留库存已释放。')}>取消订单</Button>}{warehouse && canShip && <Button onClick={ship}>确认发货</Button>}</div></section>{!warehouse && <section className="panel"><div className="panel-title"><h2>销售信息</h2></div><dl className="detail-grid"><dt>售卖价格</dt><dd>{data.order.salePriceCents === null ? '—' : money(data.order.salePriceCents)}</dd><dt>收货地址</dt><dd>{data.order.shippingAddress || '—'}</dd><dt>用户画像</dt><dd>{data.order.customerProfile || '—'}</dd><dt>经销商备注</dt><dd>{data.order.note || '—'}</dd><dt>审核意见</dt><dd>{data.order.reviewNote || '—'}</dd></dl>{data.order.screenshotDataUrl && <div className="order-screenshot-preview"><span>订单截图</span><img src={data.order.screenshotDataUrl} alt="订单截图" /></div>}</section>}<section className="panel"><div className="panel-title"><h2>商品与 SN</h2></div><div className="table-wrap"><table><thead><tr><th>产品</th><th>版本</th><th>SKU / 物料编码</th><th>数量</th>{!warehouse && <th>单价</th>}<th>保修天数</th><th>已绑定 SN</th></tr></thead><tbody>{data.items.map((item) => <tr key={item.id}><td>{item.name}</td><td>{item.productVersion || item.specification || '—'}</td><td>{item.materialCode || item.sku}</td><td>{item.quantity}</td>{!warehouse && <td>{money(item.unitPriceCents)}</td>}<td>{item.warrantyDays ? `${item.warrantyDays} 天` : '待确认'}</td><td>{data.serials.filter((value) => value.productId === item.productId).map((value) => value.serialNumber).join('、') || '—'}</td></tr>)}</tbody></table></div></section>{!warehouse && ['approved', 'picking', 'packed'].includes(data.order.status) && <section className="panel"><div className="panel-title"><h2>履约安排</h2><span>管理员线下下单快递后在这里保存信息</span></div><label>快递包装<div className="checkbox-grid">{packageOptions.map((item) => <label key={item}><input type="checkbox" checked={packageMaterials.includes(item)} onChange={(event) => setPackageMaterials((current) => event.target.checked ? [...current, item] : current.filter((value) => value !== item))} />{item}</label>)}</div></label><label>SN 分配方式<select value={allocationMode} onChange={(event) => setAllocationMode(event.target.value as typeof allocationMode)}><option value="none">暂不分配</option><option value="random">随机分配可用 SN</option><option value="manual">手动指定 SN</option></select></label>{allocationMode !== 'random' && <label>指定 SN<textarea value={serialText} onChange={(event) => setSerialText(event.target.value)} placeholder="一行一个 SN，可用扫描枪连续录入" /></label>}<label>快递公司<input value={carrier} onChange={(event) => setCarrier(event.target.value)} /></label><label>快递单号<input value={tracking} onChange={(event) => setTracking(event.target.value)} placeholder="可先留空，仓库发货时可补充或核对" /></label><Button onClick={() => void saveFulfillment()}>保存履约安排</Button></section>}{warehouse && canShip && <section className="panel"><div className="panel-title"><h2>确认发货</h2><span>快递单号可为空，产品 SN 必填</span></div><dl className="detail-grid"><dt>收货信息</dt><dd>{data.order.shippingAddress || '—'}</dd><dt>包装材料</dt><dd>{data.order.packageMaterials || '—'}</dd></dl><label>快递公司<input value={carrier} onChange={(event) => setCarrier(event.target.value)} /></label><label>快递单号<input value={tracking} onChange={(event) => setTracking(event.target.value)} placeholder="可扫描或手动填写，非必填" /></label><label>产品 SN<textarea value={serialText} onChange={(event) => setSerialText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') event.stopPropagation(); }} placeholder="一行一个 SN，扫描枪回车会自动换行" /></label><div className="action-list"><Button secondary onClick={useCamera}>使用摄像头扫码</Button><Button onClick={ship}>确认发货</Button></div></section>}{data.shipment && <section className="panel"><div className="panel-title"><h2>物流信息</h2></div><p>{data.shipment.carrier} · {data.shipment.trackingNumber || '未填写运单号'} · {date(data.shipment.shippedAt)}</p></section>}</div>}</Shell>;
}

function OrderPage({ user, route, logout, warehouse = false, orderId }: Props & { warehouse?: boolean; orderId: string }) {
  const [data, setData] = useState<OrderDetail | null>(null);
  const [availableSerialGroups, setAvailableSerialGroups] = useState<AvailableSerialGroup[]>([]);
  const [notice, setNotice] = useState<Notice>(null);
  const [tracking, setTracking] = useState('');
  const [serialText, setSerialText] = useState('');
  const [carrier, setCarrier] = useState('顺丰速运');
  const [allocationMode, setAllocationMode] = useState<'none' | 'random' | 'manual'>('none');
  const [packageMaterials, setPackageMaterials] = useState<string[]>([]);
  const scanner = useMemo(() => new BrowserBarcodeScanner(), []);
  const canReview = user.permissions.includes('order:review');
  const canFulfill = user.permissions.includes('order:fulfill') || canReview;
  const selectedSerials = splitLines(serialText);
  const selectedSet = new Set(selectedSerials.map((item) => item.toUpperCase()));
  const load = useCallback(() => api<OrderDetail>(`/orders/${orderId}`).then((value) => {
    setData(value);
    setTracking(value.order.fulfillmentTrackingNumber || value.shipment?.trackingNumber || '');
    setCarrier(value.order.fulfillmentCarrier || value.shipment?.carrier || '顺丰速运');
    setPackageMaterials((value.order.packageMaterials || '').split('、').filter(Boolean));
    setSerialText(value.serials.map((item) => item.serialNumber).join('\n'));
  }).catch((error) => setNotice({ tone: 'error', text: errorText(error) })), [orderId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!data || !canReview || warehouse || !['approved', 'picking', 'packed'].includes(data.order.status)) {
      setAvailableSerialGroups([]);
      return;
    }
    void api<{ groups: AvailableSerialGroup[] }>(`/orders/${orderId}/available-serials`)
      .then((value) => setAvailableSerialGroups(value.groups))
      .catch((error) => setNotice({ tone: 'error', text: errorText(error) }));
  }, [canReview, data, orderId, warehouse]);
  const action = async (path: string, body?: unknown, success?: string) => {
    try {
      await api(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
      setNotice({ tone: 'success', text: success ?? '操作已完成。' });
      void load();
    } catch (error) {
      setNotice({ tone: 'error', text: errorText(error) });
    }
  };
  const review = async (approved: boolean) => {
    const note = approved ? '' : window.prompt('请填写审核不通过原因，可说明缺货、黑名单用户、禁售地区或其他原因：') ?? '';
    if (!approved && !note.trim()) return;
    await action(`/orders/${orderId}/review`, { approved, note }, approved ? '订单已审核通过，请继续安排 SN 和快递信息。' : '订单已驳回，经销商可修改原订单后重新提交。');
  };
  const toggleSerial = (serialNumber: string, checked: boolean) => {
    setSerialText((current) => {
      const values = splitLines(current);
      if (checked) return Array.from(new Set([...values, serialNumber])).join('\n');
      return values.filter((item) => item.toUpperCase() !== serialNumber.toUpperCase()).join('\n');
    });
  };
  const saveFulfillment = async () => {
    if (allocationMode === 'manual' && !selectedSerials.length) return setNotice({ tone: 'error', text: '请选择要分配的 SN。' });
    await action(`/orders/${orderId}/fulfillment`, { packageMaterials, carrier, trackingNumber: tracking, allocationMode, serialNumbers: allocationMode === 'manual' ? selectedSerials : [] }, '履约安排已保存。');
  };
  const useCamera = async () => {
    try {
      await scanner.start((result) => setSerialText((value) => `${value}${value ? '\n' : ''}${result.value.trim()}`));
    } catch {
      setNotice({ tone: 'error', text: '无法启用摄像头，请改用扫描枪或手动输入。' });
    }
  };
  const ship = async () => {
    if (!selectedSerials.length) return setNotice({ tone: 'error', text: warehouse ? '确认发货前必须录入产品 SN。' : '确认发货前请先选择或分配产品 SN。' });
    if (!window.confirm('确认发货吗？系统会绑定订单、SN 和保修日期。')) return;
    await action(`/orders/${orderId}/ship`, { carrier, trackingNumber: tracking, serialNumbers: selectedSerials }, '订单已确认发货。');
  };
  const canShip = Boolean(data && ['approved', 'picking', 'packed'].includes(data.order.status));
  const serialCountFor = (group: AvailableSerialGroup) => group.serials.filter((item) => selectedSet.has(item.serialNumber.toUpperCase())).length;
  return <Shell user={user} route={route} title={warehouse ? '发货订单' : '订单详情'} subtitle={data?.order.orderNo ?? '正在加载订单'} logout={logout}>
    <Alert notice={notice} />
    {!data ? <p>正在加载…</p> : <div className="order-layout">
      <section className="panel detail-header">
        <div><span className={`status status--${data.order.status}`}>{statusName[data.order.status]}</span><h2>{data.order.orderNo}</h2><p>{data.order.storeName}</p></div>
        <div className="action-list">
          {!warehouse && data.order.status === 'submitted' && <><Button onClick={() => void review(true)}>审核通过</Button><Button secondary onClick={() => void review(false)}>驳回订单</Button></>}
          {!warehouse && ['approved', 'picking', 'packed'].includes(data.order.status) && <Button danger onClick={() => void action(`/orders/${orderId}/cancel`, undefined, '订单已取消，预留库存已释放。')}>取消订单</Button>}
          {canFulfill && canShip && <Button onClick={() => void ship()}>确认发货</Button>}
        </div>
      </section>
      {!warehouse && <section className="panel"><div className="panel-title"><h2>销售信息</h2></div><dl className="detail-grid"><dt>售卖价格</dt><dd>{data.order.salePriceCents === null ? '—' : money(data.order.salePriceCents)}</dd><dt>收货地址</dt><dd>{data.order.shippingAddress || '—'}</dd><dt>用户画像</dt><dd>{data.order.customerProfile || '—'}</dd><dt>经销商备注</dt><dd>{data.order.note || '—'}</dd><dt>审核意见</dt><dd>{data.order.reviewNote || '—'}</dd></dl>{data.order.screenshotDataUrl && <div className="order-screenshot-preview"><span>订单截图</span><img src={data.order.screenshotDataUrl} alt="订单截图" /></div>}</section>}
      <section className="panel"><div className="panel-title"><h2>商品与 SN</h2></div><div className="table-wrap"><table><thead><tr><th>产品</th><th>版本</th><th>SKU / 物料编码</th><th>数量</th>{!warehouse && <th>单价</th>}<th>保修天数</th><th>已绑定 SN</th></tr></thead><tbody>{data.items.map((item) => <tr key={item.id}><td>{item.name}</td><td>{item.productVersion || item.specification || '—'}</td><td>{item.materialCode || item.sku}</td><td>{item.quantity}</td>{!warehouse && <td>{money(item.unitPriceCents)}</td>}<td>{item.warrantyDays ? `${item.warrantyDays} 天` : '待确认'}</td><td>{data.serials.filter((value) => value.productId === item.productId).map((value) => value.serialNumber).join('、') || '—'}</td></tr>)}</tbody></table></div></section>
      {!warehouse && canReview && ['approved', 'picking', 'packed'].includes(data.order.status) && <section className="panel"><div className="panel-title"><h2>履约安排</h2><span>管理员选择 SN、包装和快递信息；随机分配仍由系统按可用库存选择。</span></div><label>快递包装<div className="checkbox-grid">{packageOptions.map((item) => <label key={item}><input type="checkbox" checked={packageMaterials.includes(item)} onChange={(event) => setPackageMaterials((current) => event.target.checked ? [...current, item] : current.filter((value) => value !== item))} />{item}</label>)}</div></label><label>SN 分配方式<select value={allocationMode} onChange={(event) => setAllocationMode(event.target.value as typeof allocationMode)}><option value="none">暂不分配</option><option value="random">随机分配可用 SN</option><option value="manual">手动指定可用 SN</option></select></label>{allocationMode === 'manual' && <section className="panel panel--nested"><h3>选择可用 SN</h3>{availableSerialGroups.map((group) => <div key={group.productId}><p className="hint">{group.productName} / {group.productVersion || group.sku}：需选择 {group.quantity} 个，已选 {serialCountFor(group)} 个。</p><div className="table-wrap"><table><thead><tr><th>选择</th><th>SN</th><th>资产状态</th><th>来源 / 仓库</th><th>备注</th><th>更新时间</th></tr></thead><tbody>{group.serials.map((serial) => <tr key={serial.assetId}><td><input type="checkbox" checked={selectedSet.has(serial.serialNumber.toUpperCase())} onChange={(event) => toggleSerial(serial.serialNumber, event.target.checked)} /></td><td>{serial.serialNumber}{serial.originalSn && serial.originalSn !== serial.serialNumber && <><br /><small>原 SN：{serial.originalSn}</small></>}</td><td>{serial.assetStatus} / {serial.dataQualityStatus}</td><td>{serial.sourceChannel || '—'} / {serial.shippingWarehouse || '—'}</td><td>{serial.assetNote || serial.productNote || '—'}</td><td>{date(serial.updatedAt)}</td></tr>)}</tbody></table>{!group.serials.length && <div className="empty-state"><h2>暂无可用 SN。</h2></div>}</div></div>)}</section>}<label>快递公司<input value={carrier} onChange={(event) => setCarrier(event.target.value)} /></label><label>快递单号<input value={tracking} onChange={(event) => setTracking(event.target.value)} placeholder="可先留空，仓库或管理员确认发货时可补充" /></label><Button onClick={() => void saveFulfillment()}>保存履约安排</Button></section>}
      {canFulfill && canShip && <section className="panel"><div className="panel-title"><h2>确认发货</h2><span>{warehouse ? '快递单号可为空，产品 SN 必填。' : '管理员也可以在审核通过后直接确认发货。'}</span></div><dl className="detail-grid"><dt>收货信息</dt><dd>{data.order.shippingAddress || '—'}</dd><dt>包装材料</dt><dd>{packageMaterials.join('、') || data.order.packageMaterials || '—'}</dd></dl><label>快递公司<input value={carrier} onChange={(event) => setCarrier(event.target.value)} /></label><label>快递单号<input value={tracking} onChange={(event) => setTracking(event.target.value)} placeholder="可扫描或手动填写，非必填" /></label>{warehouse ? <label>产品 SN<textarea value={serialText} onChange={(event) => setSerialText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') event.stopPropagation(); }} placeholder="一行一个 SN，扫描枪回车会自动换行" /></label> : <dl className="detail-grid"><dt>本次发货 SN</dt><dd>{selectedSerials.join('、') || '请先在履约安排中选择或随机分配 SN。'}</dd></dl>}<div className="action-list">{warehouse && <Button secondary onClick={useCamera}>使用摄像头扫码</Button>}<Button onClick={ship}>确认发货</Button></div></section>}
      {data.shipment && <section className="panel"><div className="panel-title"><h2>物流信息</h2></div><p>{data.shipment.carrier} · {data.shipment.trackingNumber || '未填写运单号'} · {date(data.shipment.shippedAt)}</p></section>}
    </div>}
  </Shell>;
}

function Inventory({ user, route, logout }: Props) {
  const warehouse = route.split('?')[0].startsWith('/system/warehouse') && user.permissions.includes('order:fulfill');
  const [data, setData] = useState<InventoryRow[]>([]);
  const load = useCallback(() => { if (warehouse) return api<{ items: InventoryRow[] }>('/inventory').then((value) => setData(value.items)); return api<{ inventory: InventoryRow[] }>('/admin/inventory').then((value) => setData(value.inventory)); }, [warehouse]);
  useEffect(() => { void load(); }, [load]);
  return <Shell user={user} route={route} title={warehouse ? '库存查询' : '产品与库存'} subtitle={warehouse ? '查看可用库存和已预留数量。' : '所有库存变动均保留流水记录。'} logout={logout}><div className="table-wrap"><table><thead><tr><th>SKU</th><th>产品</th><th>可用库存</th><th>已预留</th><th>预警值</th>{!warehouse && <th>操作</th>}</tr></thead><tbody>{data.map((item) => <tr key={item.id}><td>{item.sku}</td><td>{item.name}</td><td>{item.availableQuantity}</td><td>{item.reservedQuantity}</td><td>{item.reorderLevel}</td>{!warehouse && <td><InventoryAdjust id={item.id} onDone={load} /></td>}</tr>)}</tbody></table></div></Shell>;
}
function InventoryAdjust({ id, onDone }: { id: string; onDone: () => void }) { const [open, setOpen] = useState(false); const [quantityDelta, setQuantityDelta] = useState(''); const [note, setNote] = useState(''); const submit = async () => { await api(`/admin/inventory/${id}/adjustments`, { method: 'POST', body: JSON.stringify({ quantityDelta: Number(quantityDelta), note }) }); setOpen(false); onDone(); }; return open ? <span className="inline-actions"><input aria-label="调整数量" value={quantityDelta} onChange={(event) => setQuantityDelta(event.target.value)} /><input aria-label="调整原因" value={note} onChange={(event) => setNote(event.target.value)} /><Button onClick={() => void submit()}>保存</Button></span> : <Button secondary onClick={() => setOpen(true)}>调整库存</Button>; }
function ResourceList({ user, route, logout, title, path, field = 'items' }: Props & { title: string; path: string; field?: string }) { const [rows, setRows] = useState<Record<string, unknown>[]>([]); useEffect(() => { api<Record<string, Record<string, unknown>[]>>(path).then((data) => setRows(data[field] ?? Object.values(data)[0] ?? [])); }, [path, field]); return <Shell user={user} route={route} title={title} subtitle="查看并管理授权范围内的信息。" logout={logout}>{rows.length ? <div className="table-wrap"><table><thead><tr>{Object.keys(rows[0]).slice(0, 6).map((key) => <th key={key}>{key}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={String(row.id ?? index)}>{Object.keys(rows[0]).slice(0, 6).map((key) => <td key={key}>{String(row[key] ?? '—')}</td>)}</tr>)}</tbody></table></div> : <div className="empty-state"><h2>暂无内容。</h2></div>}</Shell>; }
function Notifications({ user, route, logout }: Props) { const [items, setItems] = useState<NotificationRow[]>([]); const load = useCallback(() => api<{ notifications: NotificationRow[] }>('/notifications').then((value) => setItems(value.notifications)), []); useEffect(() => { void load(); }, [load]); const read = async (id: string) => { await api(`/notifications/${id}/read`, { method: 'PATCH' }); void load(); }; return <Shell user={user} route={route} title="站内通知" subtitle="查看订单、库存和售后状态更新。" logout={logout}><div className="action-list"><Button secondary onClick={() => { void api('/notifications/read-all', { method: 'POST' }).then(load); }}>全部标记为已读</Button></div>{items.length ? <div className="table-wrap"><table><thead><tr><th>通知内容</th><th>状态</th><th>时间</th><th>操作</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><strong>{item.title}</strong><br /><small>{item.body}</small></td><td>{item.readAt ? '已读' : '未读'}</td><td>{date(item.createdAt)}</td><td>{item.link && <a href={`#${item.link}`}>查看</a>}{!item.readAt && <Button secondary onClick={() => { void read(item.id); }}>标为已读</Button>}</td></tr>)}</tbody></table></div> : <div className="empty-state"><h2>暂时没有新通知。</h2></div>}</Shell>; }

export function OperationsPortal({ user, route, logout }: Props) {
  const path = route.split('?')[0];
  const warehouse = path.startsWith('/system/warehouse') && user.permissions.includes('order:fulfill');
  const warehouseOnlyUser = user.roles.includes('warehouse_manager') && !hasAdminAccess(user) && !hasDealerAccess(user) && !hasServiceCenterAccess(user);
  if (warehouse || warehouseOnlyUser) {
    const warehouseRoute = warehouse ? route : '/system/warehouse';
    if (path.startsWith('/system/warehouse/order/')) return <OrderPage user={user} route={warehouseRoute} logout={logout} warehouse orderId={path.split('/').at(-1)!} />;
    return <Orders user={user} route={warehouseRoute} logout={logout} warehouse />;
  }
  if (path.startsWith('/system/admin/assets')) return <GsxPortal user={user} route={route} logout={logout} />;
  if (path === '/system/admin/products' || path === '/system/admin/dealers' || path === '/system/admin/stores' || path === '/system/admin/users' || path === '/system/admin/after-sales') return <AdminManagementPortal user={user} route={route} logout={logout} />;
  if (path === '/system/admin/inventory') return <Inventory user={user} route={route} logout={logout} />;
  if (path === '/system/notifications') return <Notifications user={user} route={route} logout={logout} />;
  if (path === '/system/admin') return <AdminDashboard user={user} route={route} logout={logout} />;
  if (path.startsWith('/system/admin/order/')) return <OrderPage user={user} route={route} logout={logout} orderId={path.split('/').at(-1)!} />;
  if (path === '/system/admin/orders') return <Orders user={user} route={route} logout={logout} />;
  if (path === '/system/admin/audit') return <ResourceList user={user} route={route} logout={logout} title="审计记录" path="/admin/audit-logs" field="logs" />;
  return <AdminDashboard user={user} route={route} logout={logout} />;
}
