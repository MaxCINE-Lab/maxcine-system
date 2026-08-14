import { FormEvent, ReactNode, useEffect, useMemo, useState } from 'react';
import type { SessionUser } from '@maxcine/shared';
import { api, ApiClientError, type CurrentUserResponse, type LoginResponse } from './api';
import { BrowserBarcodeScanner } from './scanner';
import { DealerPortal } from './DealerPortal';
import { IntelligencePortal } from './IntelligencePortal';
import { OperationsPortal } from './OperationsPortal';
import { ServiceCenterPortal } from './ServiceCenterPortal';
import { AccountMenu, EmployeeWatermark, SystemNavigation, displayRoleText, hasAdminAccess, hasDealerAccess, hasIntelligenceAccess, hasServiceCenterAccess, hasWarehouseAccess } from './systemNavigation';
import { ToastProvider, useToast } from './Toast';

type Route = string;
type Toast = { tone: 'info' | 'error'; message: string } | null;

const nav = [
  ['产品', '#/products'], ['下载', '#/downloads'], ['服务', '#/service'], ['联系', '#/contact']
] as const;

function defaultSystemRoute(user: SessionUser): string {
  if (hasAdminAccess(user)) return '/system/admin';
  if (hasWarehouseAccess(user)) return '/system/warehouse';
  if (hasDealerAccess(user)) return '/system/dashboard';
  if (hasServiceCenterAccess(user)) return '/system/service-center';
  return '/system/dashboard';
}

function useRoute(): Route {
  const [route, setRoute] = useState(() => location.hash.slice(1) || '/');
  useEffect(() => {
    const change = () => setRoute(location.hash.slice(1) || '/');
    addEventListener('hashchange', change);
    return () => removeEventListener('hashchange', change);
  }, []);
  return route;
}

function Logo({ compact = false }: { compact?: boolean }) {
  return <a className={`logo ${compact ? 'logo--compact' : ''}`} href="#/" aria-label="MaxCINE 首页"><img src="/assets/maxcine-logo-lockup.jpg" alt="MaxCINE" /></a>;
}

function PublicHeader() {
  return <header className="public-header"><Logo /> <nav aria-label="主导航">{nav.map(([label, href]) => <a key={href} href={href}>{label}</a>)}</nav><a className="text-link header-login" href="#/login">业务系统 <span>›</span></a></header>;
}

function PublicFooter() {
  return <footer className="public-footer"><Logo compact /><div><p>专业显示与渠道服务</p><small>© {new Date().getFullYear()} MaxCINE. 保留所有权利。</small></div><div className="footer-links"><a href="#/privacy">隐私政策</a><a href="#/terms">服务条款</a><a href="#/contact">联系 MaxCINE</a></div></footer>;
}

function PublicLayout({ children }: { children: ReactNode }) {
  return <><PublicHeader /><main>{children}</main><PublicFooter /></>;
}

function Button({ children, secondary = false, href, onClick, type = 'button', disabled = false }: { children: ReactNode; secondary?: boolean; href?: string; onClick?: () => void; type?: 'button' | 'submit'; disabled?: boolean }) {
  const className = `button ${secondary ? 'button--secondary' : ''}`;
  return href ? <a className={className} href={href}>{children}</a> : <button className={className} onClick={onClick} type={type} disabled={disabled}>{children}</button>;
}

function Feature({ number, title, text }: { number: string; title: string; text: string }) {
  return <article className="feature"><span>{number}</span><h3>{title}</h3><p>{text}</p></article>;
}

function Products() {
  return <PublicLayout><PageHero eyebrow="产品" title="为专业场景而设计。" text="产品资料、规格和供货信息将通过经销商业务系统持续维护。" /><section className="product-showcase"><div className="product-visual"><span>MaxCINE</span><i /></div><div><span className="eyebrow">REFERENCE SERIES</span><h2>专注画面本身。</h2><p>首版官网展示信息架构。正式产品型号、技术参数与价格将在内部审核后发布。</p><Button secondary href="#/downloads">前往下载中心</Button></div></section></PublicLayout>;
}

function Downloads() {
  return <PublicLayout><PageHero eyebrow="下载中心" title="资料，在需要时出现。" text="产品手册、驱动与软件将按型号、版本和发布日期组织。" /><section className="download-list section"><DownloadRow name="产品资料库" detail="即将发布 · 请通过业务系统获取已授权资料" /><DownloadRow name="驱动与软件" detail="即将发布 · 将提供版本说明与校验信息" /><DownloadRow name="服务文档" detail="即将发布 · 安装、保修与售后指引" /></section></PublicLayout>;
}

function DownloadRow({ name, detail }: { name: string; detail: string }) { return <div className="download-row"><div><h3>{name}</h3><p>{detail}</p></div><span className="tag">待发布</span></div>; }

function Service() {
  return <PublicLayout><PageHero eyebrow="售后服务" title="服务，应当可被准确地交付。" text="通过授权经销商或业务系统创建售后工单。我们会以工单状态和事务邮件同步进展。" /><section className="service-grid section"><Feature number="01" title="创建工单" text="提供订单参考编号、问题描述和必要的产品信息。" /><Feature number="02" title="状态跟进" text="在业务系统中查看工单状态及历史记录。" /><Feature number="03" title="处理闭环" text="每个节点以清晰的服务状态通知相关人员。" /></section><section className="centered-callout"><h2>需要服务支持？</h2><Button href="#/login">进入业务系统</Button></section></PublicLayout>;
}

function Contact() {
  return <PublicLayout><PageHero eyebrow="联系" title="保持直接的沟通。" text="正式联系资料将在组织审核完成后发布；首版不展示任何个人电话、地址或客户资料。" /><section className="contact-cards section"><article><h3>渠道合作</h3><p>请通过已授权的业务系统账户发起咨询。</p><span>业务系统入口</span></article><article><h3>售后支持</h3><p>请通过售后工单提交问题并保留订单参考编号。</p><span>工单入口</span></article></section></PublicLayout>;
}

function Legal({ type }: { type: 'privacy' | 'terms' }) {
  const privacy = type === 'privacy';
  return <PublicLayout><article className="legal section"><span className="eyebrow">占位页面</span><h1>{privacy ? '隐私政策' : '服务条款'}</h1><p>此页面是第一版内容占位，不能视为正式法律文本。在上线前应由法务根据实际数据处理、客户关系和运营范围审阅并替换。</p><h2>当前原则</h2><p>系统仅收集完成登录、订单履约、售后和安全审计所必需的数据；不在业务数据、代码或静态页面中写入真实客户资料。</p></article></PublicLayout>;
}

function PageHero({ eyebrow, title, text }: { eyebrow: string; title: string; text: string }) { return <section className="page-hero"><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{text}</p></section>; }

function SystemShell({ user, children, title, subtitle }: { user: SessionUser; children: ReactNode; title: string; subtitle?: string }) {
  const [open, setOpen] = useState(false);
  const signOut = async () => { try { await api('/auth/logout', { method: 'POST' }); } finally { location.hash = '#/login'; } };
  return <div className="system"><header className="system-top"><Logo compact /><button className="menu-toggle" aria-label="打开菜单" onClick={() => setOpen(!open)}>菜单</button><AccountMenu user={user} logout={() => void signOut()} /></header><aside className={`system-nav ${open ? 'is-open' : ''}`}><SystemNavigation user={user} route={location.hash.slice(1) || '/system/dashboard'} onNavigate={() => setOpen(false)} /></aside><main className="system-main"><header className="page-title"><div><span className="eyebrow">MAXCINE / {displayRoleText(user)}</span><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div></header>{children}</main></div>;
}

function EnvironmentBadge() {
  const envName = import.meta.env.VITE_APP_ENV;
  const host = location.hostname;
  const isStaging = envName === 'staging' || host.includes('maxcine-web-staging') || host.includes('staging.');
  if (!isStaging) return null;
  return <div className="staging-badge" aria-label="当前为测试环境">测试环境</div>;
}

function Login({ onLogin }: { onLogin: (user: SessionUser) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<Toast>(null);
  const [loading, setLoading] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setLoading(true); setMessage(null);
    try { const result = await api<LoginResponse>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }); onLogin(result.user); location.hash = result.user.mustChangePassword ? '#/system/change-password' : `#${defaultSystemRoute(result.user)}`; }
    catch (error) { setMessage({ tone: 'error', message: error instanceof ApiClientError ? error.message : '暂时无法登录，请稍后重试。' }); }
    finally { setLoading(false); }
  }
  return <div className="login-page"><form className="login-card" onSubmit={submit}><span className="eyebrow">STAFF ACCESS</span><h1>大中枢访问控制器</h1><p>请输入已授权的 AD 账号和密码。</p><label>AD账号<input type="text" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required /></label><label>密码<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>{message && <div className={`notice notice--${message.tone}`}>{message.message}</div>}<Button type="submit" disabled={loading}>{loading ? '正在登录…' : '登录'}</Button></form></div>;
}

function ChangePassword({ user, onChanged }: { user: SessionUser; onChanged: (user: SessionUser) => void }) {
  const toast = useToast();
  const [currentPassword, setCurrentPassword] = useState('');
  const [nextPassword, setNextPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (nextPassword !== confirmPassword) return toast({ tone: 'error', text: '两次输入的新密码不一致。' });
    setLoading(true);
    try {
      const result = await api<{ changed: boolean; user: SessionUser }>('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, nextPassword }) });
      onChanged(result.user);
      toast({ tone: 'success', text: '密码已修改，请继续使用后台。' });
      location.hash = `#${defaultSystemRoute(result.user)}`;
    } catch (error) {
      toast({ tone: 'error', text: error instanceof ApiClientError ? error.message : '密码修改失败，请稍后重试。' });
    } finally {
      setLoading(false);
    }
  }
  return <div className="login-page"><form className="login-card" onSubmit={submit}><span className="eyebrow">PASSWORD REQUIRED</span><h1>请先修改密码</h1><p>{user.name}，管理员已重置你的账号密码。继续进入后台前，请设置个人新密码。</p><label>当前临时密码<input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></label><label>新密码<input type="password" autoComplete="new-password" value={nextPassword} onChange={(event) => setNextPassword(event.target.value)} minLength={12} required /></label><label>确认新密码<input type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} minLength={12} required /></label><Button type="submit" disabled={loading}>{loading ? '正在保存…' : '修改密码并进入后台'}</Button></form></div>;
}

function Dashboard({ user }: { user: SessionUser }) {
  const cards = user.roles.includes('dealer') ? [['待提交订单', '02'], ['待审核订单', '01'], ['库存提醒', '03']] : user.roles.includes('warehouse_manager') ? [['待拣货', '08'], ['待扫码', '03'], ['今日发货', '12']] : [['待审核订单', '06'], ['库存提醒', '03'], ['售后待处理', '04']];
  return <SystemShell user={user} title="工作概览" subtitle="重要状态一目了然。"><div className="stats">{cards.map(([label, value]) => <Stat key={label} label={label} value={value} />)}</div><section className="dashboard-grid"><Panel title="需要关注"><Timeline rows={user.roles.includes('warehouse_manager') ? ['订单等待拣货', '订单等待扫描 SN', '订单等待发货确认'] : ['请及时处理订单、库存和售后事项。']} /></Panel><Panel title="快速操作"><div className="action-list">{user.roles.includes('dealer') && <Button href="#/system/new-order">新建订单</Button>}{user.roles.includes('warehouse_manager') && <Button href="#/system/warehouse">处理待发货订单</Button>}{user.roles.includes('super_admin') && <Button href="#/system/admin/reviews">审核订单</Button>}<Button secondary href="#/system/notifications">查看通知</Button></div></Panel></section></SystemShell>;
}

function Stat({ label, value }: { label: string; value: string }) { return <article className="stat"><p>{label}</p><strong>{value}</strong><span>当前状态</span></article>; }
function Panel({ title, children }: { title: string; children: ReactNode }) { return <section className="panel"><div className="panel-title"><h2>{title}</h2><span>›</span></div>{children}</section>; }
function Timeline({ rows }: { rows: string[] }) { return <ul className="timeline">{rows.map((row) => <li key={row}><i />{row}</li>)}</ul>; }

function Inventory({ user }: { user: SessionUser }) {
  const rows = [['MC-REFERENCE-01', 'MaxCINE 产品', '—', '业务数据']];
  return <SystemShell user={user} title="共享库存" subtitle="仅展示已授权范围内的可用库存。"><div className="notice">库存数量将由 D1 库存流水实时驱动；首版业务库未注入真实库存。</div><DataTable headings={['SKU', '产品', '可用数量', '状态']} rows={rows} /></SystemShell>;
}

function NewOrder({ user }: { user: SessionUser }) {
  const [added, setAdded] = useState(false);
  return <SystemShell user={user} title="新建订单" subtitle="订单以草稿开始，提交后才进入审核。"><div className="form-layout"><Panel title="订单信息"><label>所属店铺<select defaultValue=""><option value="" disabled>选择已授权店铺</option><option>上海店</option></select></label><label>备注<textarea placeholder="可选：仅填写订单处理必要信息" /></label></Panel><Panel title="产品"><div className="line-item"><div><strong>MC-REFERENCE-01</strong><span>MaxCINE 产品</span></div><input aria-label="数量" type="number" min="1" defaultValue="1" /></div><Button secondary onClick={() => setAdded(!added)}>{added ? '已加入草稿' : '加入草稿'}</Button></Panel></div><div className="sticky-action"><span>总额将在服务端按产品快照计算</span><Button>保存草稿</Button><Button secondary>提交审核</Button></div></SystemShell>;
}

function Orders({ user, detail = false }: { user: SessionUser; detail?: boolean }) {
  if (detail) return <OrderDetail user={user} />;
  return <SystemShell user={user} title="订单" subtitle="按状态跟踪从草稿到交付的全过程。"><div className="filter-row"><button className="filter active">全部</button><button className="filter">待审核</button><button className="filter">处理中</button><button className="filter">已发货</button></div><DataTable headings={['订单编号', '店铺', '状态', '更新时间']} rows={[[<a href="#/system/orders/demo" key="order">MC-20260726-001</a>, '上海店', <Status value="submitted" key="status" />, '业务数据']]}/></SystemShell>;
}

function OrderDetail({ user }: { user: SessionUser }) {
  return <SystemShell user={user} title="订单详情" subtitle="MC-20260726-001"><div className="order-layout"><Panel title="状态"><div className="status-steps">{['草稿', '已提交', '已审核', '拣货', '已打包', '已发货'].map((item, index) => <div key={item} className={index < 2 ? 'done' : ''}><i>{index + 1}</i><span>{item}</span></div>)}</div></Panel><Panel title="产品"><DataTable headings={['产品', '数量', 'SN']} rows={[["MC-REFERENCE-01", '1', '待仓库录入']]}/></Panel><Panel title="发货信息"><p>顺丰运单号将在仓库确认发货后出现。</p></Panel></div></SystemShell>;
}

function Reviews({ user }: { user: SessionUser }) {
  return <SystemShell user={user} title="订单审核" subtitle="审核动作会保留审计记录，并在库存不足时拒绝通过。"><DataTable headings={['订单编号', '经销商', '库存校验', '操作']} rows={[["MC-20260726-001", 'East Dealer', '待校验', <div className="inline-actions" key="actions"><Button>通过</Button><Button secondary>拒绝</Button></div>]]}/><p className="hint">正式审核通过将以原子批处理保留库存、更新订单、写入通知和审计日志。</p></SystemShell>;
}

function Warehouse({ user, mode = 'orders' }: { user: SessionUser; mode?: 'orders' | 'serials' | 'tracking' | 'confirm' }) {
  const step = mode === 'orders' ? 1 : mode === 'serials' ? 2 : mode === 'tracking' ? 3 : 4;
  const titles = { orders: '待处理订单', serials: '录入产品 SN', tracking: '录入顺丰运单号', confirm: '确认发货' };
  return <SystemShell user={user} title={titles[mode]} subtitle="仓库工作流 · 手机优先"><div className="warehouse-steps">{['拣货', 'SN', '运单', '确认'].map((name, index) => <div className={index + 1 <= step ? 'active' : ''} key={name}><span>{index + 1}</span>{name}</div>)}</div>{mode === 'orders' && <WarehouseOrders />}{mode === 'serials' && <SerialEntry />}{mode === 'tracking' && <TrackingEntry />}{mode === 'confirm' && <ShipmentConfirm />}</SystemShell>;
}

function WarehouseOrders() { return <div className="warehouse-card"><span className="tag">已审核</span><h2>MC-20260726-001</h2><p>1 件 · MaxCINE 产品</p><div className="action-list"><Button href="#/system/warehouse/serials">开始拣货并录入 SN</Button><Button secondary href="#/system/orders/demo">查看订单</Button></div></div>; }

function ScannerField({ label, placeholder, onValue }: { label: string; placeholder: string; onValue: (value: string) => void }) {
  const [error, setError] = useState<string | null>(null);
  const scanner = useMemo(() => new BrowserBarcodeScanner(), []);
  async function useCamera() { try { await scanner.start((result) => onValue(result.value)); } catch (reason) { setError(reason instanceof Error ? reason.message : '无法启用摄像头'); } }
  return <div className="scanner"><label>{label}<input placeholder={placeholder} onChange={(event) => onValue(event.target.value.trim())} /></label><Button secondary onClick={useCamera}>使用摄像头扫码</Button><p>摄像头不可用时，请使用手动输入或扫描枪。</p>{error && <div className="notice notice--error">{error}</div>}</div>;
}

function SerialEntry() { const [serial, setSerial] = useState(''); return <div className="warehouse-card"><span className="tag">第 1 / 1 件</span><h2>MaxCINE 产品</h2><ScannerField label="产品序列号（SN）" placeholder="扫描或手动输入 SN" onValue={setSerial} /><Button href="#/system/warehouse/tracking" disabled={!serial}>保存 SN，继续</Button></div>; }
function TrackingEntry() { const [tracking, setTracking] = useState(''); return <div className="warehouse-card"><h2>顺丰运单号</h2><ScannerField label="运单号" placeholder="扫描或手动输入运单号" onValue={setTracking} /><Button href="#/system/warehouse/confirm" disabled={!tracking}>保存运单号，查看摘要</Button></div>; }
function ShipmentConfirm() { const [confirming, setConfirming] = useState(false); return <div className="warehouse-card"><h2>发货前确认</h2><dl className="summary"><dt>订单</dt><dd>MC-20260726-001</dd><dt>产品</dt><dd>MaxCINE 产品 × 1</dd><dt>SN</dt><dd>尚未连接业务数据</dd><dt>顺丰运单号</dt><dd>尚未连接业务数据</dd></dl><div className="danger-zone"><p>确认后订单会变更为“已发货”，且将生成通知与事务邮件任务。</p>{confirming ? <div className="confirm-box"><strong>此操作不可撤回。确认发货？</strong><Button>确认发货</Button><Button secondary onClick={() => setConfirming(false)}>返回</Button></div> : <Button onClick={() => setConfirming(true)}>确认发货</Button>}</div></div>; }

function Notifications({ user }: { user: SessionUser }) { return <SystemShell user={user} title="站内通知" subtitle="订单和售后关键状态会在此同步。"><div className="empty-state"><h2>暂无新通知</h2><p>通知由后端在订单审核、发货和售后状态变化时生成。</p></div></SystemShell>; }

function AdminUsers({ user }: { user: SessionUser }) { return <SystemShell user={user} title="用户与角色" subtitle="权限由后端强制验证。"><DataTable headings={['用户', '角色', '所属经销商', '状态']} rows={[["admin@example.test", '管理员', '—', '可用'], ['dealer@example.test', '经销商', 'East Dealer', '可用'], ['warehouse@example.test', '仓库', '—', '可用']]}/></SystemShell>; }
function AdminDealers({ user }: { user: SessionUser }) { return <SystemShell user={user} title="经销商与店铺" subtitle="管理授权渠道资料；首版不展示任何真实客户信息。"><DataTable headings={['代码', '经销商', '店铺数', '状态']} rows={[["EAST", 'East Dealer', '1', '可用']]}/></SystemShell>; }
function AdminProducts({ user }: { user: SessionUser }) { return <SystemShell user={user} title="产品与库存" subtitle="库存调整必须生成库存流水。"><DataTable headings={['SKU', '产品', '库存', '操作']} rows={[["MC-REFERENCE-01", 'MaxCINE 产品', '—', <Button secondary key="adjust">库存调整</Button>]]}/><p className="hint">生产管理界面应调用受保护的库存流水接口，不能直接修改库存数值。</p></SystemShell>; }
function Audit({ user }: { user: SessionUser }) { return <SystemShell user={user} title="审计记录" subtitle="重要操作按操作者、对象和请求编号记录。"><DataTable headings={['时间', '操作', '对象', '操作者']} rows={[["—", '等待业务数据', '—', '—']]}/></SystemShell>; }
function AfterSales({ user }: { user: SessionUser }) { return <SystemShell user={user} title="售后工单" subtitle="创建、处理和更新均保留服务状态。"><div className="toolbar"><Button>创建售后工单</Button></div><div className="empty-state"><h2>暂无工单</h2><p>工单将关联授权经销商和可选的订单参考编号。</p></div></SystemShell>; }

function DataTable({ headings, rows }: { headings: string[]; rows: ReactNode[][] }) { return <div className="table-wrap"><table><thead><tr>{headings.map((heading) => <th key={heading}>{heading}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((value, index) => <td key={index}>{value}</td>)}</tr>)}</tbody></table></div>; }
function Status({ value }: { value: string }) { return <span className="status">{value}</span>; }

function isDealerRoute(path: string): boolean {
  return path === '/system/dashboard'
    || path === '/system/inventory'
    || path === '/system/customer-risk'
    || path === '/system/intelligence'
    || path === '/system/new-order'
    || path === '/system/orders'
    || path.startsWith('/system/orders/')
    || path === '/system/notifications'
    || path === '/system/after-sales'
    || path.startsWith('/system/after-sales/')
    || path.startsWith('/system/assets/');
}

function AppRouter({ route, user, onLogin, onLogout }: { route: string; user: SessionUser | null; onLogin: (user: SessionUser) => void; onLogout: () => void }) {
  if (route === '/') {
    if (user) {
      location.hash = `#${defaultSystemRoute(user)}`;
      return null;
    }
    return <Login onLogin={onLogin} />;
  }
  if (route === '/products') return <Products />;
  if (route === '/downloads') return <Downloads />;
  if (route === '/service') return <Service />;
  if (route === '/contact') return <Contact />;
  if (route === '/privacy') return <Legal type="privacy" />;
  if (route === '/terms') return <Legal type="terms" />;
  if (route === '/login') return <Login onLogin={onLogin} />;
  if (!user) return <Login onLogin={onLogin} />;
  if (user.mustChangePassword) return <ChangePassword user={user} onChanged={onLogin} />;
  const path = route.split('?')[0];
  if (path === '/system/intelligence' && hasIntelligenceAccess(user)) return <IntelligencePortal user={user} route={route} logout={onLogout} />;
  if (path.startsWith('/system/after-sales') && user.permissions.includes('after-sales:create')) return <DealerPortal user={user} route={route} logout={onLogout} />;
  if (path.startsWith('/system/service-center') && hasServiceCenterAccess(user)) return <ServiceCenterPortal user={user} route={route} />;
  if (path.startsWith('/system/warehouse') && hasWarehouseAccess(user)) return <OperationsPortal user={user} route={route} logout={onLogout} />;
  if (path.startsWith('/system/admin') && hasAdminAccess(user)) return <OperationsPortal user={user} route={route} logout={onLogout} />;
  if (isDealerRoute(path) && hasDealerAccess(user)) return <DealerPortal user={user} route={route} logout={onLogout} />;
  if (route.startsWith('/system')) {
    location.hash = `#${defaultSystemRoute(user)}`;
    return null;
  }
  if (route === '/system/dashboard') return <Dashboard user={user} />;
  if (route === '/system/inventory') return <Inventory user={user} />;
  if (route === '/system/new-order') return <NewOrder user={user} />;
  if (route === '/system/orders') return <Orders user={user} />;
  if (route.startsWith('/system/orders/')) return <Orders user={user} detail />;
  if (route === '/system/admin/reviews') return <Reviews user={user} />;
  if (route === '/system/warehouse') return <Warehouse user={user} />;
  if (route === '/system/warehouse/serials') return <Warehouse user={user} mode="serials" />;
  if (route === '/system/warehouse/tracking') return <Warehouse user={user} mode="tracking" />;
  if (route === '/system/warehouse/confirm') return <Warehouse user={user} mode="confirm" />;
  if (route === '/system/notifications') return <Notifications user={user} />;
  if (route === '/system/admin/users') return <AdminUsers user={user} />;
  if (route === '/system/admin/dealers') return <AdminDealers user={user} />;
  if (route === '/system/admin/products') return <AdminProducts user={user} />;
  if (route === '/system/admin/audit') return <Audit user={user} />;
  if (route === '/system/after-sales') return <AfterSales user={user} />;
  return <PublicLayout><PageHero eyebrow="404" title="页面未找到。" text="请返回 MaxCINE 首页继续浏览。" /></PublicLayout>;
}

export function App() {
  const route = useRoute();
  const [user, setUser] = useState<SessionUser | null>(null);
  useEffect(() => { api<CurrentUserResponse>('/me').then((result) => setUser(result.user)).catch(() => undefined); }, []);
  useEffect(() => {
    if (route.startsWith('/system')) window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [route]);
  const logout = async () => { try { await api('/auth/logout', { method: 'POST' }); } finally { setUser(null); location.hash = '#/login'; } };
  return <ToastProvider><EnvironmentBadge /><AppRouter route={route} user={user} onLogin={setUser} onLogout={logout} />{user && route.startsWith('/system') && <EmployeeWatermark user={user} />}</ToastProvider>;
}
