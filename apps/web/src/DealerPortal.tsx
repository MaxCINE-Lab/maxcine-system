import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import type { OrderStatus, SessionUser } from '@maxcine/shared';
import { api, ApiClientError } from './api';
import { CameraPhotoButton } from './CameraPhotoButton';
import { GsxPortal } from './GsxPortal';
import { AccountMenu, SystemNavigation, captureWatermarkLines, displayRoleText } from './systemNavigation';

type NoticeState = { tone: 'success' | 'error'; text: string } | null;
type Store = { id: string; code: string; name: string };
type InventoryItem = { id: string; productId: string; sku: string; name: string; description: string; productVersion?: string; specification: string; unitPriceCents: number; availableQuantity: number; reservedQuantity: number; reorderLevel: number; updatedAt: string };
type OrderItem = { id: string; productId: string; name: string; sku: string; quantity: number; unitPriceCents: number };
type OrderListItem = { id: string; orderNo: string; storeId: string; storeName: string; status: OrderStatus; totalCents: number; itemCount: number; createdAt: string; updatedAt: string };
type Notification = { id: string; title: string; body: string; type: string; link: string | null; readAt: string | null; createdAt: string };
type AfterSales = { id: string; caseNo: string; orderId: string | null; productName: string | null; serialNumber: string | null; caseType: string; subject: string; status: string; createdAt: string; updatedAt: string };
type AfterSalesAssetSearch = { id: string; currentSn: string | null; originalSn: string | null; productName: string; version: string; sku: string | null; materialCode: string | null; assetStatus: string; updatedAt: string };
type CustomerRiskStatus = 'normal' | 'watchlist' | 'risk' | 'blacklist';
type CustomerRiskLevel = 'low' | 'medium' | 'high';
type CustomerRiskResult = '成交' | '未成交' | '跟进中' | '未知';
type CustomerRiskSummary = { id: string; displayName: string; phone: string; recipientName: string; platformNickname: string; wechatNickname: string; shippingAddress: string; city: string; ipLocation: string; status: CustomerRiskStatus; statusText: string; riskLevel: CustomerRiskLevel; riskLevelText: string; riskReasons: string[]; registrationCount: number; involvedDealerCount: number; consultationCount: number; dealCount: number; noDealCount: number; lastConsultedAt: string | null; updatedAt: string; priority?: number };
type CustomerRiskEvent = { id: string; dealerName: string | null; storeName: string | null; productScope: string; consultationResult: CustomerRiskResult; status: CustomerRiskStatus; statusText: string; riskLevel: CustomerRiskLevel; riskLevelText: string; riskReasons: string[]; otherReason: string; note: string; happenedAt: string; createdAt: string; createdBy: string | null; createdByName: string | null; updatedAt: string; canEdit: boolean };
type CustomerRiskDetail = {
  customer: CustomerRiskSummary & { recipientName: string; qqNickname: string; telegram: string; whatsapp: string; ipLocation: string; note: string; otherReason: string; firstRegisteredAt: string; lastRegisteredAt: string; createdAt: string; createdByName: string | null };
  contacts: Array<{ id: string; contactType: string; contactValue: string; firstSeenAt: string; lastSeenAt: string; createdAt: string }>;
  events: CustomerRiskEvent[];
};
type AfterSalesAssetContext = {
  asset: { id: string; currentSn: string | null; originalSn: string | null; productId: string | null; productName: string; version: string; sku: string | null; materialCode: string | null; assetStatus: string; warrantyStartAt: string | null; warrantyEndAt: string | null; warrantyStatus: string; warrantyOverrideStatus: string | null; warrantyOverrideReason: string; dealerId: string | null; dealerName: string | null; storeId: string | null; storeName: string | null; latestOrderId: string | null; latestOrderNo: string | null; salePriceCents: number | null; screenshotDataUrl: string | null; shippingAddress: string | null; customerProfile: string | null; carrier: string | null; trackingNumber: string | null; shippedAt: string | null };
  identifiers: Array<{ identifierType: string; identifierValue: string; isCurrent: number }>;
  history: Array<{ id: string; caseNo: string; serviceStage: string; status: string; createdAt: string }>;
  openCase: { id: string; caseNo: string } | null;
};

const statusNames: Record<OrderStatus, string> = { draft: '草稿', submitted: '待审核', approved: '审核通过', rejected: '审核未通过', picking: '配货中', packed: '已打包', shipped: '已发货', delivered: '已签收', cancelled: '已取消' };
const afterSalesStatus: Record<string, string> = { open: '待受理', in_progress: '处理中', resolved: '已解决', closed: '已关闭' };
const afterSalesStageNames: Record<string, string> = { PENDING_ADMIN_REVIEW: '待管理员审核', NEEDS_MORE_INFO: '已退回补充', WAITING_CUSTOMER_SHIPMENT: '待客户寄修', WAITING_SERVICE_CENTER_RECEIPT: '待服务中心收货', WAITING_INSPECTION: '待检测', INSPECTION_IN_PROGRESS: '检测中', PENDING_ADMIN_INSPECTION_REVIEW: '待出报价', INSPECTION_RETURNED: '检测结果退回', PENDING_QUOTE: '待出报价', WAITING_CUSTOMER_CONFIRMATION: '等待客户确认', READY_FOR_PROCESSING: '等待维修与发货', WAITING_PAYMENT_CONFIRMATION: '等待确认收款', WAITING_REPAIR_SHIPMENT: '等待维修与发货', RETURN_SHIPPED: '售后已发货', CLOSED: '已关闭' };
const afterSalesCaseTypes = [
  ['OUT_OF_WARRANTY_REPAIR', '保外维修类'],
  ['INSTALLATION_ISSUE', '安装异常类'],
  ['QUALITY_ISSUE', '质量问题类'],
  ['IMAGE_QUALITY_ISSUE', '拍摄效果类'],
  ['MISSING_ACCESSORY', '缺少配件类'],
  ['PART_PURCHASE', '单独购买部件类']
] as const;
const notificationTypes: Record<string, string> = { order_approved: '订单审核结果', order_rejected: '订单审核结果', order_shipped: '订单发货', inventory_alert: '库存提醒', after_sales_updated: '售后状态更新', system: '系统通知' };
const customerProfileOptions = ['事多', '墨迹', '没钱', '多次询问', '多家比价', '高风险', '疑似黑名单用户小号', '博主', '专业摄影师', '公司采购', '小白', '女性用户', '老客户', '老客介绍', '无'];
const riskStatusOptions: Array<[CustomerRiskStatus, string]> = [['normal', '正常'], ['watchlist', '观察名单'], ['risk', '风险客户'], ['blacklist', '共享黑名单']];
const riskLevelOptions: Array<[CustomerRiskLevel, string]> = [['low', '低'], ['medium', '中'], ['high', '高']];
const riskResultOptions: CustomerRiskResult[] = ['未成交', '成交', '跟进中', '未知'];
const riskReasonOptions = ['反复砍价', '乐龄人士', '大量询价未购买', '智力低下', '多家询价砍价', '恶意骚扰', '频繁退款', '辱骂客服', '要求超出售后政策', '反复修改需求', '疑似同行调研', '有骗保记录', '其他'];
const warrantyDaysBySku: Record<string, number> = { W101: 90, W113: 90, W102: 180, W103: 365, W124: 90 };

function money(value: number): string { return `¥${(value / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function dateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const normalized = value.includes('T') || /Z$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', hour12: false }).format(date);
}
function inventoryState(item: InventoryItem): string { if (item.availableQuantity <= 0) return '暂时缺货'; if (item.availableQuantity <= item.reorderLevel) return '库存紧张'; return '库存充足'; }
function friendlyError(error: unknown): string {
  if (!(error instanceof ApiClientError)) return '操作未完成，请稍后重试。';
  if (error.code === 'UNAUTHENTICATED') return '登录状态已失效，请重新登录。';
  if (error.code === 'FORBIDDEN') return '你没有权限执行此操作。';
  return error.message || '操作未完成，请稍后重试。';
}
function go(path: string, message?: string): void { if (message) sessionStorage.setItem('maxcine-flash', message); location.hash = `#${path}`; }

function ActionButton({ children, href, secondary = false, danger = false, disabled = false, onClick, type = 'button' }: { children: ReactNode; href?: string; secondary?: boolean; danger?: boolean; disabled?: boolean; onClick?: () => void; type?: 'button' | 'submit' }) {
  const className = `button ${secondary ? 'button--secondary' : ''} ${danger ? 'button--danger' : ''}`;
  return href ? <a className={className} href={href}>{children}</a> : <button className={className} type={type} disabled={disabled} onClick={onClick}>{children}</button>;
}

function StatusTag({ value }: { value: string }) { return <span className={`status status--${value}`}>{statusNames[value as OrderStatus] ?? afterSalesStatus[value] ?? value}</span>; }
function Empty({ title, text, action }: { title: string; text?: string; action?: ReactNode }) { return <div className="empty-state"><h2>{title}</h2>{text && <p>{text}</p>}{action && <div className="empty-action">{action}</div>}</div>; }
function Loading() { return <div className="loading-state">正在加载…</div>; }
function Alert({ notice }: { notice: NoticeState }) { return notice ? <div className={`portal-alert portal-alert--${notice.tone}`}>{notice.text}</div> : null; }
function Crumbs({ items }: { items: Array<{ label: string; href?: string }> }) { return <nav className="crumbs" aria-label="当前位置">{items.map((item, index) => <span key={`${item.label}-${index}`}>{item.href ? <a href={`#${item.href}`}>{item.label}</a> : item.label}{index < items.length - 1 && <b>›</b>}</span>)}</nav>; }

function DealerShell({ user, route, children, title, subtitle }: { user: SessionUser; route: string; children: ReactNode; title: string; subtitle: string }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  useEffect(() => { api<{ unreadCount: number }>('/notifications?limit=1').then((data) => setUnread(data.unreadCount)).catch(() => undefined); }, [route]);
  const signOut = async () => { try { await api('/auth/logout', { method: 'POST' }); } finally { location.hash = '#/login'; } };
  return <div className="system dealer-system"><header className="system-top"><img className="system-light-logo" src="/assets/maxcine-logo-on-light.png" alt="MaxCINE" /><button className="menu-toggle" onClick={() => setMenuOpen(!menuOpen)} aria-expanded={menuOpen}>菜单</button><a className="global-search" href="#/system/orders" aria-label="打开订单查询">搜索订单或产品</a><a className="top-notifications" href="#/system/notifications" aria-label="查看站内通知">通知{unread > 0 && <em>{unread > 99 ? '99+' : unread}</em>}</a><AccountMenu user={user} logout={() => void signOut()} /></header><aside className={`system-nav ${menuOpen ? 'is-open' : ''}`}><img className="system-dark-logo" src="/assets/maxcine-logo-on-dark.png" alt="MaxCINE" /><SystemNavigation user={user} route={route} onNavigate={() => setMenuOpen(false)} /></aside><main className="system-main"><header className="page-title"><div><span className="eyebrow">MAXCINE / {displayRoleText(user)}</span><h1>{title}</h1><p>{subtitle}</p></div></header>{children}</main></div>;
}

function Dashboard({ user, route }: { user: SessionUser; route: string }) {
  const [data, setData] = useState<{ summary: { draftOrders: number; submittedOrders: number; inventoryAlerts: number }; notifications: Notification[] } | null>(null);
  const [notice, setNotice] = useState<NoticeState>(null);
  useEffect(() => { api<{ summary: { draftOrders: number; submittedOrders: number; inventoryAlerts: number }; notifications: Notification[] }>('/dealer/dashboard').then(setData).catch((error) => setNotice({ tone: 'error', text: friendlyError(error) })); }, []);
  return <DealerShell user={user} route={route} title="仪表盘" subtitle="查看订单、库存和售后事项。"><Alert notice={notice} />{!data ? <Loading /> : <><section className="stats dealer-stats"><a href="#/system/orders?status=draft" className="stat"><p>待提交订单</p><strong>{data.summary.draftOrders}</strong><span>草稿订单</span></a><a href="#/system/orders?status=submitted" className="stat"><p>待审核订单</p><strong>{data.summary.submittedOrders}</strong><span>等待审核</span></a><a href="#/system/inventory?state=alert" className="stat"><p>库存提醒</p><strong>{data.summary.inventoryAlerts}</strong><span>库存紧张或缺货</span></a></section><section className="dashboard-grid"><section className="panel"><div className="panel-title"><h2>需要关注</h2><a href="#/system/notifications">查看全部 ›</a></div>{data.notifications.length ? <ul className="timeline">{data.notifications.map((item) => <li key={item.id}><i className={item.readAt ? '' : 'timeline-dot--new'} /><a href={item.link ? `#${item.link}` : '#/system/notifications'}><strong>{item.title}</strong><span>{item.body}</span><small>{dateTime(item.createdAt)}</small></a></li>)}</ul> : <Empty title="暂时没有需要关注的事项。" />}</section><section className="panel"><div className="panel-title"><h2>快捷操作</h2></div><div className="action-list"><ActionButton href="#/system/new-order">新建订单</ActionButton><ActionButton secondary href="#/system/orders">查看订单</ActionButton><ActionButton secondary href="#/system/notifications">查看通知</ActionButton><ActionButton secondary href="#/system/after-sales/new">新建售后工单</ActionButton></div></section></section></>}</DealerShell>;
}

function Inventory({ user, route }: { user: SessionUser; route: string }) {
  const [items, setItems] = useState<InventoryItem[]>([]); const [loading, setLoading] = useState(true); const [query, setQuery] = useState(''); const [state, setState] = useState(new URLSearchParams(route.split('?')[1] ?? '').get('state') ?? 'all'); const [selected, setSelected] = useState<InventoryItem | null>(null); const [notice, setNotice] = useState<NoticeState>(null);
  useEffect(() => { setLoading(true); api<{ items: InventoryItem[] }>(`/inventory?search=${encodeURIComponent(query)}`).then((data) => setItems(data.items)).catch((error) => setNotice({ tone: 'error', text: friendlyError(error) })).finally(() => setLoading(false)); }, [query]);
  const filtered = items.filter((item) => state === 'all' || (state === 'alert' ? inventoryState(item) !== '库存充足' : inventoryState(item) === state));
  return <DealerShell user={user} route={route} title="共享库存" subtitle="查看当前可订购产品及库存情况。"><Alert notice={notice} /><section className="portal-toolbar"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索产品名称或 SKU" /><div className="filter-row">{['all', '库存充足', '库存紧张', '暂时缺货'].map((value) => <button key={value} className={`filter ${state === value ? 'active' : ''}`} onClick={() => setState(value)}>{value === 'all' ? '全部' : value}</button>)}</div></section>{loading ? <Loading /> : <div className="portal-split"><div className="table-wrap"><table><thead><tr><th>产品名称</th><th>SKU</th><th>产品规格</th><th>可用库存</th><th>已预留</th><th>库存状态</th><th>更新时间</th></tr></thead><tbody>{filtered.map((item) => <tr key={item.id} className="clickable-row" onClick={() => setSelected(item)}><td><strong>{item.name}</strong></td><td>{item.sku}</td><td>{item.specification || '—'}</td><td>{item.availableQuantity}</td><td>{item.reservedQuantity}</td><td><span className={`inventory-tag inventory-tag--${inventoryState(item)}`}>{inventoryState(item)}</span></td><td>{dateTime(item.updatedAt)}</td></tr>)}</tbody></table>{!filtered.length && <Empty title="未找到符合条件的产品。" />}</div>{selected && <aside className="detail-panel"><button className="panel-close" onClick={() => setSelected(null)} aria-label="关闭">×</button><span className="eyebrow">产品库存</span><h2>{selected.name}</h2><dl><dt>SKU</dt><dd>{selected.sku}</dd><dt>产品规格</dt><dd>{selected.specification || '—'}</dd><dt>经销商价格</dt><dd>{money(selected.unitPriceCents)}</dd><dt>可用库存</dt><dd>{selected.availableQuantity}</dd><dt>已预留</dt><dd>{selected.reservedQuantity}</dd><dt>更新时间</dt><dd>{dateTime(selected.updatedAt)}</dd></dl><p>{selected.description}</p></aside>}</div>}</DealerShell>;
}

type CustomerRiskDraft = {
  customerId: string;
  name: string;
  phone: string;
  recipientName: string;
  platformNickname: string;
  wechatNickname: string;
  qqNickname: string;
  telegram: string;
  whatsapp: string;
  shippingAddress: string;
  city: string;
  ipLocation: string;
  keyword: string;
  customerNote: string;
  status: CustomerRiskStatus;
  riskLevel: CustomerRiskLevel;
  riskReasons: string[];
  otherReason: string;
  consultationResult: CustomerRiskResult;
  happenedAt: string;
  note: string;
};

const emptyRiskDraft = (): CustomerRiskDraft => ({
  customerId: '',
  name: '',
  phone: '',
  recipientName: '',
  platformNickname: '',
  wechatNickname: '',
  qqNickname: '',
  telegram: '',
  whatsapp: '',
  shippingAddress: '',
  city: '',
  ipLocation: '',
  keyword: '',
  customerNote: '',
  status: 'watchlist',
  riskLevel: 'medium',
  riskReasons: [],
  otherReason: '',
  consultationResult: '未成交',
  happenedAt: new Date().toISOString().slice(0, 10),
  note: ''
});

function platformNicknameWithPrefix(prefix: string, value: string): string {
  const next = value.trim();
  if (!next) return '';
  if (!prefix || next.toLowerCase().startsWith(prefix.toLowerCase())) return next;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{2,79}$/.test(next)) return next;
  return `${prefix}${next}`;
}

function riskResultLabel(value: CustomerRiskResult): string {
  return ({ '成交': '已成交', '未成交': '未成交', '跟进中': '待跟进', '未知': '无效咨询' } as Record<CustomerRiskResult, string>)[value];
}

function CustomerRiskCenter({ user, route }: { user: SessionUser; route: string }) {
  const isManager = user.permissions.includes('customer-risk:manage') || user.permissions.includes('data:read:all');
  const [mode, setMode] = useState<'search' | 'create'>('search');
  const [searchInput, setSearchInput] = useState('');
  const [hasSearched, setHasSearched] = useState(false);
  const [items, setItems] = useState<CustomerRiskSummary[]>([]);
  const [detail, setDetail] = useState<CustomerRiskDetail | null>(null);
  const [notice, setNotice] = useState<NoticeState>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [blacklistDraft, setBlacklistDraft] = useState(() => emptyRiskDraft());
  const [nicknamePrefix, setNicknamePrefix] = useState('tbNick_');
  const [newEventOpen, setNewEventOpen] = useState(false);
  const [eventDraft, setEventDraft] = useState(() => emptyRiskDraft());
  const [profileEdit, setProfileEdit] = useState<CustomerRiskDraft | null>(null);
  const [editingEvent, setEditingEvent] = useState<(CustomerRiskEvent & { happenedDate: string }) | null>(null);
  const [blacklistRiskLevel, setBlacklistRiskLevel] = useState<CustomerRiskLevel>('medium');
  const [blacklistReasons, setBlacklistReasons] = useState<string[]>([]);
  const [blacklistOtherReason, setBlacklistOtherReason] = useState('');
  const [blacklistNote, setBlacklistNote] = useState('');
  const [blacklistEventNote, setBlacklistEventNote] = useState('');

  const tbNickSuggestion = useMemo(() => {
    const value = searchInput.trim();
    if (!value || value.toLowerCase().startsWith('tbnick_')) return '';
    return !/^\d+$/.test(value) && /^[A-Za-z0-9][A-Za-z0-9_.-]{2,40}$/.test(value) ? `tbNick_${value}` : '';
  }, [searchInput]);

  const displayTitle = (customer: CustomerRiskDetail['customer'] | CustomerRiskSummary) => customer.platformNickname || customer.displayName || customer.recipientName || customer.phone || '未命名客户';
  const phoneTail = (phone: string) => phone ? `****${phone.replace(/\D/g, '').slice(-4)}` : '';
  const addressSummary = (address: string) => address.length > 28 ? `${address.slice(0, 28)}…` : address;
  const toggleDraftReason = (reason: string, checked: boolean) => setEventDraft((current) => ({ ...current, riskReasons: checked ? Array.from(new Set([...current.riskReasons, reason])) : current.riskReasons.filter((item) => item !== reason) }));
  const toggleBlacklistReason = (reason: string, checked: boolean) => setBlacklistReasons((current) => checked ? Array.from(new Set([...current, reason])) : current.filter((item) => item !== reason));
  const toggleEditReason = (reason: string, checked: boolean) => setEditingEvent((current) => current ? { ...current, riskReasons: checked ? Array.from(new Set([...current.riskReasons, reason])) : current.riskReasons.filter((item) => item !== reason) } : current);

  const fetchMatches = async (value: string) => {
    const query = value.trim();
    if (!query) return [] as CustomerRiskSummary[];
    const data = await api<{ items: CustomerRiskSummary[] }>(`/customer-risk?q=${encodeURIComponent(query)}&limit=20`);
    return data.items;
  };
  const resetCreateState = () => {
    setBlacklistDraft(emptyRiskDraft());
    setBlacklistRiskLevel('medium');
    setBlacklistReasons([]);
    setBlacklistOtherReason('');
    setBlacklistNote('');
    setBlacklistEventNote('');
  };
  const loadDetail = async (customerId: string, openEvent = false) => {
    const data = await api<CustomerRiskDetail>(`/customer-risk/${customerId}`);
    setDetail(data);
    setItems([]);
    setHasSearched(true);
    setNewEventOpen(openEvent);
    setEditingEvent(null);
    setProfileEdit(null);
    setEventDraft({
      ...emptyRiskDraft(),
      customerId: data.customer.id,
      status: data.customer.status,
      riskLevel: data.customer.riskLevel,
      riskReasons: []
    });
  };
  const runSearch = async (value = searchInput) => {
    const query = value.trim();
    if (!query) return setNotice({ tone: 'error', text: '请输入平台昵称、手机号、姓名、地址或 IP 所属地。' });
    setLoading(true); setNotice(null); setHasSearched(true); setDetail(null); setItems([]);
    try {
      const matches = await fetchMatches(query);
      setItems(matches);
      if (matches.length === 1) await loadDetail(matches[0].id);
      else if (!matches.length) setNotice({ tone: 'success', text: '未找到匹配的客户风险档案。' });
    } catch (error) { setNotice({ tone: 'error', text: friendlyError(error) }); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (mode !== 'search' || event.key !== 'Enter' || !(target instanceof HTMLInputElement) || target.placeholder !== '输入平台昵称、手机号、姓名、地址、IP 所属地等任意信息') return;
      event.preventDefault();
      void runSearch();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, searchInput]);
  const saveBlacklist = async () => {
    const platformNickname = platformNicknameWithPrefix(nicknamePrefix, blacklistDraft.platformNickname);
    const payloadCustomer = {
      name: blacklistDraft.name,
      phone: blacklistDraft.phone,
      recipientName: blacklistDraft.recipientName || blacklistDraft.name,
      platformNickname,
      wechatNickname: blacklistDraft.wechatNickname,
      qqNickname: '',
      telegram: '',
      whatsapp: '',
      shippingAddress: blacklistDraft.shippingAddress,
      city: blacklistDraft.city,
      ipLocation: blacklistDraft.ipLocation,
      keyword: blacklistDraft.keyword,
      note: blacklistNote
    };
    const hasIdentity = [payloadCustomer.platformNickname, payloadCustomer.phone, payloadCustomer.name, payloadCustomer.shippingAddress, payloadCustomer.ipLocation].some((value) => value.trim());
    if (!hasIdentity) return setNotice({ tone: 'error', text: '请至少填写平台昵称、手机号、姓名、地址或 IP 信息中的一项。' });
    if (blacklistReasons.includes('其他') && !blacklistOtherReason.trim()) return setNotice({ tone: 'error', text: '选择“其他”风险原因时，请填写其他原因说明。' });
    setSaving(true); setNotice(null);
    try {
      const result = await api<{ customerId: string; eventId: string; merged: boolean }>('/customer-risk', { method: 'POST', body: JSON.stringify({
        customer: payloadCustomer,
        status: 'blacklist',
        riskLevel: blacklistRiskLevel,
        riskReasons: blacklistReasons,
        otherReason: blacklistOtherReason,
        consultationResult: '未成交',
        productScope: 'MAVIC_4_PRO_ANAMORPHIC',
        note: blacklistEventNote
      }) });
      setNotice({ tone: 'success', text: result.merged ? '已追加到现有客户档案。' : '已创建共享黑名单档案。' });
      setMode('search');
      resetCreateState();
      await loadDetail(result.customerId);
    } catch (error) { setNotice({ tone: 'error', text: friendlyError(error) }); }
    finally { setSaving(false); }
  };
  const saveConsultation = async () => {
    if (!detail) return;
    if (!eventDraft.riskReasons.length) return setNotice({ tone: 'error', text: '请选择至少一个风险原因。' });
    if (eventDraft.riskReasons.includes('其他') && !eventDraft.otherReason.trim()) return setNotice({ tone: 'error', text: '选择“其他”风险原因时，请填写其他原因说明。' });
    setSaving(true); setNotice(null);
    try {
      await api('/customer-risk', { method: 'POST', body: JSON.stringify({
        customerId: detail.customer.id,
        customer: {},
        status: detail.customer.status,
        riskLevel: detail.customer.riskLevel,
        riskReasons: eventDraft.riskReasons,
        otherReason: eventDraft.otherReason,
        consultationResult: eventDraft.consultationResult,
        productScope: 'MAVIC_4_PRO_ANAMORPHIC',
        note: eventDraft.note
      }) });
      setNotice({ tone: 'success', text: '已新增咨询记录。' });
      await loadDetail(detail.customer.id);
    } catch (error) { setNotice({ tone: 'error', text: friendlyError(error) }); }
    finally { setSaving(false); }
  };
  const startProfileEdit = () => {
    if (!detail) return;
    setProfileEdit({
      ...emptyRiskDraft(),
      customerId: detail.customer.id,
      name: detail.customer.displayName,
      phone: detail.customer.phone,
      recipientName: detail.customer.recipientName,
      platformNickname: detail.customer.platformNickname,
      wechatNickname: detail.customer.wechatNickname,
      qqNickname: detail.customer.qqNickname,
      telegram: detail.customer.telegram,
      whatsapp: detail.customer.whatsapp,
      shippingAddress: detail.customer.shippingAddress,
      city: detail.customer.city,
      ipLocation: detail.customer.ipLocation,
      customerNote: detail.customer.note,
      status: detail.customer.status,
      riskLevel: detail.customer.riskLevel,
      riskReasons: detail.customer.riskReasons,
      otherReason: detail.customer.otherReason
    });
  };
  const saveProfileEdit = async () => {
    if (!detail || !profileEdit) return;
    setSaving(true); setNotice(null);
    try {
      await api(`/customer-risk/${detail.customer.id}`, { method: 'PATCH', body: JSON.stringify({
        customer: {
          name: profileEdit.name,
          phone: profileEdit.phone,
          recipientName: profileEdit.recipientName,
          platformNickname: profileEdit.platformNickname,
          wechatNickname: profileEdit.wechatNickname,
          qqNickname: profileEdit.qqNickname,
          telegram: profileEdit.telegram,
          whatsapp: profileEdit.whatsapp,
          shippingAddress: profileEdit.shippingAddress,
          city: profileEdit.city,
          ipLocation: profileEdit.ipLocation,
          note: profileEdit.customerNote
        },
        status: profileEdit.status,
        riskLevel: profileEdit.riskLevel,
        riskReasons: profileEdit.riskReasons,
        otherReason: profileEdit.otherReason
      }) });
      setNotice({ tone: 'success', text: '客户档案已更新。' });
      await loadDetail(detail.customer.id);
    } catch (error) { setNotice({ tone: 'error', text: friendlyError(error) }); }
    finally { setSaving(false); }
  };
  const saveEventEdit = async () => {
    if (!editingEvent || !detail) return;
    setSaving(true); setNotice(null);
    try {
      await api(`/customer-risk/events/${editingEvent.id}`, { method: 'PATCH', body: JSON.stringify({
        status: editingEvent.status,
        riskLevel: editingEvent.riskLevel,
        riskReasons: editingEvent.riskReasons,
        otherReason: editingEvent.otherReason,
        consultationResult: editingEvent.consultationResult,
        happenedAt: editingEvent.happenedDate,
        note: editingEvent.note
      }) });
      setNotice({ tone: 'success', text: '咨询记录已更新。' });
      await loadDetail(detail.customer.id);
    } catch (error) { setNotice({ tone: 'error', text: friendlyError(error) }); }
    finally { setSaving(false); }
  };
  const deleteEvent = async (eventId: string) => {
    if (!detail || !window.confirm('确认删除这条错误咨询记录吗？')) return;
    setSaving(true); setNotice(null);
    try {
      await api(`/customer-risk/events/${eventId}`, { method: 'DELETE' });
      setNotice({ tone: 'success', text: '咨询记录已删除。' });
      await loadDetail(detail.customer.id);
    } catch (error) { setNotice({ tone: 'error', text: friendlyError(error) }); }
    finally { setSaving(false); }
  };
  const infoRows = detail ? [
    ['平台昵称', detail.customer.platformNickname],
    ['手机号', detail.customer.phone],
    ['姓名', detail.customer.displayName],
    ['收件人', detail.customer.recipientName],
    ['地址', detail.customer.shippingAddress],
    ['微信昵称', detail.customer.wechatNickname],
    ['IP 信息', detail.customer.ipLocation],
    ['首次登记', dateTime(detail.customer.firstRegisteredAt)],
    ['最后更新', dateTime(detail.customer.updatedAt)],
    ['登记人', detail.customer.createdByName || ''],
    ['涉及经销商', String(detail.customer.involvedDealerCount)],
    ['咨询次数', String(detail.customer.consultationCount)],
    ['成交次数', String(detail.customer.dealCount)],
    ['未成交次数', String(detail.customer.noDealCount)]
  ].filter(([, value]) => value && value !== '0') : [];

  return <DealerShell user={user} route={route} title="Customer Risk Center" subtitle="当前仅适用于 MaxCINE Mavic 4 Pro 增广镜。">
    <Alert notice={notice} />
    <section className="panel risk-home">
      <div className="risk-mode-switch" role="tablist" aria-label="客户风控操作">
        <button className={mode === 'search' ? 'is-active' : ''} onClick={() => { setMode('search'); setNotice(null); }}>模糊查询</button>
        <button className={mode === 'create' ? 'is-active' : ''} onClick={() => { resetCreateState(); setDetail(null); setItems([]); setHasSearched(false); setMode('create'); setNotice(null); }}>新建黑名单</button>
      </div>
      {mode === 'search' ? <div className="risk-spotlight">
        <h2>快速查询客户风险</h2>
        <p>输入平台昵称、手机号、姓名、收件人、地址、微信昵称或 IP 所属地等任意信息。</p>
        <form onSubmit={(event) => { event.preventDefault(); void runSearch(); }}>
          <input autoFocus value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="输入平台昵称、手机号、姓名、地址、IP 所属地等任意信息" />
          <ActionButton type="submit" disabled={loading}>{loading ? '查询中…' : '查询'}</ActionButton>
        </form>
        {tbNickSuggestion && <button className="risk-suggestion" onClick={() => { setSearchInput(tbNickSuggestion); void runSearch(tbNickSuggestion); }}>使用 {tbNickSuggestion} 查询</button>}
      </div> : <div className="risk-spotlight risk-manual-create">
        <h2>新建共享黑名单</h2>
        <p>人工填写已知身份信息即可；平台昵称、手机号、姓名、地址、IP 信息任意一项有值即可创建。</p>
        <div className="form-layout">
          <label>平台昵称<div className="risk-prefix-row"><select value={nicknamePrefix} onChange={(event) => setNicknamePrefix(event.target.value)}><option value="tbNick_">tbNick_ 快捷</option><option value="">无前缀</option></select><input autoFocus value={blacklistDraft.platformNickname} onChange={(event) => setBlacklistDraft({ ...blacklistDraft, platformNickname: event.target.value })} placeholder="例如 91xpa 或 tbNick_91xpa" /></div></label>
          <label>手机号<input value={blacklistDraft.phone} onChange={(event) => setBlacklistDraft({ ...blacklistDraft, phone: event.target.value })} placeholder="可选" /></label>
          <label>姓名<input value={blacklistDraft.name} onChange={(event) => setBlacklistDraft({ ...blacklistDraft, name: event.target.value, recipientName: event.target.value })} placeholder="可选" /></label>
          <label>IP 所属地<input value={blacklistDraft.ipLocation} onChange={(event) => setBlacklistDraft({ ...blacklistDraft, ipLocation: event.target.value })} placeholder="例如 广东省" /></label>
        </div>
        <label>地址<textarea value={blacklistDraft.shippingAddress} onChange={(event) => setBlacklistDraft({ ...blacklistDraft, shippingAddress: event.target.value })} placeholder="可选填写收货地址或地址片段" /></label>
        <div className="form-layout"><label>风险等级<select value={blacklistRiskLevel} onChange={(event) => setBlacklistRiskLevel(event.target.value as CustomerRiskLevel)}>{riskLevelOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
        <div><span className="form-label">风险原因</span><div className="checkbox-grid">{riskReasonOptions.map((reason) => <label key={reason}><input type="checkbox" checked={blacklistReasons.includes(reason)} onChange={(event) => toggleBlacklistReason(reason, event.target.checked)} />{reason}</label>)}</div></div>
        {blacklistReasons.includes('其他') && <label>其他原因说明<input value={blacklistOtherReason} onChange={(event) => setBlacklistOtherReason(event.target.value)} placeholder="请填写其他风险原因" /></label>}
        <label>管理员备注<textarea value={blacklistNote} onChange={(event) => setBlacklistNote(event.target.value)} placeholder="可选" /></label>
        <div className="sticky-action"><span>状态固定为共享黑名单；创建后可继续编辑档案完善资料。</span><ActionButton disabled={saving} onClick={() => void saveBlacklist()}>{saving ? '创建中…' : '创建黑名单档案'}</ActionButton></div>
      </div>}
    </section>

    {mode === 'search' && hasSearched && !detail && items.length > 1 && <section className="panel risk-results"><div className="panel-title"><h2>可能匹配的客户</h2><span>{items.length} 条</span></div><div className="risk-result-list">{items.map((item) => <button key={item.id} onClick={() => void loadDetail(item.id)}><strong>{displayTitle(item)}</strong><span>{item.displayName || item.recipientName || '未填写姓名'} · {phoneTail(item.phone) || '无手机号'}</span><small>{addressSummary(item.shippingAddress || item.city || '') || '暂无地址'} {item.ipLocation ? `· IP ${item.ipLocation}` : ''}</small><em>{item.statusText} · 最近 {dateTime(item.lastConsultedAt)}</em></button>)}</div></section>}
    {mode === 'search' && hasSearched && !detail && !items.length && <Empty title="未找到匹配的客户风险档案。" text="如确认该客户存在风险，可切换到“新建黑名单”登记。" />}

    {detail && <section className="risk-profile">
      <article className="panel risk-profile-card"><div className="risk-profile-head"><div><h2>{displayTitle(detail.customer)}</h2><p>{detail.customer.statusText} · 风险等级：{detail.customer.riskLevelText}</p></div>{isManager && <ActionButton secondary onClick={startProfileEdit}>编辑档案</ActionButton>}</div><div className="risk-info-grid">{infoRows.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div></article>

      {profileEdit && isManager && <section className="panel risk-edit-panel"><div className="panel-title"><h2>编辑客户档案</h2><button className="table-action" onClick={() => setProfileEdit(null)}>取消</button></div><div className="form-layout"><label>平台昵称<input value={profileEdit.platformNickname} onChange={(event) => setProfileEdit({ ...profileEdit, platformNickname: event.target.value })} /></label><label>手机号<input value={profileEdit.phone} onChange={(event) => setProfileEdit({ ...profileEdit, phone: event.target.value })} /></label><label>姓名<input value={profileEdit.name} onChange={(event) => setProfileEdit({ ...profileEdit, name: event.target.value })} /></label><label>收件人<input value={profileEdit.recipientName} onChange={(event) => setProfileEdit({ ...profileEdit, recipientName: event.target.value })} /></label><label>微信昵称<input value={profileEdit.wechatNickname} onChange={(event) => setProfileEdit({ ...profileEdit, wechatNickname: event.target.value })} /></label><label>IP 信息<input value={profileEdit.ipLocation} onChange={(event) => setProfileEdit({ ...profileEdit, ipLocation: event.target.value })} /></label><label>状态<select value={profileEdit.status} onChange={(event) => setProfileEdit({ ...profileEdit, status: event.target.value as CustomerRiskStatus })}>{riskStatusOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>风险等级<select value={profileEdit.riskLevel} onChange={(event) => setProfileEdit({ ...profileEdit, riskLevel: event.target.value as CustomerRiskLevel })}>{riskLevelOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div><label>地址<textarea value={profileEdit.shippingAddress} onChange={(event) => setProfileEdit({ ...profileEdit, shippingAddress: event.target.value })} /></label><label>管理员备注<textarea value={profileEdit.customerNote} onChange={(event) => setProfileEdit({ ...profileEdit, customerNote: event.target.value })} /></label><div><span className="form-label">风险原因</span><div className="checkbox-grid">{riskReasonOptions.map((reason) => <label key={reason}><input type="checkbox" checked={profileEdit.riskReasons.includes(reason)} onChange={(event) => setProfileEdit({ ...profileEdit, riskReasons: event.target.checked ? Array.from(new Set([...profileEdit.riskReasons, reason])) : profileEdit.riskReasons.filter((item) => item !== reason) })} />{reason}</label>)}</div></div>{profileEdit.riskReasons.includes('其他') && <label>其他原因说明<input value={profileEdit.otherReason} onChange={(event) => setProfileEdit({ ...profileEdit, otherReason: event.target.value })} placeholder="请填写其他风险原因" /></label>}<div className="action-list"><ActionButton disabled={saving} onClick={() => void saveProfileEdit()}>{saving ? '保存中…' : '保存档案'}</ActionButton></div></section>}

      <section className="panel risk-section"><h3>风险原因</h3><div className="risk-tags">{detail.customer.riskReasons.length ? detail.customer.riskReasons.map((reason) => <span key={reason}>{reason}</span>) : <small>暂无风险原因</small>}</div></section>
      {detail.customer.note && <section className="panel risk-section"><h3>管理员备注</h3><p>{detail.customer.note}</p></section>}
      <section className="panel risk-section"><div className="panel-title"><h2>咨询历史</h2><span>{detail.events.length} 条</span></div><ul className="risk-timeline">{detail.events.map((event) => <li key={event.id}><time>{dateTime(event.happenedAt)}</time><div><strong>{event.dealerName || event.storeName || '官方'} · {event.createdByName || '—'} · {riskResultLabel(event.consultationResult)}</strong><p>{event.riskReasons.join('、') || '无风险原因'}{event.otherReason ? `；${event.otherReason}` : ''}</p>{event.note && <small>{event.note}</small>}{isManager && <div className="inline-actions"><button className="table-action" onClick={() => setEditingEvent({ ...event, happenedDate: event.happenedAt.slice(0, 10) })}>编辑</button><button className="table-action table-action--danger" onClick={() => void deleteEvent(event.id)}>删除</button></div>}</div></li>)}</ul></section>
      {editingEvent && isManager && <section className="panel risk-edit-panel"><div className="panel-title"><h2>编辑咨询记录</h2><button className="table-action" onClick={() => setEditingEvent(null)}>取消</button></div><div className="form-layout"><label>咨询结果<select value={editingEvent.consultationResult} onChange={(event) => setEditingEvent({ ...editingEvent, consultationResult: event.target.value as CustomerRiskResult })}>{riskResultOptions.map((value) => <option key={value} value={value}>{riskResultLabel(value)}</option>)}</select></label><label>咨询日期<input type="date" value={editingEvent.happenedDate} onChange={(event) => setEditingEvent({ ...editingEvent, happenedDate: event.target.value })} /></label></div><div><span className="form-label">风险原因</span><div className="checkbox-grid">{riskReasonOptions.map((reason) => <label key={reason}><input type="checkbox" checked={editingEvent.riskReasons.includes(reason)} onChange={(event) => toggleEditReason(reason, event.target.checked)} />{reason}</label>)}</div></div>{editingEvent.riskReasons.includes('其他') && <label>其他原因说明<input value={editingEvent.otherReason} onChange={(event) => setEditingEvent({ ...editingEvent, otherReason: event.target.value })} placeholder="请填写其他风险原因" /></label>}<label>咨询备注<textarea value={editingEvent.note} onChange={(event) => setEditingEvent({ ...editingEvent, note: event.target.value })} /></label><ActionButton disabled={saving} onClick={() => void saveEventEdit()}>{saving ? '保存中…' : '保存记录'}</ActionButton></section>}
      <section className="panel risk-section"><div className="panel-title"><h2>新增咨询记录</h2>{!newEventOpen && <button className="table-action" onClick={() => setNewEventOpen(true)}>新增</button>}</div>{newEventOpen ? <div className="risk-compact-form"><label>咨询结果<select value={eventDraft.consultationResult} onChange={(event) => setEventDraft({ ...eventDraft, consultationResult: event.target.value as CustomerRiskResult })}>{riskResultOptions.map((value) => <option key={value} value={value}>{riskResultLabel(value)}</option>)}</select></label><div><span className="form-label">风险原因</span><div className="checkbox-grid">{riskReasonOptions.map((reason) => <label key={reason}><input type="checkbox" checked={eventDraft.riskReasons.includes(reason)} onChange={(event) => toggleDraftReason(reason, event.target.checked)} />{reason}</label>)}</div></div>{eventDraft.riskReasons.includes('其他') && <label>其他原因说明<input value={eventDraft.otherReason} onChange={(event) => setEventDraft({ ...eventDraft, otherReason: event.target.value })} placeholder="请填写其他风险原因" /></label>}<label>本次咨询备注<textarea value={eventDraft.note} onChange={(event) => setEventDraft({ ...eventDraft, note: event.target.value })} placeholder="记录本次咨询的关键情况" /></label><div className="action-list"><ActionButton disabled={saving} onClick={() => void saveConsultation()}>{saving ? '保存中…' : '保存咨询记录'}</ActionButton><ActionButton secondary onClick={() => setNewEventOpen(false)}>取消</ActionButton></div></div> : <p className="soft-text">只记录本次咨询结果、风险原因和备注，不重复填写客户身份信息。</p>}</section>
    </section>}

  </DealerShell>;
}

function OrderForm({ user, route, editId }: { user: SessionUser; route: string; editId?: string }) {
  const [stores, setStores] = useState<Store[]>([]); const [products, setProducts] = useState<InventoryItem[]>([]); const [storeId, setStoreId] = useState(''); const [note, setNote] = useState(''); const [salePrice, setSalePrice] = useState(''); const [shippingAddress, setShippingAddress] = useState(''); const [customerProfile, setCustomerProfile] = useState(''); const [screenshotDataUrl, setScreenshotDataUrl] = useState(''); const [cart, setCart] = useState<Record<string, number>>({}); const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [notice, setNotice] = useState<NoticeState>(null);
  useEffect(() => { Promise.all([api<{ stores: Store[] }>('/stores'), api<{ items: InventoryItem[] }>('/inventory')]).then(([storeData, inventoryData]) => { setStores(storeData.stores); setProducts(inventoryData.items); if (!editId && storeData.stores[0]) setStoreId(storeData.stores[0].id); }).catch((error) => setNotice({ tone: 'error', text: friendlyError(error) })).finally(() => setLoading(false)); }, [editId]);
  useEffect(() => { if (!editId) return; api<{ order: { storeId: string; note: string; salePriceCents: number | null; shippingAddress: string; customerProfile: string; screenshotDataUrl: string }; items: OrderItem[] }>(`/orders/${editId}`).then((data) => { setStoreId(data.order.storeId); setNote(data.order.note); setSalePrice(data.order.salePriceCents === null ? '' : String(data.order.salePriceCents / 100)); setShippingAddress(data.order.shippingAddress); setCustomerProfile(data.order.customerProfile); setScreenshotDataUrl(data.order.screenshotDataUrl); setCart(Object.fromEntries(data.items.map((item) => [item.productId, item.quantity]))); }).catch((error) => setNotice({ tone: 'error', text: friendlyError(error) })); }, [editId]);
  const lines = products.filter((product) => cart[product.productId]).map((product) => ({ product, quantity: cart[product.productId] }));
  const totalQuantity = lines.reduce((sum, line) => sum + line.quantity, 0); const total = lines.reduce((sum, line) => sum + line.quantity * line.product.unitPriceCents, 0);
  const selectedProfiles = customerProfile.split('、').filter(Boolean);
  const toggleProfile = (value: string) => setCustomerProfile((current) => { const values = current.split('、').filter(Boolean); const next = value === '无' ? ['无'] : values.includes(value) ? values.filter((item) => item !== value) : [...values.filter((item) => item !== '无'), value]; return next.join('、'); });
  const updateQuantity = (product: InventoryItem, value: number) => { if (value < 1) return; setCart((current) => ({ ...current, [product.productId]: Math.min(value, product.availableQuantity) })); };
  const photoWatermarkLines = captureWatermarkLines(user, 'dealer');
  const selectScreenshot = (file: File | undefined) => { if (!file) return; if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { setNotice({ tone: 'error', text: '订单截图仅支持 PNG、JPG 或 WebP 图片。' }); return; } if (file.size > 512 * 1024) { setNotice({ tone: 'error', text: '订单截图不能超过 500 KB。' }); return; } const reader = new FileReader(); reader.onload = () => setScreenshotDataUrl(typeof reader.result === 'string' ? reader.result : ''); reader.onerror = () => setNotice({ tone: 'error', text: '订单截图读取失败，请重新选择。' }); reader.readAsDataURL(file); };
  const save = async (submit: boolean) => { const salePriceValue = salePrice.trim() === '' ? null : Number(salePrice); if (!storeId) { setNotice({ tone: 'error', text: '请选择下单店铺。' }); return; } if (!lines.length) { setNotice({ tone: 'error', text: '请至少选择一件产品。' }); return; } if (lines.some((line) => line.quantity > line.product.availableQuantity)) { setNotice({ tone: 'error', text: '订购数量不能超过当前可用库存。' }); return; } if (salePriceValue !== null && (!Number.isFinite(salePriceValue) || salePriceValue < 0)) { setNotice({ tone: 'error', text: '请填写正确的售卖价格。' }); return; } if (submit && !window.confirm('确认提交订单审核吗？提交后暂不能修改订单内容。')) return; setSaving(true); setNotice(null); try { const body = { storeId, note, salePriceCents: salePriceValue === null ? null : Math.round(salePriceValue * 100), shippingAddress, customerProfile, screenshotDataUrl, items: lines.map((line) => ({ productId: line.product.productId, quantity: line.quantity })) }; const result = editId ? await api<{ id: string }>(`/orders/${editId}`, { method: 'PUT', body: JSON.stringify(body) }) : await api<{ id: string }>('/orders', { method: 'POST', body: JSON.stringify(body) }); if (submit) { await api(`/orders/${result.id}/submit`, { method: 'POST' }); go(`/system/orders/${result.id}`, '订单已提交审核。'); } else { go(`/system/orders/${result.id}`, '草稿已保存。'); } } catch (error) { setNotice({ tone: 'error', text: friendlyError(error) }); } finally { setSaving(false); } };
  return <DealerShell user={user} route={route} title={editId ? '编辑订单' : '新建订单'} subtitle="选择产品并提交采购订单。"><Crumbs items={[{ label: '我的订单', href: '/system/orders' }, { label: editId ? '编辑订单' : '新建订单' }]} /><Alert notice={notice} />{loading ? <Loading /> : <><div className="form-layout dealer-form-layout"><section className="panel"><div className="panel-title"><h2>订单信息</h2></div><label>下单店铺<select value={storeId} onChange={(event) => setStoreId(event.target.value)}><option value="">请选择店铺</option>{stores.map((store) => <option value={store.id} key={store.id}>{store.name}</option>)}</select></label><label>售卖价格（元）<input inputMode="decimal" value={salePrice} onChange={(event) => setSalePrice(event.target.value)} placeholder="例如 1299.00" /></label><label>收货信息<textarea value={shippingAddress} onChange={(event) => setShippingAddress(event.target.value)} placeholder="填写收货人、手机号和完整收货地址" maxLength={500} /></label><div><span className="form-label">用户画像</span><div className="checkbox-grid">{customerProfileOptions.map((item) => <label key={item}><input type="checkbox" checked={selectedProfiles.includes(item)} onChange={() => toggleProfile(item)} />{item}</label>)}</div></div><div className="photo-upload-field"><strong>订单截图</strong><div className="photo-upload-actions"><label className="button button--secondary">选择图片<input hidden aria-label="订单截图" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => selectScreenshot(event.target.files?.[0])} /></label><CameraPhotoButton label="摄像头拍照" fileNamePrefix="order-screenshot" watermarkLines={photoWatermarkLines} maxOutputWidth={900} quality={0.72} onCapture={selectScreenshot} onError={(text) => setNotice({ tone: 'error', text })} /></div><small>支持 PNG、JPG、WebP，单张不超过 500 KB。拍照后可预览水印并添加红框或红箭头。</small></div>{screenshotDataUrl && <div className="order-screenshot-preview"><img src={screenshotDataUrl} alt="订单截图预览" /><ActionButton secondary onClick={() => setScreenshotDataUrl('')}>移除截图</ActionButton></div>}<label>订单备注<textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="可选填写，如收货安排或订单说明" maxLength={500} /></label></section><section className="panel"><div className="panel-title"><h2>订单明细</h2></div>{lines.length ? <div className="selected-lines">{lines.map(({ product, quantity }) => <div className="line-item" key={product.productId}><div><strong>{product.name}</strong><span>{product.productVersion || product.specification || '未标注版本'} · {product.sku} · 保修 {warrantyDaysBySku[product.sku] ? `${warrantyDaysBySku[product.sku]} 天` : '待确认'}</span></div><div className="quantity-control"><button onClick={() => quantity > 1 && updateQuantity(product, quantity - 1)}>−</button><input aria-label={`${product.name} 数量`} type="number" min="1" max={product.availableQuantity} value={quantity} onChange={(event) => updateQuantity(product, Number(event.target.value))} /><button onClick={() => updateQuantity(product, quantity + 1)}>+</button><button className="line-remove" onClick={() => setCart((current) => { const next = { ...current }; delete next[product.productId]; return next; })}>移除</button></div></div>)}</div> : <p className="soft-text">请从下方产品列表中添加产品。</p>}<dl className="order-total"><dt>商品数量</dt><dd>{totalQuantity}</dd><dt>商品金额</dt><dd>{money(total)}</dd><dt>预计总额</dt><dd>{money(total)}</dd></dl></section></div><section className="panel product-picker"><div className="panel-title"><h2>选择产品</h2><span>可用库存以列表显示为准</span></div><div className="product-picker-grid">{products.map((product) => <article key={product.productId} className={product.availableQuantity <= 0 ? 'is-unavailable' : ''}><div><span className={`inventory-tag inventory-tag--${inventoryState(product)}`}>{inventoryState(product)}</span><h3>{product.name}</h3><p>{product.productVersion || product.specification || '未标注版本'} · 物料编码 {product.sku}</p><strong>{money(product.unitPriceCents)}</strong><small>可用库存：{product.availableQuantity} · 保修 {warrantyDaysBySku[product.sku] ? `${warrantyDaysBySku[product.sku]} 天` : '待确认'}</small></div><ActionButton secondary disabled={product.availableQuantity <= 0} onClick={() => updateQuantity(product, cart[product.productId] ? cart[product.productId] + 1 : 1)}>{cart[product.productId] ? '增加数量' : '添加产品'}</ActionButton></article>)}</div></section><div className="sticky-action"><span>订单金额以提交时的产品价格为准。</span><ActionButton secondary disabled={saving} onClick={() => save(false)}>{saving ? '正在保存…' : '保存草稿'}</ActionButton><ActionButton disabled={saving} onClick={() => save(true)}>提交审核</ActionButton></div></>}</DealerShell>;
}

function Orders({ user, route }: { user: SessionUser; route: string }) {
  const params = useMemo(() => new URLSearchParams(route.split('?')[1] ?? ''), [route]); const [status, setStatus] = useState(params.get('status') ?? 'all'); const [search, setSearch] = useState(''); const [storeId, setStoreId] = useState(''); const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [page, setPage] = useState(1); const [stores, setStores] = useState<Store[]>([]); const [data, setData] = useState<{ orders: OrderListItem[]; pagination: { page: number; totalPages: number; total: number } } | null>(null); const [notice, setNotice] = useState<NoticeState>(null);
  useEffect(() => { api<{ stores: Store[] }>('/stores').then((data) => setStores(data.stores)).catch(() => undefined); }, []);
  useEffect(() => { const query = new URLSearchParams({ page: String(page), limit: '12' }); if (status !== 'all') query.set('status', status); if (search) query.set('search', search); if (storeId) query.set('storeId', storeId); if (from) query.set('from', from); if (to) query.set('to', to); api<{ orders: OrderListItem[]; pagination: { page: number; totalPages: number; total: number } }>(`/orders?${query}`).then(setData).catch((error) => setNotice({ tone: 'error', text: friendlyError(error) })); }, [status, search, storeId, from, to, page]);
  const statuses: Array<[string, string]> = [['all', '全部'], ...Object.entries(statusNames)];
  return <DealerShell user={user} route={route} title="订单" subtitle="查看和管理当前经销商的全部订单。"><Alert notice={notice} /><section className="portal-toolbar order-toolbar"><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="搜索订单编号" /><select value={storeId} onChange={(event) => { setStoreId(event.target.value); setPage(1); }}><option value="">全部店铺</option>{stores.map((store) => <option value={store.id} key={store.id}>{store.name}</option>)}</select><input type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPage(1); }} aria-label="开始日期" /><input type="date" value={to} onChange={(event) => { setTo(event.target.value); setPage(1); }} aria-label="结束日期" /><ActionButton href="#/system/new-order">新建订单</ActionButton></section><div className="filter-row order-status-filter">{statuses.map(([value, label]) => <button key={value} className={`filter ${status === value ? 'active' : ''}`} onClick={() => { setStatus(value); setPage(1); }}>{label}</button>)}</div>{!data ? <Loading /> : data.orders.length ? <><div className="table-wrap"><table><thead><tr><th>订单编号</th><th>店铺</th><th>商品数量</th><th>订单金额</th><th>当前状态</th><th>创建时间</th><th>更新时间</th><th>操作</th></tr></thead><tbody>{data.orders.map((order) => <tr key={order.id}><td><a href={`#/system/orders/${order.id}`}>{order.orderNo}</a></td><td>{order.storeName}</td><td>{order.itemCount}</td><td>{money(order.totalCents)}</td><td><StatusTag value={order.status} /></td><td>{dateTime(order.createdAt)}</td><td>{dateTime(order.updatedAt)}</td><td><a className="table-action" href={`#/system/orders/${order.id}`}>查看详情</a></td></tr>)}</tbody></table></div><Pagination page={data.pagination.page} totalPages={data.pagination.totalPages} total={data.pagination.total} onChange={setPage} /></> : <Empty title="暂无订单。" text="可先创建一份采购订单。" action={<ActionButton href="#/system/new-order">新建订单</ActionButton>} />}</DealerShell>;
}

function Pagination({ page, totalPages, total, onChange }: { page: number; totalPages: number; total: number; onChange: (page: number) => void }) { return <div className="pagination"><span>共 {total} 条</span><div><button disabled={page <= 1} onClick={() => onChange(page - 1)}>上一页</button><span>{page} / {totalPages}</span><button disabled={page >= totalPages} onClick={() => onChange(page + 1)}>下一页</button></div></div>; }

function OrderDetail({ user, route, orderId }: { user: SessionUser; route: string; orderId: string }) {
  const [data, setData] = useState<{ order: { id: string; orderNo: string; status: OrderStatus; storeId: string; storeName: string; createdByName: string; createdAt: string; updatedAt: string; submittedAt: string | null; reviewedAt: string | null; note: string; reviewNote?: string; totalCents: number; salePriceCents: number | null; shippingAddress: string; customerProfile: string; screenshotDataUrl: string }; items: OrderItem[]; serials: Array<{ productId: string; serialNumber: string }>; shipment: { carrier: string; trackingNumber: string; shippedAt: string } | null; timeline: Array<{ label: string; at: string }> } | null>(null); const [notice, setNotice] = useState<NoticeState>(null);
  const load = () => api<typeof data>(`/orders/${orderId}`).then((value) => setData(value)).catch((error) => setNotice({ tone: 'error', text: friendlyError(error) }));
  useEffect(() => { api<typeof data>(`/orders/${orderId}`).then((value) => setData(value)).catch((error) => setNotice({ tone: 'error', text: friendlyError(error) })); }, [orderId]);
  const submit = async () => { if (!window.confirm('确认提交订单审核吗？提交后暂不能修改订单内容。')) return; try { await api(`/orders/${orderId}/submit`, { method: 'POST' }); setNotice({ tone: 'success', text: '订单已提交审核。' }); load(); } catch (error) { setNotice({ tone: 'error', text: friendlyError(error) }); } };
  const remove = async () => { if (!window.confirm('确定删除这份草稿订单吗？删除后无法恢复。')) return; try { await api(`/orders/${orderId}`, { method: 'DELETE' }); go('/system/orders', '草稿订单已删除。'); } catch (error) { setNotice({ tone: 'error', text: friendlyError(error) }); } };
  const copyTracking = async () => { if (!data?.shipment) return; await navigator.clipboard?.writeText(data.shipment.trackingNumber); setNotice({ tone: 'success', text: '运单号已复制。' }); };
  return <DealerShell user={user} route={route} title="订单详情" subtitle={data?.order.orderNo ?? '订单信息'}><Crumbs items={[{ label: '我的订单', href: '/system/orders' }, { label: data?.order.orderNo ?? '订单详情' }]} /><Alert notice={notice} />{!data ? <Loading /> : <div className="order-layout"><section className="panel detail-header"><div><StatusTag value={data.order.status} /><h2>{data.order.orderNo}</h2><p>{data.order.storeName}</p></div><div className="action-list">{data.order.status === 'draft' && <><ActionButton secondary href={`#/system/orders/${orderId}/edit`}>编辑订单</ActionButton><ActionButton onClick={submit}>提交审核</ActionButton><ActionButton danger onClick={remove}>删除草稿</ActionButton></>}{data.order.status === 'rejected' && <ActionButton href={`#/system/orders/${orderId}/edit`}>修改原订单</ActionButton>}{data.order.status === 'shipped' && <><ActionButton secondary onClick={copyTracking}>复制运单号</ActionButton><ActionButton secondary onClick={() => setNotice({ tone: 'success', text: '物流查询功能将在后续版本开放。' })}>查看物流信息</ActionButton></>}{data.order.status === 'delivered' && <ActionButton href={`#/system/after-sales/new?orderId=${orderId}`}>发起售后</ActionButton>}</div></section><section className="panel"><div className="panel-title"><h2>订单信息</h2></div><dl className="detail-grid"><dt>所属店铺</dt><dd>{data.order.storeName}</dd><dt>创建人</dt><dd>{data.order.createdByName}</dd><dt>创建时间</dt><dd>{dateTime(data.order.createdAt)}</dd><dt>提交时间</dt><dd>{dateTime(data.order.submittedAt)}</dd><dt>审核时间</dt><dd>{dateTime(data.order.reviewedAt)}</dd><dt>售卖价格</dt><dd>{data.order.salePriceCents === null ? '—' : money(data.order.salePriceCents)}</dd><dt>收货地址</dt><dd>{data.order.shippingAddress || '—'}</dd><dt>用户画像</dt><dd>{data.order.customerProfile || '—'}</dd><dt>订单备注</dt><dd>{data.order.note || '—'}</dd></dl>{data.order.screenshotDataUrl && <div className="order-screenshot-preview"><span>订单截图</span><img src={data.order.screenshotDataUrl} alt="订单截图" /></div>}</section>{data.order.status === 'rejected' && <section className="notice notice--error"><strong>未通过原因</strong><br />{data.order.reviewNote || '请联系管理员了解详情。'}</section>}<section className="panel"><div className="panel-title"><h2>商品明细</h2></div><div className="table-wrap"><table><thead><tr><th>产品</th><th>SKU</th><th>数量</th><th>单价</th><th>小计</th><th>关联 SN</th></tr></thead><tbody>{data.items.map((item) => <tr key={item.id}><td>{item.name}</td><td>{item.sku}</td><td>{item.quantity}</td><td>{money(item.unitPriceCents)}</td><td>{money(item.unitPriceCents * item.quantity)}</td><td>{data.serials.filter((serial) => serial.productId === item.productId).map((serial) => serial.serialNumber).join('、') || '—'}</td></tr>)}</tbody></table></div><div className="detail-total">订单总额 <strong>{money(data.order.totalCents)}</strong></div></section><section className="order-bottom-grid"><section className="panel"><div className="panel-title"><h2>物流信息</h2></div>{data.shipment ? <dl className="detail-grid"><dt>物流公司</dt><dd>{data.shipment.carrier}</dd><dt>运单号</dt><dd>{data.shipment.trackingNumber || '未填写运单号'}</dd><dt>发货时间</dt><dd>{dateTime(data.shipment.shippedAt)}</dd></dl> : <p className="soft-text">订单发货后将在这里显示物流信息。</p>}</section><section className="panel"><div className="panel-title"><h2>状态记录</h2></div><ul className="timeline">{data.timeline.map((item) => <li key={`${item.label}-${item.at}`}><i /><span><strong>{item.label}</strong><small>{dateTime(item.at)}</small></span></li>)}</ul></section></section></div>}</DealerShell>;
}

function Notifications({ user, route }: { user: SessionUser; route: string }) {
  const [data, setData] = useState<{ notifications: Notification[]; unreadCount: number } | null>(null); const [notice, setNotice] = useState<NoticeState>(null); const [filter, setFilter] = useState<'all' | 'unread' | 'read'>('all'); const load = () => api<{ notifications: Notification[]; unreadCount: number }>('/notifications?limit=50').then(setData).catch((error) => setNotice({ tone: 'error', text: friendlyError(error) })); useEffect(() => { load(); }, []);
  const mark = async (item: Notification) => { try { if (!item.readAt) await api(`/notifications/${item.id}/read`, { method: 'PATCH' }); if (item.link) go(item.link); else load(); } catch (error) { setNotice({ tone: 'error', text: friendlyError(error) }); } };
  const markAll = async () => { try { await api('/notifications/read-all', { method: 'POST' }); setNotice({ tone: 'success', text: '已全部标记为已读。' }); load(); } catch (error) { setNotice({ tone: 'error', text: friendlyError(error) }); } };
  const visible = data?.notifications.filter((item) => filter === 'all' || (filter === 'unread' ? !item.readAt : Boolean(item.readAt))) ?? [];
  return <DealerShell user={user} route={route} title="站内通知" subtitle="查看订单、库存和售后状态更新。"><Alert notice={notice} /><div className="notification-toolbar"><div className="segmented-control" role="tablist" aria-label="通知筛选">{[['all', '全部'], ['unread', '未读'], ['read', '已读']].map(([value, label]) => <button type="button" role="tab" aria-selected={filter === value} className={filter === value ? 'is-active' : ''} key={value} onClick={() => setFilter(value as typeof filter)}>{label}</button>)}</div><ActionButton secondary disabled={!data?.unreadCount} onClick={markAll}>全部标记为已读</ActionButton></div>{!data ? <Loading /> : visible.length ? <div className="notification-list-panel"><div className="notification-list">{visible.map((item) => <button className={`notification-row ${item.readAt ? '' : 'is-unread'}`} key={item.id} onClick={() => mark(item)}><span className="notification-dot" aria-hidden="true" /><span className="notification-copy"><strong>{item.title}</strong><span>{item.body}</span></span><span className="notification-type">{notificationTypes[item.type] ?? '系统通知'}</span><span className="notification-read-state">{item.readAt ? '已读' : '未读'}</span><time>{dateTime(item.createdAt)}</time><span className="notification-arrow" aria-hidden="true">›</span></button>)}</div></div> : <Empty title={filter === 'all' ? '暂时没有新通知。' : '没有符合条件的通知。'} />}</DealerShell>;
}

function AfterSalesList({ user, route }: { user: SessionUser; route: string }) {
  const [cases, setCases] = useState<AfterSales[] | null>(null); const [notice, setNotice] = useState<NoticeState>(null); useEffect(() => { api<{ cases: AfterSales[] }>('/after-sales?limit=50').then((data) => setCases(data.cases)).catch((error) => setNotice({ tone: 'error', text: friendlyError(error) })); }, []);
  return <DealerShell user={user} route={route} title="售后工单" subtitle="提交售后申请并跟进处理进度。"><Alert notice={notice} /><div className="toolbar"><ActionButton href="#/system/after-sales/new">新建售后工单</ActionButton></div>{!cases ? <Loading /> : cases.length ? <div className="table-wrap"><table><thead><tr><th>工单编号</th><th>问题类型</th><th>关联订单</th><th>产品</th><th>SN</th><th>当前状态</th><th>创建时间</th><th>更新时间</th></tr></thead><tbody>{cases.map((item) => <tr key={item.id}><td><a href={`#/system/after-sales/${item.id}`}>{item.caseNo}</a></td><td>{item.caseType}</td><td>{item.orderId ? <a href={`#/system/orders/${item.orderId}`}>查看订单</a> : '—'}</td><td>{item.productName || '—'}</td><td>{item.serialNumber || '—'}</td><td><StatusTag value={item.status} /></td><td>{dateTime(item.createdAt)}</td><td>{dateTime(item.updatedAt)}</td></tr>)}</tbody></table></div> : <Empty title="暂无售后工单。" text="遇到产品问题时，可在此提交售后申请并查看处理进度。" action={<ActionButton href="#/system/after-sales/new">新建售后工单</ActionButton>} />}</DealerShell>;
}

function AfterSalesSubmitForm({ user, route }: { user: SessionUser; route: string }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AfterSalesAssetSearch[]>([]);
  const [context, setContext] = useState<AfterSalesAssetContext | null>(null);
  const [caseType, setCaseType] = useState<(typeof afterSalesCaseTypes)[number][0]>('QUALITY_ISSUE');
  const [description, setDescription] = useState('');
  const [customerNote, setCustomerNote] = useState('');
  const [internalNote, setInternalNote] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactAddress, setContactAddress] = useState('');
  const [photos, setPhotos] = useState<File[]>([]);
  const [notice, setNotice] = useState<NoticeState>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const photoWatermarkLines = captureWatermarkLines(user, 'dealer');
  const loadContext = async (assetId: string) => {
    const data = await api<AfterSalesAssetContext>(`/after-sales/assets/${assetId}/context`);
    setContext(data);
    setResults([]);
    setQuery(data.asset.currentSn || data.asset.originalSn || query);
    if (data.asset.shippingAddress && !contactAddress) setContactAddress(data.asset.shippingAddress);
  };
  const search = async () => {
    const value = query.replace(/[\r\n\t]/g, '').trim();
    if (value.length < 4) return setNotice({ tone: 'error', text: '请输入至少 4 位 SN 或资产标识。' });
    setLoading(true); setNotice(null);
    try {
      const data = await api<{ items: AfterSalesAssetSearch[] }>(`/after-sales/assets/search?q=${encodeURIComponent(value)}`);
      if (data.items.length === 1) await loadContext(data.items[0].id);
      else { setResults(data.items); setContext(null); if (!data.items.length) setNotice({ tone: 'error', text: '未找到匹配的 SN 或资产标识。' }); }
    } catch (error) { setNotice({ tone: 'error', text: friendlyError(error) }); }
    finally { setLoading(false); }
  };
  const appendPhotos = (incoming: File[]) => {
    const next = [...photos, ...incoming].slice(0, 5);
    const invalid = next.find((file) => !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024);
    if (invalid) return setNotice({ tone: 'error', text: '图片仅支持 JPG、PNG、WebP，单张不能超过 8MB。' });
    if (photos.length + incoming.length > 5) setNotice({ tone: 'error', text: '问题照片最多上传 5 张，已自动保留前 5 张。' });
    setPhotos(next);
  };
  const selectPhotos = (files: FileList | null) => appendPhotos(Array.from(files ?? []));
  const addProblemPhoto = (file: File) => appendPhotos([file]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!context) return setNotice({ tone: 'error', text: '请先选择有效 SN。' });
    if (context.openCase) return setNotice({ tone: 'error', text: `该 SN 已有未关闭工单：${context.openCase.caseNo}` });
    setSaving(true); setNotice(null);
    try {
      const created = await api<{ id: string; caseNo: string }>('/after-sales', { method: 'POST', body: JSON.stringify({
        assetId: context.asset.id,
        dealerId: context.asset.dealerId,
        storeId: context.asset.storeId,
        orderId: context.asset.latestOrderId,
        productId: context.asset.productId,
        serialNumber: context.asset.currentSn || context.asset.originalSn,
        caseType,
        subject: afterSalesCaseTypes.find(([value]) => value === caseType)?.[1] ?? '售后申请',
        description,
        customerNote,
        internalNote,
        contactName,
        contactPhone,
        contactEmail,
        contactAddress,
        isProxySubmission: user.permissions.includes('data:read:all') || user.roles.includes('authorized_service_center')
      }) });
      for (const file of photos) {
        const form = new FormData();
        form.append('category', 'customer_problem_photo');
        form.append('file', file);
        await api(`/after-sales/${created.id}/attachments`, { method: 'POST', body: form });
      }
      go(`/system/after-sales/${created.id}`, `售后工单 ${created.caseNo} 已提交。`);
    } catch (error) { setNotice({ tone: 'error', text: friendlyError(error) }); }
    finally { setSaving(false); }
  };
  return <DealerShell user={user} route={route} title="提交售后工单" subtitle="先查询 SN，系统会自动带出资产、订单和保修信息。"><Crumbs items={[{ label: '售后服务', href: '/system/after-sales' }, { label: '提交售后工单' }]} /><Alert notice={notice} /><section className="panel"><div className="panel-title"><h2>SN 查询</h2><span>支持完整 SN、前缀、中间片段或后缀，至少 4 位。</span></div><div className="portal-toolbar"><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void search(); } }} placeholder="扫描或输入 SN / 历史标识" /><ActionButton onClick={() => void search()} disabled={loading}>{loading ? '查询中…' : '查询'}</ActionButton></div>{results.length > 1 && <div className="table-wrap"><table><thead><tr><th>当前 SN</th><th>原始 SN</th><th>产品</th><th>版本</th><th>资产状态</th><th>操作</th></tr></thead><tbody>{results.map((item) => <tr key={item.id}><td>{item.currentSn || '—'}</td><td>{item.originalSn || '—'}</td><td>{item.productName}</td><td>{item.version || '—'}</td><td>{item.assetStatus}</td><td><button className="table-action" onClick={() => void loadContext(item.id)}>选择</button></td></tr>)}</tbody></table></div>}</section>{context && <form onSubmit={submit} className="case-form"><section className="panel"><div className="panel-title"><h2>资产信息</h2><span>{context.openCase ? `已有未关闭工单：${context.openCase.caseNo}` : '已自动载入，默认只读。'}</span></div><dl className="detail-grid"><dt>当前 SN</dt><dd>{context.asset.currentSn || '暂无数据'}</dd><dt>原始 SN</dt><dd>{context.asset.originalSn || '暂无数据'}</dd><dt>历史标识</dt><dd>{context.identifiers.map((item) => item.identifierValue).join('、') || '暂无数据'}</dd><dt>产品</dt><dd>{context.asset.productName || '暂无数据'}</dd><dt>版本</dt><dd>{context.asset.version || '暂无数据'}</dd><dt>SKU / 物料编码</dt><dd>{context.asset.materialCode || context.asset.sku || '暂无数据'}</dd><dt>资产状态</dt><dd>{context.asset.assetStatus || '暂无数据'}</dd><dt>订单号</dt><dd>{context.asset.latestOrderNo || '暂无数据'}</dd><dt>经销商</dt><dd>{context.asset.dealerName || '暂无数据'}</dd><dt>店铺</dt><dd>{context.asset.storeName || '暂无数据'}</dd><dt>原售卖金额</dt><dd>{context.asset.salePriceCents === null ? '暂无数据' : money(context.asset.salePriceCents ?? 0)}</dd><dt>收货资料</dt><dd>{context.asset.shippingAddress || '暂无数据'}</dd><dt>快递</dt><dd>{context.asset.carrier || '暂无数据'} {context.asset.trackingNumber || ''}</dd><dt>发货日期</dt><dd>{dateTime(context.asset.shippedAt)}</dd><dt>保修日期</dt><dd>{dateTime(context.asset.warrantyStartAt)} 至 {dateTime(context.asset.warrantyEndAt)}</dd><dt>保修状态</dt><dd>{context.asset.warrantyStatus || '暂无数据'}</dd><dt>历史售后</dt><dd>{context.history.length ? context.history.map((item) => `${item.caseNo}（${afterSalesStageNames[item.serviceStage] ?? item.status}）`).join('、') : '暂无数据'}</dd></dl>{context.asset.screenshotDataUrl && <div className="order-screenshot-preview"><span>原订单截图</span><img src={context.asset.screenshotDataUrl} alt="订单截图" /></div>}</section><section className="panel"><div className="panel-title"><h2>问题和客户资料</h2><span>问题照片建议上传，最多 5 张。</span></div><label>问题类型<select value={caseType} onChange={(event) => setCaseType(event.target.value as typeof caseType)}>{afterSalesCaseTypes.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>用户问题描述<textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="可选：记录客户原始问题描述" /></label><label>用户备注<textarea value={customerNote} onChange={(event) => setCustomerNote(event.target.value)} placeholder="例如希望电话联系、指定联系时间等" /></label><label>{user.permissions.includes('data:read:all') ? '内部备注' : '经销商或提交人备注'}<textarea value={internalNote} onChange={(event) => setInternalNote(event.target.value)} placeholder="仅内部处理使用，不会自动进入报价邮件" /></label><div className="form-layout"><label>客户姓名（选填）<input value={contactName} onChange={(event) => setContactName(event.target.value)} /></label><label>客户电话（选填）<input value={contactPhone} onChange={(event) => setContactPhone(event.target.value)} /></label><label>客户邮箱（选填）<input type="email" value={contactEmail} onChange={(event) => setContactEmail(event.target.value)} /></label><label>客户地址（选填）<textarea value={contactAddress} onChange={(event) => setContactAddress(event.target.value)} placeholder="填写完整寄修或返还地址" /></label></div><div className="photo-upload-field"><strong>问题照片</strong><div className="photo-upload-actions"><label className="button button--secondary">选择图片<input hidden type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={(event) => selectPhotos(event.target.files)} /></label><CameraPhotoButton label="摄像头拍照" fileNamePrefix="after-sales-problem" watermarkLines={photoWatermarkLines} maxOutputWidth={1600} quality={0.82} onCapture={addProblemPhoto} onError={(text) => setNotice({ tone: 'error', text })} /></div><small>支持 JPG、PNG、WebP，最多 5 张，单张不超过 8MB。拍照后可预览水印并添加红框或红箭头。</small></div>{photos.length > 0 && <div className="image-grid">{photos.map((file, index) => <figure key={`${file.name}-${index}`}><img src={URL.createObjectURL(file)} alt={file.name} /><figcaption>{file.name}</figcaption><button type="button" onClick={() => setPhotos((current) => current.filter((_, itemIndex) => itemIndex !== index))}>移除</button></figure>)}</div>}</section><div className="sticky-action"><span>提交后进入待管理员审核。</span><ActionButton type="submit" disabled={saving || Boolean(context.openCase)}>{saving ? '正在提交…' : '提交售后工单'}</ActionButton></div></form>}</DealerShell>;
}

// Legacy order-linked form kept temporarily for rollback while the SN-based flow is validated.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function AfterSalesForm({ user, route, presetOrderId }: { user: SessionUser; route: string; presetOrderId?: string | null }) {
  const [stores, setStores] = useState<Store[]>([]); const [orders, setOrders] = useState<OrderListItem[]>([]); const [storeId, setStoreId] = useState(''); const [orderId, setOrderId] = useState(presetOrderId ?? ''); const [items, setItems] = useState<OrderItem[]>([]); const [serials, setSerials] = useState<Array<{ productId: string; serialNumber: string }>>([]); const [productId, setProductId] = useState(''); const [serialNumber, setSerialNumber] = useState(''); const [caseType, setCaseType] = useState('产品异常'); const [subject, setSubject] = useState(''); const [description, setDescription] = useState(''); const [contactName, setContactName] = useState(''); const [contactPhone, setContactPhone] = useState(''); const [notice, setNotice] = useState<NoticeState>(null); const [saving, setSaving] = useState(false);
  useEffect(() => { Promise.all([api<{ stores: Store[] }>('/stores'), api<{ orders: OrderListItem[] }>('/orders?limit=100')]).then(([storeData, orderData]) => { setStores(storeData.stores); setOrders(orderData.orders); if (storeData.stores[0]) setStoreId(storeData.stores[0].id); }).catch((error) => setNotice({ tone: 'error', text: friendlyError(error) })); }, []);
  useEffect(() => { if (!orderId) { setItems([]); setSerials([]); setProductId(''); return; } api<{ order: { storeId: string }; items: OrderItem[]; serials: Array<{ productId: string; serialNumber: string }> }>(`/orders/${orderId}`).then((data) => { setItems(data.items); setSerials(data.serials); setStoreId(data.order.storeId); }).catch((error) => setNotice({ tone: 'error', text: friendlyError(error) })); }, [orderId]);
  const submit = async (event: FormEvent) => { event.preventDefault(); setSaving(true); setNotice(null); try { const result = await api<{ id: string; caseNo: string }>('/after-sales', { method: 'POST', body: JSON.stringify({ storeId, orderId: orderId || null, productId: productId || null, serialNumber: serialNumber || null, caseType, subject, description, contactName, contactPhone }) }); go(`/system/after-sales/${result.id}`, `售后工单 ${result.caseNo} 已提交。`); } catch (error) { setNotice({ tone: 'error', text: friendlyError(error) }); } finally { setSaving(false); } };
  return <DealerShell user={user} route={route} title="新建售后工单" subtitle="填写问题信息后提交售后申请。"><Crumbs items={[{ label: '售后工单', href: '/system/after-sales' }, { label: '新建售后工单' }]} /><Alert notice={notice} /><form onSubmit={submit} className="case-form"><div className="form-layout dealer-form-layout"><section className="panel"><div className="panel-title"><h2>关联信息</h2></div><label>授权店铺<select value={storeId} onChange={(event) => setStoreId(event.target.value)}><option value="">请选择店铺</option>{stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label><label>关联订单<select value={orderId} onChange={(event) => setOrderId(event.target.value)}><option value="">不关联订单</option>{orders.map((order) => <option value={order.id} key={order.id}>{order.orderNo} · {order.storeName}</option>)}</select></label><label>关联产品<select value={productId} onChange={(event) => { setProductId(event.target.value); setSerialNumber(''); }} disabled={!items.length}><option value="">请选择产品</option>{items.map((item) => <option value={item.productId} key={item.id}>{item.name}</option>)}</select></label><label>产品 SN<select value={serialNumber} onChange={(event) => setSerialNumber(event.target.value)} disabled={!productId}><option value="">请选择或手动填写</option>{serials.filter((serial) => serial.productId === productId).map((serial) => <option value={serial.serialNumber} key={serial.serialNumber}>{serial.serialNumber}</option>)}</select></label><label>手动填写 SN<input value={serialNumber} onChange={(event) => setSerialNumber(event.target.value)} placeholder="如无 SN，可留空" /></label></section><section className="panel"><div className="panel-title"><h2>问题说明</h2></div><label>问题类型<select value={caseType} onChange={(event) => setCaseType(event.target.value)}>{['产品异常', '安装使用', '物流问题', '配件缺失', '其他问题'].map((type) => <option value={type} key={type}>{type}</option>)}</select></label><label>问题标题<input value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="请简要说明问题" maxLength={160} /></label><label>问题描述<textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="请描述问题发生的情况和已尝试的处理方式" maxLength={5000} /></label><label>联系人<input value={contactName} onChange={(event) => setContactName(event.target.value)} placeholder="请输入联系人姓名" maxLength={80} /></label><label>联系电话<input value={contactPhone} onChange={(event) => setContactPhone(event.target.value)} placeholder="请输入联系电话" maxLength={32} /></label><div className="attachment-note"><strong>附件</strong><span>附件功能将在后续版本开放。</span></div></section></div><div className="sticky-action"><span>提交后可在工单详情中查看处理进度。</span><ActionButton type="submit" disabled={saving}>{saving ? '正在提交…' : '提交售后申请'}</ActionButton></div></form></DealerShell>;
}

function AfterSalesDetail({ user, route, caseId }: { user: SessionUser; route: string; caseId: string }) {
  const [data, setData] = useState<{ case: { caseNo: string; storeName: string | null; orderId: string | null; productName: string | null; serialNumber: string | null; caseType: string; subject: string; description: string; contactName: string | null; contactPhone: string | null; status: string; createdAt: string; updatedAt: string } } | null>(null); const [notice, setNotice] = useState<NoticeState>(null); useEffect(() => { api<typeof data>(`/after-sales/${caseId}`).then(setData).catch((error) => setNotice({ tone: 'error', text: friendlyError(error) })); }, [caseId]);
  return <DealerShell user={user} route={route} title="售后工单详情" subtitle={data?.case.caseNo ?? '查看处理进度'}><Crumbs items={[{ label: '售后工单', href: '/system/after-sales' }, { label: data?.case.caseNo ?? '工单详情' }]} /><Alert notice={notice} />{!data ? <Loading /> : <div className="order-layout"><section className="panel detail-header"><div><StatusTag value={data.case.status} /><h2>{data.case.subject}</h2><p>{data.case.caseNo}</p></div></section><section className="panel"><div className="panel-title"><h2>工单信息</h2></div><dl className="detail-grid"><dt>问题类型</dt><dd>{data.case.caseType}</dd><dt>授权店铺</dt><dd>{data.case.storeName || '—'}</dd><dt>关联订单</dt><dd>{data.case.orderId ? <a href={`#/system/orders/${data.case.orderId}`}>查看订单</a> : '—'}</dd><dt>产品</dt><dd>{data.case.productName || '—'}</dd><dt>产品 SN</dt><dd>{data.case.serialNumber || '—'}</dd><dt>联系人</dt><dd>{data.case.contactName || '—'}</dd><dt>联系电话</dt><dd>{data.case.contactPhone || '—'}</dd><dt>创建时间</dt><dd>{dateTime(data.case.createdAt)}</dd><dt>更新时间</dt><dd>{dateTime(data.case.updatedAt)}</dd></dl></section><section className="panel"><div className="panel-title"><h2>问题描述</h2></div><p className="case-description">{data.case.description}</p></section></div>}</DealerShell>;
}

export function DealerPortal({ user, route, logout }: { user: SessionUser; route: string; logout?: () => void }) {
  const path = route.split('?')[0]; const flash = sessionStorage.getItem('maxcine-flash'); if (flash) sessionStorage.removeItem('maxcine-flash');
  const signOut = logout ?? (() => { void api('/auth/logout', { method: 'POST' }).finally(() => { location.hash = '#/login'; }); });
  const content = path === '/system/dashboard' ? <Dashboard user={user} route={route} /> : path === '/system/inventory' ? <Inventory user={user} route={route} /> : path === '/system/customer-risk' ? <CustomerRiskCenter user={user} route={route} /> : path === '/system/new-order' ? <OrderForm user={user} route={route} /> : path === '/system/orders' ? <Orders user={user} route={route} /> : path === '/system/notifications' ? <Notifications user={user} route={route} /> : path === '/system/after-sales' ? <AfterSalesList user={user} route={route} /> : path === '/system/after-sales/new' ? <AfterSalesSubmitForm user={user} route={route} /> : path.startsWith('/system/assets/') ? <GsxPortal user={user} route={route} logout={signOut} /> : path.startsWith('/system/after-sales/') ? <AfterSalesDetail user={user} route={route} caseId={path.split('/').at(-1)!} /> : path.endsWith('/edit') && path.startsWith('/system/orders/') ? <OrderForm user={user} route={route} editId={path.split('/')[3]} /> : path.startsWith('/system/orders/') ? <OrderDetail user={user} route={route} orderId={path.split('/').at(-1)!} /> : <Dashboard user={user} route={route} />;
  return <>{flash && <div className="portal-flash">{flash}</div>}{content}</>;
}
