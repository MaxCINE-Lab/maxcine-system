/* eslint-disable react-hooks/exhaustive-deps */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { SessionUser } from '@maxcine/shared';
import { api, ApiClientError } from './api';
import { CameraPhotoButton } from './CameraPhotoButton';
import { AccountMenu, SystemNavigation, displayRoleLabel, displayRoleText, employeeNumberForUser } from './systemNavigation';

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || '/api';
type Notice = { tone: 'error' | 'success'; text: string } | null;
type Option = { id: string; name: string; code?: string; email?: string };
type Options = { roles: Array<Option & { code: string }>; dealers: Option[]; stores: Option[]; users: Option[]; serviceCenters: Option[] };
const platforms = ['闲鱼', '淘宝', '官方渠道', '线下门店', '其他'];
const date = (v?: string | null) => v ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', hour12: false }).format(new Date(`${v.replace(' ', 'T')}Z`)) : '—';
const money = (value: number | null | undefined) => typeof value === 'number' ? `¥${(value / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}` : '需确认';
const errorText = (e: unknown) => e instanceof ApiClientError ? e.message : '操作未完成，请稍后重试。';
const roleListText = (roles: string) => roles.split(',').map((role) => displayRoleLabel(role.trim())).filter(Boolean).join('，') || '—';
function Button({ children, onClick, secondary, danger, disabled, type = 'button' }: { children: ReactNode; onClick?: () => void; secondary?: boolean; danger?: boolean; disabled?: boolean; type?: 'button' | 'submit' }) { return <button type={type} className={`button ${secondary ? 'button--secondary' : ''} ${danger ? 'button--danger' : ''}`} disabled={disabled} onClick={onClick}>{children}</button>; }
function Shell({ user, route, logout, title, text, children }: { user: SessionUser; route: string; logout: () => void; title: string; text: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <div className="system"><header className="system-top"><img className="system-light-logo" src="/assets/maxcine-logo-on-light.png" alt="MaxCINE" /><button className="menu-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>菜单</button><a className="global-search" href="#/system/admin/assets" aria-label="打开全局查询">搜索资产或订单</a><a className="top-notifications" href="#/system/notifications" aria-label="查看站内通知">通知</a><AccountMenu user={user} logout={logout} /></header><aside className={`system-nav ${open ? 'is-open' : ''}`}><img className="system-dark-logo" src="/assets/maxcine-logo-on-dark.png" alt="MaxCINE" /><SystemNavigation user={user} route={route} onNavigate={() => setOpen(false)} /></aside><main className="system-main"><header className="page-title"><span className="eyebrow">MAXCINE / {displayRoleText(user)}</span><h1>{title}</h1><p>{text}</p></header>{children}</main></div>;
}
function Feedback({ notice }: { notice: Notice }) { return notice ? <div className={`notice notice--${notice.tone === 'error' ? 'error' : 'info'}`}>{notice.text}</div> : null; }
function Empty({ text = '暂无内容。' }: { text?: string }) { return <div className="empty-state"><h2>{text}</h2></div>; }
function useOptions() { const [options, setOptions] = useState<Options | null>(null); useEffect(() => { void api<Options>('/admin/options').then(setOptions); }, []); return options; }

type Product = { id: string; sku: string; name: string; description: string; productVersion: string; specification: string; unitPriceCents: number; reorderLevel: number; isActive: number; availableQuantity: number; reservedQuantity: number; createdAt: string; updatedAt: string };
const freshProduct = () => ({ sku: '', name: '', description: '', productVersion: '', specification: '', unitPriceCents: '', reorderLevel: '0', isActive: true });
function Products({ user, route, logout }: Props) { const [items, setItems] = useState<Product[] | null>(null); const [form, setForm] = useState(freshProduct()); const [editing, setEditing] = useState<string | null>(null); const [search, setSearch] = useState(''); const [active, setActive] = useState(''); const [notice, setNotice] = useState<Notice>(null); const load = () => api<{ products: Product[] }>(`/admin/products?search=${encodeURIComponent(search)}${active ? `&active=${active}` : ''}`).then((data) => setItems(data.products)).catch((e) => setNotice({ tone: 'error', text: errorText(e) })); useEffect(() => { void load(); }, [search, active]); const edit = (item: Product) => { setEditing(item.id); setForm({ sku: item.sku, name: item.name, description: item.description, productVersion: item.productVersion, specification: item.specification, unitPriceCents: String(item.unitPriceCents), reorderLevel: String(item.reorderLevel), isActive: Boolean(item.isActive) }); }; const submit = async (event: FormEvent) => { event.preventDefault(); if (!form.sku || !form.name || Number(form.unitPriceCents) < 0) return setNotice({ tone: 'error', text: '请完整填写产品名称、SKU 和价格。' }); try { const body = { ...form, unitPriceCents: Number(form.unitPriceCents), reorderLevel: Number(form.reorderLevel) }; await api(editing ? `/admin/products/${editing}` : '/admin/products', { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(body) }); setNotice({ tone: 'success', text: editing ? '产品已更新。' : '产品已新增。' }); setEditing(null); setForm(freshProduct()); void load(); } catch (e) { setNotice({ tone: 'error', text: errorText(e) }); } }; return <Shell user={user} route={route} logout={logout} title="产品管理" text="新增、编辑产品，并维护经销商价格和库存预警。"><Feedback notice={notice} /><section className="toolbar"><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索产品名称或 SKU" /><select value={active} onChange={(e) => setActive(e.target.value)}><option value="">全部状态</option><option value="true">已启用</option><option value="false">已停用</option></select><Button secondary onClick={() => { setEditing(null); setForm(freshProduct()); }}>新增产品</Button></section><form className="panel" onSubmit={submit}><h2>{editing ? '编辑产品' : '新增产品'}</h2><div className="form-layout"><label>产品名称<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label><label>SKU<input value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value.toUpperCase() })} /></label><label>产品版本<input value={form.productVersion} onChange={(e) => setForm({ ...form, productVersion: e.target.value })} /></label><label>产品规格<input value={form.specification} onChange={(e) => setForm({ ...form, specification: e.target.value })} /></label><label>经销商价格（分）<input type="number" min="0" value={form.unitPriceCents} onChange={(e) => setForm({ ...form, unitPriceCents: e.target.value })} /></label><label>库存预警值<input type="number" min="0" value={form.reorderLevel} onChange={(e) => setForm({ ...form, reorderLevel: e.target.value })} /></label><label>产品简介<textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label><label><input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} /> 启用产品</label></div><div className="action-list"><Button type="submit">保存</Button>{editing && <Button secondary onClick={() => { setEditing(null); setForm(freshProduct()); }}>取消编辑</Button>}</div></form>{!items ? <p>正在加载…</p> : items.length ? <div className="table-wrap"><table><thead><tr><th>产品</th><th>SKU</th><th>版本／规格</th><th>价格</th><th>库存</th><th>状态</th><th>更新时间</th><th>操作</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td>{item.name}</td><td>{item.sku}</td><td>{item.productVersion || '—'} / {item.specification || '—'}</td><td>{money(item.unitPriceCents)}</td><td>{item.availableQuantity} 可用 / {item.reservedQuantity} 预留</td><td>{item.isActive ? '已启用' : '已停用'}</td><td>{date(item.updatedAt)}</td><td><Button secondary onClick={() => edit(item)}>编辑</Button></td></tr>)}</tbody></table></div> : <Empty text="未找到符合条件的产品。" />}</Shell>; }

type Dealer = { id: string; code: string; name: string; province: string; authorizationType: string; contactName: string; serviceCenterName: string | null; status: string; storeCount: number; userCount: number; updatedAt: string };
const freshDealer = () => ({ code: '', name: '', province: '', authorizationType: '授权经销商', serviceCenterId: '', contactName: '', status: 'active' });
function Dealers({ user, route, logout }: Props) { const options = useOptions(); const [items, setItems] = useState<Dealer[] | null>(null); const [form, setForm] = useState(freshDealer()); const [editing, setEditing] = useState<string | null>(null); const [notice, setNotice] = useState<Notice>(null); const load = () => api<{ dealers: Dealer[] }>('/admin/dealers').then((data) => setItems(data.dealers)).catch((e) => setNotice({ tone: 'error', text: errorText(e) })); useEffect(() => { void load(); }, []); const submit = async (e: FormEvent) => { e.preventDefault(); if (!form.code || !form.name) return setNotice({ tone: 'error', text: '请填写经销商名称和编码。' }); try { await api(editing ? `/admin/dealers/${editing}` : '/admin/dealers', { method: editing ? 'PATCH' : 'POST', body: JSON.stringify({ ...form, serviceCenterId: form.serviceCenterId || null }) }); setNotice({ tone: 'success', text: '经销商资料已保存。' }); setEditing(null); setForm(freshDealer()); void load(); } catch (err) { setNotice({ tone: 'error', text: errorText(err) }); } }; const edit = async (id: string) => { const detail = await api<{ dealer: Dealer & { serviceCenterId: string | null } }>(`/admin/dealers/${id}`); setEditing(id); setForm({ code: detail.dealer.code, name: detail.dealer.name, province: detail.dealer.province, authorizationType: detail.dealer.authorizationType, serviceCenterId: detail.dealer.serviceCenterId || '', contactName: detail.dealer.contactName, status: detail.dealer.status }); }; return <Shell user={user} route={route} logout={logout} title="经销商管理" text="维护授权资格、服务中心关联与业务范围。"><Feedback notice={notice} /><section className="toolbar"><a className="button button--secondary" href="#/system/admin/stores">店铺管理</a><a className="button button--secondary" href="#/system/admin/users">编辑用户授权</a></section><form className="panel" onSubmit={submit}><h2>{editing ? '编辑经销商' : '新增经销商'}</h2><div className="form-layout"><label>经销商名称<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label><label>经销商编码<input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} /></label><label>省份<input value={form.province} onChange={(e) => setForm({ ...form, province: e.target.value })} /></label><label>授权类型<input value={form.authorizationType} onChange={(e) => setForm({ ...form, authorizationType: e.target.value })} /></label><label>关联授权服务中心<select value={form.serviceCenterId} onChange={(e) => setForm({ ...form, serviceCenterId: e.target.value })}><option value="">不关联</option>{options?.serviceCenters.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label>负责人<input value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} /></label><label>状态<select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}><option value="active">启用</option><option value="inactive">停用</option></select></label></div><Button type="submit">保存</Button></form>{!items ? <p>正在加载…</p> : <div className="table-wrap"><table><thead><tr><th>经销商</th><th>省份</th><th>授权类型</th><th>服务中心</th><th>店铺／用户</th><th>状态</th><th>操作</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td>{item.name}<br /><small>{item.code}</small></td><td>{item.province || '—'}</td><td>{item.authorizationType}</td><td>{item.serviceCenterName || '—'}</td><td>{item.storeCount} / {item.userCount}</td><td>{item.status === 'active' ? '已启用' : '已停用'}</td><td><Button secondary onClick={() => void edit(item.id)}>查看／编辑</Button></td></tr>)}</tbody></table></div>}</Shell>; }

type Store = { id: string; dealerId: string; code: string; name: string; platform: string; ownerUserId: string | null; ownerName: string | null; dealerName: string; status: string; updatedAt: string };
const freshStore = () => ({ dealerId: '', code: '', name: '', platform: '闲鱼', ownerUserId: '', status: 'active' });
function Stores({ user, route, logout }: Props) { const options = useOptions(); const [items, setItems] = useState<Store[] | null>(null); const [form, setForm] = useState(freshStore()); const [editing, setEditing] = useState<string | null>(null); const [notice, setNotice] = useState<Notice>(null); const load = () => api<{ stores: Store[] }>('/admin/stores').then((data) => setItems(data.stores)).catch((e) => setNotice({ tone: 'error', text: errorText(e) })); useEffect(() => { void load(); }, []); const submit = async (e: FormEvent) => { e.preventDefault(); if (!form.dealerId || !form.code || !form.name) return setNotice({ tone: 'error', text: '请完整填写店铺信息。' }); if (!editing && !form.ownerUserId) return setNotice({ tone: 'error', text: '新增店铺时请选择负责人。' }); try { const body = { ...form, ownerUserId: editing ? form.ownerUserId || null : form.ownerUserId }; await api(editing ? `/admin/stores/${editing}` : '/admin/stores', { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(body) }); setNotice({ tone: 'success', text: '店铺资料已保存。' }); setEditing(null); setForm(freshStore()); void load(); } catch (err) { setNotice({ tone: 'error', text: errorText(err) }); } }; const edit = (item: Store) => { setEditing(item.id); setForm({ dealerId: item.dealerId, code: item.code, name: item.name, platform: item.platform, ownerUserId: item.ownerUserId || '', status: item.status }); }; return <Shell user={user} route={route} logout={logout} title="店铺管理" text="维护店铺平台、负责人和所属经销商。"><Feedback notice={notice} /><form className="panel" onSubmit={submit}><h2>{editing ? '编辑店铺' : '新增店铺'}</h2><div className="form-layout"><label>店铺名称<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label><label>店铺编码<input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} /></label><label>所属经销商<select value={form.dealerId} onChange={(e) => setForm({ ...form, dealerId: e.target.value })}><option value="">请选择经销商</option>{options?.dealers.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label>平台<select value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })}>{platforms.map((item) => <option key={item}>{item}</option>)}</select></label><label>负责人<select value={form.ownerUserId} onChange={(e) => setForm({ ...form, ownerUserId: e.target.value })}><option value="">{editing ? '暂不设置' : '请选择负责人'}</option>{options?.users.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label>状态<select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}><option value="active">启用</option><option value="inactive">停用</option></select></label></div><Button type="submit">保存</Button></form>{!items ? <p>正在加载…</p> : <div className="table-wrap"><table><thead><tr><th>店铺</th><th>平台</th><th>所属经销商</th><th>负责人</th><th>状态</th><th>更新时间</th><th>操作</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td>{item.name}<br /><small>{item.code}</small></td><td>{item.platform}</td><td>{item.dealerName}</td><td>{item.ownerName || '—'}</td><td>{item.status === 'active' ? '已启用' : '已停用'}</td><td>{date(item.updatedAt)}</td><td><Button secondary onClick={() => edit(item)}>查看／编辑</Button></td></tr>)}</tbody></table></div>}</Shell>; }

type User = { id: string; email: string; name: string; isActive: number; watermarkEnabled: number; roles: string; createdAt: string };
type UserDetail = { user: User; roles: Array<{ id: string }>; dealers: Option[]; serviceCenters: Option[]; stores: Option[] };
function toggleId(values: string[], idValue: string, checked: boolean): string[] { return checked ? Array.from(new Set([...values, idValue])) : values.filter((item) => item !== idValue); }
function CheckList({ title, items, values, onChange }: { title: string; items: Option[]; values: string[]; onChange: (values: string[]) => void }) { return <fieldset><legend>{title}</legend>{items.length ? items.map((item) => <label key={item.id}><input type="checkbox" checked={values.includes(item.id)} onChange={(event) => onChange(toggleId(values, item.id, event.target.checked))} /> {item.name}</label>) : <p className="hint">暂无可选项。</p>}</fieldset>; }

type MailTemplateOption = { key: string; name: string; subject: string; description: string; isCustomized?: boolean; updatedAt?: string | null };
type MailCenterStatus = {
  provider: string;
  environment: string;
  resendConfigured: boolean;
  from: { name: string; address: string };
  replyTo: { name: string; address: string };
  domain: { status: string; detail: string };
  templates: MailTemplateOption[];
  recent: Array<{ id: string; provider: string; templateKey: string; subject: string; toEmail: string; fromEmail: string; replyToEmail: string; status: string; failureReason: string; providerMessageId: string; createdAt: string; sentAt: string | null }>;
};
type MailPreview = { template: string; subject: string; html: string; text: string; isCustomized?: boolean; updatedAt?: string | null };
function MailCenter({ user, route, logout }: Props) {
  const [status, setStatus] = useState<MailCenterStatus | null>(null);
  const [template, setTemplate] = useState('system_test');
  const [recipient, setRecipient] = useState('');
  const [preview, setPreview] = useState<MailPreview | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ subject: '', html: '', text: '' });
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api<MailCenterStatus>('/admin/mail-center/status').then(setStatus).catch((error) => setNotice({ tone: 'error', text: errorText(error) }));
  useEffect(() => { void load(); }, []);
  const loadPreview = async (nextTemplate = template) => {
    try {
      const result = await api<MailPreview>('/admin/mail-center/preview', { method: 'POST', body: JSON.stringify({ template: nextTemplate }) });
      setPreview(result);
      setDraft({ subject: result.subject, html: result.html, text: result.text });
    } catch (error) {
      setNotice({ tone: 'error', text: errorText(error) });
    }
  };
  useEffect(() => { setEditing(false); void loadPreview(template); }, [template]);
  const saveTemplate = async () => {
    if (!draft.subject.trim() || !draft.html.trim()) return setNotice({ tone: 'error', text: '请填写邮件主题和 HTML 内容。' });
    setBusy(true);
    try {
      const result = await api<MailPreview>(`/admin/mail-center/templates/${template}`, { method: 'PATCH', body: JSON.stringify(draft) });
      setPreview(result);
      setEditing(false);
      setNotice({ tone: 'success', text: '邮件模板已保存。' });
      await load();
    } catch (error) {
      setNotice({ tone: 'error', text: errorText(error) });
    } finally {
      setBusy(false);
    }
  };
  const resetTemplate = async () => {
    if (!window.confirm('确认恢复为系统默认模板吗？当前保存的模板内容会被移除。')) return;
    setBusy(true);
    try {
      const result = await api<MailPreview>(`/admin/mail-center/templates/${template}`, { method: 'DELETE' });
      setPreview(result);
      setDraft({ subject: result.subject, html: result.html, text: result.text });
      setEditing(false);
      setNotice({ tone: 'success', text: '已恢复系统默认模板。' });
      await load();
    } catch (error) {
      setNotice({ tone: 'error', text: errorText(error) });
    } finally {
      setBusy(false);
    }
  };
  const sendTest = async () => {
    if (!recipient.trim()) return setNotice({ tone: 'error', text: '请填写一个收件邮箱。' });
    setBusy(true);
    setNotice(null);
    try {
      const result = await api<{ status: string; providerMessageId: string; failureReason: string; subject: string }>('/admin/mail-center/test-send', { method: 'POST', body: JSON.stringify({ template, recipient, idempotencyKey: crypto.randomUUID() }) });
      setNotice({ tone: result.status === 'sent' ? 'success' : 'error', text: result.status === 'sent' ? `测试邮件已发送，Provider Message ID：${result.providerMessageId}` : `测试邮件未发送：${result.failureReason || '请检查 Resend 配置。'}` });
      await load();
    } catch (error) {
      setNotice({ tone: 'error', text: errorText(error) });
    } finally {
      setBusy(false);
    }
  };
  const currentTemplate = status?.templates.find((item) => item.key === template);
  return <Shell user={user} route={route} logout={logout} title="邮件中心" text="统一管理 MaxCINE 系统邮件模板、发送入口和发送记录。"><Feedback notice={notice} />{!status ? <p>正在加载邮件配置…</p> : <><section className="panel mail-center-overview"><div className="stats"><article className="stat"><p>当前 Provider</p><strong>{status.provider}</strong><span>{status.environment}</span></article><article className="stat"><p>Resend 状态</p><strong>{status.resendConfigured ? '已配置' : '缺少密钥'}</strong><span>{status.resendConfigured ? 'Cloudflare Secret 已存在' : '需要 RESEND_API_KEY'}</span></article><article className="stat"><p>域名验证</p><strong>{status.domain.status}</strong><span>{status.domain.detail}</span></article></div><dl className="detail-grid"><dt>From</dt><dd>{status.from.name} &lt;{status.from.address}&gt;</dd><dt>Reply-To</dt><dd>{status.replyTo.name} &lt;{status.replyTo.address}&gt;</dd></dl></section><section className="panel"><div className="panel-title"><h2>发送测试邮件</h2><span>一分钟最多三封</span></div><div className="form-layout"><label>模板<select value={template} onChange={(event) => setTemplate(event.target.value)}>{status.templates.map((item) => <option value={item.key} key={item.key}>{item.name}{item.isCustomized ? '（已编辑）' : ''}</option>)}</select><small>{currentTemplate?.description}</small>{currentTemplate?.updatedAt && <small>上次保存：{date(currentTemplate.updatedAt)}</small>}</label><label>收件人<input type="email" value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="一次只填写一个邮箱" /></label></div><div className="action-list"><Button disabled={busy} onClick={() => void sendTest()}>{busy ? '正在发送…' : '发送测试邮件'}</Button><Button secondary onClick={() => void loadPreview()}>刷新预览</Button><Button secondary onClick={() => setEditing((value) => !value)}>{editing ? '收起编辑' : '编辑模板'}</Button><Button secondary danger disabled={busy || !currentTemplate?.isCustomized} onClick={() => void resetTemplate()}>恢复系统默认</Button></div></section>{preview && <section className="panel"><div className="panel-title"><h2>邮件预览</h2><span>{editing ? draft.subject : preview.subject}{preview.isCustomized ? ' · 已使用保存模板' : ' · 系统默认模板'}</span></div>{editing && <div className="mail-template-editor"><label>邮件主题<input value={draft.subject} onChange={(event) => setDraft({ ...draft, subject: event.target.value })} /></label><label>HTML 内容<textarea value={draft.html} onChange={(event) => setDraft({ ...draft, html: event.target.value })} /></label><label>纯文本内容<textarea value={draft.text} onChange={(event) => setDraft({ ...draft, text: event.target.value })} /></label><div className="action-list"><Button disabled={busy} onClick={() => void saveTemplate()}>{busy ? '正在保存…' : '保存模板'}</Button><Button secondary onClick={() => { setDraft({ subject: preview.subject, html: preview.html, text: preview.text }); setEditing(false); }}>取消</Button></div><p className="hint">{"保存后，邮件中心预览、测试发送和售后报价发送都会优先使用当前模板。售后报价模板可使用变量：{{caseNumber}}、{{serialNumber}}、{{customerName}}、{{productName}}、{{diagnosisSummary}}、{{finalSolution}}、{{quoteItemsHtml}}、{{grandTotal}}。"}</p></div>}<div className="quote-preview-content mail-center-preview"><iframe key={`${template}-${editing ? draft.html : preview.html}`} title="邮件模板预览" srcDoc={editing ? draft.html : preview.html} /></div></section>}<section className="panel"><div className="panel-title"><h2>发送记录</h2><span>{status.recent.length} 条</span></div><div className="table-wrap"><table><thead><tr><th>时间</th><th>模板</th><th>收件人</th><th>主题</th><th>Provider</th><th>状态</th><th>Provider ID / 失败原因</th></tr></thead><tbody>{status.recent.map((item) => <tr key={item.id}><td>{date(item.createdAt)}</td><td>{item.templateKey}</td><td>{item.toEmail}</td><td>{item.subject}</td><td>{item.provider}</td><td>{item.status === 'sent' ? '已发送' : '失败'}</td><td>{item.providerMessageId || item.failureReason || '—'}</td></tr>)}{!status.recent.length && <tr><td colSpan={7}>暂无发送记录。</td></tr>}</tbody></table></div></section></>}</Shell>;
}

function Users({ user, route, logout }: Props) {
  const options = useOptions();
  const [items, setItems] = useState<User[] | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [selected, setSelected] = useState<User | null>(null);
  const [name, setName] = useState('');
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [dealerIds, setDealerIds] = useState<string[]>([]);
  const [serviceCenterIds, setServiceCenterIds] = useState<string[]>([]);
  const [storeIds, setStoreIds] = useState<string[]>([]);
  const [isActive, setIsActive] = useState(true);
  const [watermarkBusyId, setWatermarkBusyId] = useState<string | null>(null);
  const load = () => api<{ users: User[] }>('/admin/users').then((data) => setItems(data.users)).catch((e) => setNotice({ tone: 'error', text: errorText(e) }));
  useEffect(() => { void load(); }, []);
  const select = async (item: User) => {
    const detail = await api<UserDetail>(`/admin/users/${item.id}`);
    setSelected(item);
    setName(detail.user.name);
    setRoleIds(detail.roles.map((role) => role.id));
    setDealerIds(detail.dealers.map((dealer) => dealer.id));
    setServiceCenterIds(detail.serviceCenters.map((center) => center.id));
    setStoreIds(detail.stores.map((store) => store.id));
    setIsActive(Boolean(detail.user.isActive));
  };
  const save = async () => {
    if (!selected) return;
    if (!window.confirm('确认保存用户角色、账号状态和数据授权范围吗？保存后该用户现有登录状态将失效。')) return;
    try {
      await api(`/admin/users/${selected.id}`, { method: 'PATCH', body: JSON.stringify({ name, roleIds, dealerIds, serviceCenterIds, storeIds, isActive }) });
      setNotice({ tone: 'success', text: '用户权限和授权范围已更新，旧登录状态已失效。' });
      setSelected(null);
      void load();
    } catch (e) { setNotice({ tone: 'error', text: errorText(e) }); }
  };
  const reset = async () => {
    if (!selected) return;
    const nextPassword = window.prompt('请输入一次性临时密码（至少 12 位）：');
    if (!nextPassword) return;
    if (!window.confirm('确认重置该用户密码吗？')) return;
    try {
      await api(`/admin/users/${selected.id}/reset-password`, { method: 'POST', body: JSON.stringify({ nextPassword }) });
      setNotice({ tone: 'success', text: '密码已重置。请通过受控方式将临时密码告知用户。' });
    } catch (e) { setNotice({ tone: 'error', text: errorText(e) }); }
  };
  const updateWatermark = async (item: User, enabled: boolean) => {
    if (!window.confirm(`确认${enabled ? '开启' : '关闭'} ${item.name} 的页面水印吗？该员工需要重新登录。`)) return;
    setWatermarkBusyId(item.id);
    try {
      await api(`/admin/users/${item.id}/watermark`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
      setItems((current) => current?.map((row) => row.id === item.id ? { ...row, watermarkEnabled: Number(enabled) } : row) ?? null);
      setSelected((current) => current?.id === item.id ? { ...current, watermarkEnabled: Number(enabled) } : current);
      setNotice({ tone: 'success', text: `${item.name} 的页面水印已${enabled ? '开启' : '关闭'}，旧登录状态已失效。` });
    } catch (e) {
      setNotice({ tone: 'error', text: errorText(e) });
    } finally {
      setWatermarkBusyId(null);
    }
  };
  return <Shell user={user} route={route} logout={logout} title="用户与权限" text="查看角色、授权范围和员工页面水印；高风险操作会使旧登录状态失效。"><Feedback notice={notice} />{selected && <section className="panel"><h2>编辑用户：{selected.name}</h2><label>姓名<input value={name} onChange={(e) => setName(e.target.value)} /></label><fieldset><legend>角色</legend>{options?.roles.map((role) => <label key={role.id}><input type="checkbox" checked={roleIds.includes(role.id)} onChange={(e) => setRoleIds(toggleId(roleIds, role.id, e.target.checked))} /> {displayRoleLabel(role.code)}</label>)}</fieldset><div className="form-layout"><CheckList title="经销商授权" items={options?.dealers ?? []} values={dealerIds} onChange={setDealerIds} /><CheckList title="店铺授权" items={options?.stores ?? []} values={storeIds} onChange={setStoreIds} /><CheckList title="服务中心授权" items={options?.serviceCenters ?? []} values={serviceCenterIds} onChange={setServiceCenterIds} /></div><label><input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> 启用账号</label><div className="action-list"><Button onClick={() => void save()}>保存权限</Button><Button secondary onClick={() => void reset()}>重置密码</Button><Button danger onClick={() => { if (window.confirm('确认撤销该用户全部登录状态吗？')) void api(`/admin/users/${selected.id}/revoke-sessions`, { method: 'POST' }).then(() => setNotice({ tone: 'success', text: '已撤销全部登录状态。' })); }}>撤销全部会话</Button></div></section>}{!items ? <p>正在加载…</p> : <div className="table-wrap"><table><thead><tr><th>用户</th><th>邮箱</th><th>角色</th><th>账号状态</th><th>页面水印</th><th>创建时间</th><th>操作</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td>{item.name}</td><td>{item.email}</td><td>{roleListText(item.roles)}</td><td>{item.isActive ? '已启用' : '已停用'}</td><td><label className="watermark-toggle"><input type="checkbox" checked={Boolean(item.watermarkEnabled)} disabled={watermarkBusyId === item.id} onChange={(event) => void updateWatermark(item, event.target.checked)} /><span aria-hidden="true" /><b>{item.watermarkEnabled ? '已开启' : '已关闭'}</b></label></td><td>{date(item.createdAt)}</td><td><Button secondary onClick={() => void select(item)}>查看／编辑</Button></td></tr>)}</tbody></table></div>}</Shell>;
}

type ServiceCase = { id: string; caseNo: string; subject: string; productName: string | null; caseType: string; status: string; workflowStage: string; createdAt: string };
type ServiceDetail = { case: { id: string; caseNo: string; subject: string; dealerName: string; storeName: string | null; productName: string | null; serialNumber: string | null; description: string; status: string; workflowStage: string; serviceCenterId: string | null; serviceCenterName: string | null }; assessments: Array<{ result: string; details: string; actorName: string; assessedAt: string }>; recommendations: Array<{ recommendation: string; details: string; actorName: string; recommendedAt: string }> };
type ServiceCaseV2 = ServiceCase & { serviceStage: string; serialNumber: string | null; updatedAt: string };
type FaultChainView = { id: string; inspectionId: string; faultPart: string; damageType: string; causeType: string; derivedSymptomsJson: string; evidence: string; severity: string; repairability: string; recommendedAction: string; engineerNote: string };
type InspectionMaterialView = { id: string; inspectionId: string; materialId: string; materialCode: string; materialName: string; quantity: number; handlingMethod: string; unitPriceCents: number | null; serviceFeeCents: number | null; suggestedTotalCents: number | null; priceStatus: string; serviceFeeStatus: string; compatibilityStatus: string; compatibilityWarning: string; compatibilityOverrideReason: string; engineerNote: string };
type ServiceDetailV2 = {
  case: ServiceDetail['case'] & { assetId: string | null; serviceStage: string; caseType: string; customerNote: string; internalNote: string; contactName: string | null; contactPhone: string | null; contactEmail: string; contactAddress: string; orderNo: string | null; materialCode: string | null; productVersion: string | null; inboundCarrier: string; inboundTrackingNumber: string; inboundNote: string; outboundCarrier: string; outboundTrackingNumber: string; outboundSerialNumber: string; outboundShippedAt: string | null; outboundRecordedAt: string | null; outboundMailStatus: string; outboundMailFailureReason: string; adminReviewNote: string; finalDecision: string; createdAt: string; updatedAt: string };
  assessments: Array<{ result: string; details: string; actorName: string; assessedAt: string }>;
  recommendations: Array<{ recommendation: string; details: string; actorName: string; recommendedAt: string }>;
  attachments: Array<{ id: string; category: string; photoSlot: string; objectKey?: string; dataUrl?: string; originalFilename: string; contentType?: string; uploadedByName: string; createdAt: string }>;
  receipts: Array<{ receivedItemsJson: string; packagingIntact: number; packagingNote: string; itemsMatch: number; missingItemsNote: string; receiptNote: string; receivedByName: string; receivedAt: string }>;
  inspections: Array<{ id: string; version: number; faultReproduced: string; reproductionStatus: string; testResult: string; conclusion: string; faultCause: string; affectedParts: string; suggestedAction: string; suggestedParts: string; recommendWarranty: number; recommendCharge: number; engineerNote: string; difficulty: string; estimatedDays: string; accidentalDamage: number; accidentalDamageType: string; accidentalDamageNote: string; materialSuggestedTotalCents: number | null; status: string; submittedByName: string; submittedAt: string; reviewNote: string }>;
  faultChains: FaultChainView[];
  inspectionMaterials: InspectionMaterialView[];
  adminDamageReviews: Array<{ id: string; inspectionId: string; finalDecision: string; customerVisibleConclusion: string; finalTotalCents: number | null; createdAt: string }>;
  quotes: Array<{ id: string; quoteNo: string; version: number; finalDecision: string; totalCents: number; currency: string; status: string; workflowStatus: string; customerName: string; customerEmail: string; fromEmail: string; replyToEmail: string; validUntil: string; createdAt: string; confirmedAt: string | null; sentAt: string | null; emailStatus: string | null; emailFailureReason: string | null }>;
  timeline: Array<{ eventType: string; title: string; description: string; actorName: string | null; createdAt: string }>;
};
const serviceStageText: Record<string, string> = { PENDING_ADMIN_REVIEW: '待审核', NEEDS_MORE_INFO: '已退回补充', WAITING_CUSTOMER_SHIPMENT: '待客户寄修', WAITING_SERVICE_CENTER_RECEIPT: '待服务中心收货', WAITING_INSPECTION: '待检测', INSPECTION_IN_PROGRESS: '检测中', PENDING_ADMIN_INSPECTION_REVIEW: '待出报价', INSPECTION_RETURNED: '检测结果退回', PENDING_QUOTE: '待出报价', WAITING_CUSTOMER_CONFIRMATION: '等待客户确认', READY_FOR_PROCESSING: '待处理', WAITING_PAYMENT_CONFIRMATION: '确认收款', WAITING_REPAIR_SHIPMENT: '待维修及发货', RETURN_SHIPPED: '售后已发货', CLOSED: '已关闭' };
const serviceProgressSteps = [
  { key: 'review', label: '管理员审核', stages: ['PENDING_ADMIN_REVIEW', 'NEEDS_MORE_INFO'] },
  { key: 'ship_in', label: '客户寄修', stages: ['WAITING_CUSTOMER_SHIPMENT', 'WAITING_SERVICE_CENTER_RECEIPT'] },
  { key: 'inspect', label: '服务中心检测', stages: ['WAITING_INSPECTION', 'INSPECTION_IN_PROGRESS', 'INSPECTION_RETURNED'] },
  { key: 'quote', label: '报价确认', stages: ['PENDING_ADMIN_INSPECTION_REVIEW', 'PENDING_QUOTE', 'WAITING_CUSTOMER_CONFIRMATION', 'WAITING_PAYMENT_CONFIRMATION'] },
  { key: 'repair', label: '处理/维修', stages: ['READY_FOR_PROCESSING', 'WAITING_REPAIR_SHIPMENT'] },
  { key: 'ship_out', label: '售后发货', stages: ['RETURN_SHIPPED', 'CLOSED'] }
] as const;
function serviceProgressIndex(stage: string) {
  const found = serviceProgressSteps.findIndex((step) => (step.stages as readonly string[]).includes(stage));
  return found >= 0 ? found : 0;
}
const caseTypeText: Record<string, string> = { OUT_OF_WARRANTY_REPAIR: '保外维修类', INSTALLATION_ISSUE: '安装异常类', QUALITY_ISSUE: '质量问题类', IMAGE_QUALITY_ISSUE: '拍摄效果类', MISSING_ACCESSORY: '缺少配件类', PART_PURCHASE: '单独购买部件类' };
const afterSalesPhotoText: Record<string, string> = {
  customer_problem_photo: '客户问题照片',
  package_label: '外包装及面单照片',
  received_items_front: '全部物品正面照片',
  received_items_back: '全部物品反面照片',
  product_front: '产品正面照片',
  product_back: '产品背面照片',
  product_left: '产品左侧照片',
  product_right: '产品右侧照片',
  product_top: '产品顶部照片',
  product_bottom: '产品底部照片',
  accidental_damage: '意外损坏照片',
  inspection_other: '其他检测照片'
};
const afterSalesPhotoSlotText: Record<string, string> = {
  outbound_product_front: '售后发货产品正面照片',
  outbound_product_back: '售后发货产品背面照片',
  outbound_all_items: '售后发货全部物品照片'
};
const afterSalesPhotoOrder = ['customer_problem_photo', 'package_label', 'received_items_front', 'received_items_back', 'product_front', 'product_back', 'product_left', 'product_right', 'product_top', 'product_bottom', 'accidental_damage', 'inspection_other'];
const outboundPhotoSlots = [
  { slot: 'outbound_product_front', label: '产品正面照片' },
  { slot: 'outbound_product_back', label: '产品背面照片' },
  { slot: 'outbound_all_items', label: '全部物品照片' }
] as const;
type OutboundPhotoDraft = { slot: (typeof outboundPhotoSlots)[number]['slot']; originalFilename: string; contentType: 'image/png' | 'image/jpeg' | 'image/webp'; dataUrl: string };
const finalDecisionOptions = ['保修内免费处理', '保外收费维修', '收费更换部件', '单独销售部件', '无故障退回', '拒绝保修', '整机更换', '其他'];
type QuoteItemDraft = { itemName: string; itemType: string; quantity: string; unitPrice: string; serviceFee: string; discount: string; note: string; customerNote: string; materialId?: string; materialCode?: string; quickFeeCode?: string };
const freshQuoteItem = (): QuoteItemDraft => ({ itemName: '维修服务', itemType: '维修费', quantity: '1', unitPrice: '0', serviceFee: '0', discount: '0', note: '', customerNote: '' });
const quoteItemFromMaterial = (item: InspectionMaterialView): QuoteItemDraft => ({ itemName: item.materialName, itemType: '维修物料', quantity: String(item.quantity), unitPrice: String((item.unitPriceCents ?? 0) / 100), serviceFee: String((item.serviceFeeCents ?? 0) / 100), discount: '0', note: [item.priceStatus !== 'available' && item.priceStatus !== 'zero' ? '物料价格需管理员确认' : '', !['fixed', 'zero', 'included', 'version_rule'].includes(item.serviceFeeStatus) ? '服务费需管理员确认' : '', item.compatibilityWarning || '', item.engineerNote || ''].filter(Boolean).join('；'), customerNote: '', materialId: item.materialId, materialCode: item.materialCode });
type RepairMaterialChoice = { id: string; materialCode: string | null; materialName: string; applicableModels: string; outOfWarrantyPriceCents: number | null; priceStatus: string; calculatedServiceFeeCents: number | null; calculatedServiceFeeStatus: string; warrantyPolicy: string; warrantyDays: number | null; sourceNote: string; compatibilityStatus: string; compatibilityWarning: string };
const quoteItemFromCatalogMaterial = (item: RepairMaterialChoice): QuoteItemDraft => ({ itemName: item.materialName, itemType: '维修物料', quantity: '1', unitPrice: String((item.outOfWarrantyPriceCents ?? 0) / 100), serviceFee: String((item.calculatedServiceFeeCents ?? 0) / 100), discount: '0', note: [item.priceStatus !== 'available' && item.priceStatus !== 'zero' ? '物料价格需管理员确认' : '', !['fixed', 'zero', 'included', 'version_rule'].includes(item.calculatedServiceFeeStatus) ? '服务费需管理员确认' : '', item.compatibilityWarning || '', item.sourceNote || ''].filter(Boolean).join('；'), customerNote: '', materialId: item.id, materialCode: item.materialCode || '' });
const quickServiceFees = [
  { code: 'L0', name: '基础排查费（换货，整体替换）', priceYuan: 0 },
  { code: 'L1', name: '服务费一级检测费', priceYuan: 80 },
  { code: 'L2', name: '服务费二级维修费', priceYuan: 100 },
  { code: 'L3', name: '服务费三级维修费', priceYuan: 120 }
] as const;
const quoteQuickPhrases = [
  '经检测，定损结果为：',
  'xx组件收到xx作用，造成xx类衍生故障，在/不再保修范围内，提供/免费付费处理。',
  '由于该故障不在我们的售后政策内，如果您放弃维修，本次检测将收取 80 CNY 诊断费。为减少服务中心库存压力，如在 30 日内我们没有收到您选择的服务方案，我们将对产品环保回收处理。如果再次将此产品寄回进行同类型维修，诊断费用可能还会增加，不便之处，敬请谅解。',
  '为更快速的处理您的维修案例，保障您的使用体验，本次维修，您只需支付相应部件损坏的维修费用即可享受产品替换服务（替换的产品是按照全新品标准生产的非零售产品），替换后故障产品将由 MaxCINE 回收不做退回。',
  '买家反馈的画面边缘变形属于广角光学系统常见的“桶形畸变（Barrel Distortion）”。桶形畸变属于广角镜头及增广镜扩大视场角过程中产生的正常光学成像特性，并非镜片制造缺陷。该产品属于增广镜，通过增加视场角来实现更广的拍摄范围。根据光学成像原理，在扩大视角的同时，画面边缘可能出现一定程度的桶形畸变，这是行业普遍存在的光学现象，无法完全避免，不影响产品正常使用。经对照产品设计标准及出厂测试标准，产品成像表现符合设计要求，与商品详情页售前说明一致。',
  '产品外观未发现影响正常使用及光学性能的制造质量缺陷，买家所述外观问题不影响产品功能及性能。',
  '经检测，本次用户反馈的问题均未发现属于产品制造质量缺陷，不符合质量问题退换货条件，建议正常使用。产品具有唯一产品序列号，可通过 MaxCINE 官方渠道查询产品真伪及保修信息。'
] as const;
const quoteItemFromQuickFee = (item: (typeof quickServiceFees)[number]): QuoteItemDraft => ({ itemName: `${item.name}（${item.code}）`, itemType: '服务费', quantity: '1', unitPrice: String(item.priceYuan), serviceFee: '0', discount: '0', note: '', customerNote: item.priceYuan === 0 ? '免费' : '', quickFeeCode: item.code });
type QuotePreview = {
  quote: {
    id: string; quoteNo: string; caseId: string; caseNo: string; version: number; workflowStatus: string; customerName: string; customerEmail: string;
    totalCents: number; currency: string; validUntil: string; createdAt: string; updatedAt: string; confirmedAt: string | null; sentAt: string | null;
    fromEmail: string; replyToEmail: string; htmlContent: string; emailText: string; pdfObjectKey: string | null;
    snapshot: { diagnosisSummary?: string; finalSolution?: string; estimatedCycle?: string; customerNote?: string; quoteItems?: unknown[] };
  };
  items: Array<{ id: string; itemName: string; itemType: string; quantity: number; unitPriceCents: number; serviceFeeCents: number; discountCents: number; subtotalCents: number; materialId?: string; materialCode: string; customerNote: string }>;
  emails: Array<{ id: string; toEmail: string; fromEmail: string; replyToEmail: string; subject: string; status: string; failureReason: string; provider: string; providerMessageId: string; attemptNo: number; sentAt: string | null; createdAt: string }>;
};
const quoteWorkflowText: Record<string, string> = { DRAFT: '草稿', READY_FOR_REVIEW: '待预览确认', SENDING: '发送中', SENT: '已发送', SEND_FAILED: '发送失败', SUPERSEDED: '已被新版本替代', CANCELLED: '已取消' };

function RepairMaterialsPanel({ notice }: { notice: (value: Notice) => void }) {
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [rows, setRows] = useState<RepairMaterialChoice[] | null>(null);
  useEffect(() => {
    void api<{ materials: RepairMaterialChoice[] }>(`/repair-materials?q=${encodeURIComponent(query)}&showAll=${showAll}`)
      .then((data) => setRows(data.materials))
      .catch((error) => notice({ tone: 'error', text: errorText(error) }));
  }, [query, showAll, notice]);
  return <section className="panel">
    <div className="panel-title"><h2>售后物料</h2><span>查看售后物料、保外价格和服务费规则。</span></div>
    <div className="toolbar"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索料号、物料名称或备注" /><label><input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} /> 显示停用或异常物料</label></div>
    {!rows && <p>正在加载…</p>}
    {rows && <div className="table-wrap"><table><thead><tr><th>料号</th><th>物料名称</th><th>适用型号</th><th>保外价格</th><th>服务费</th><th>保修规则</th><th>备注</th></tr></thead><tbody>{rows.map((item) => <tr key={item.id}><td>{item.materialCode || '缺料号'}</td><td>{item.materialName}</td><td>{item.applicableModels || '需确认'}</td><td>{money(item.outOfWarrantyPriceCents)}<br /><small>{item.priceStatus}</small></td><td>{money(item.calculatedServiceFeeCents)}<br /><small>{item.calculatedServiceFeeStatus}</small></td><td>{item.warrantyPolicy || (item.warrantyDays ? `${item.warrantyDays}天` : '需确认')}</td><td>{item.sourceNote || '—'}</td></tr>)}</tbody></table>{!rows.length && <p>暂无匹配物料。</p>}</div>}
  </section>;
}

function AfterSalesV2({ user, route, logout }: Props) {
  const options = useOptions();
  const [items, setItems] = useState<ServiceCaseV2[] | null>(null);
  const [selected, setSelected] = useState<ServiceDetailV2 | null>(null);
  const [stage, setStage] = useState(new URLSearchParams(route.split('?')[1] ?? '').get('stage') ?? 'PENDING_ADMIN_REVIEW');
  const [notice, setNotice] = useState<Notice>(null);
  const [showMaterials, setShowMaterials] = useState(false);
  const [centerId, setCenterId] = useState('');
  const [requiresShipment, setRequiresShipment] = useState(true);
  const [reviewNote, setReviewNote] = useState('');
  const [reviewContactName, setReviewContactName] = useState('');
  const [reviewContactPhone, setReviewContactPhone] = useState('');
  const [reviewContactEmail, setReviewContactEmail] = useState('');
  const [reviewContactAddress, setReviewContactAddress] = useState('');
  const [inboundCarrier, setInboundCarrier] = useState('顺丰速运');
  const [inboundTracking, setInboundTracking] = useState('');
  const [inspectionNote, setInspectionNote] = useState('');
  const [finalDecision, setFinalDecision] = useState('保外收费维修');
  const [quoteSummary, setQuoteSummary] = useState('');
  const [quoteValidUntil, setQuoteValidUntil] = useState(() => new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10));
  const [quoteCycle, setQuoteCycle] = useState('3-7 个工作日');
  const [quoteItems, setQuoteItems] = useState<QuoteItemDraft[]>([]);
  const [engineerMaterialIds, setEngineerMaterialIds] = useState<string[]>([]);
  const [catalogMaterials, setCatalogMaterials] = useState<RepairMaterialChoice[]>([]);
  const [catalogMaterialIds, setCatalogMaterialIds] = useState<string[]>([]);
  const [catalogSearch, setCatalogSearch] = useState('');
  const [catalogShowAll, setCatalogShowAll] = useState(false);
  const [quoteActionMessage, setQuoteActionMessage] = useState('');
  const [activeQuoteId, setActiveQuoteId] = useState<string | null>(null);
  const [quotePreview, setQuotePreview] = useState<QuotePreview | null>(null);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [confirmSendOpen, setConfirmSendOpen] = useState(false);
  const [quoteRecipientEmail, setQuoteRecipientEmail] = useState('');
  const [photoViewer, setPhotoViewer] = useState<{ url: string; title: string } | null>(null);
  const [outboundCarrier, setOutboundCarrier] = useState('顺丰速运');
  const [outboundTracking, setOutboundTracking] = useState('');
  const [outboundSerial, setOutboundSerial] = useState('');
  const [outboundRecipientEmail, setOutboundRecipientEmail] = useState('');
  const [outboundPhotos, setOutboundPhotos] = useState<Partial<Record<OutboundPhotoDraft['slot'], OutboundPhotoDraft>>>({});
  const [outboundBusy, setOutboundBusy] = useState(false);
  const load = () => api<{ cases: ServiceCaseV2[] }>('/after-sales?limit=100').then((data) => setItems(data.cases)).catch((error) => setNotice({ tone: 'error', text: errorText(error) }));
  const open = async (caseId: string) => {
    try {
      const detail = await api<ServiceDetailV2>(`/after-sales/${caseId}`);
      setSelected(detail);
      setCenterId(detail.case.serviceCenterId || '');
      setReviewContactName(detail.case.contactName || '');
      setReviewContactPhone(detail.case.contactPhone || '');
      setReviewContactEmail(detail.case.contactEmail || '');
      setReviewContactAddress(detail.case.contactAddress || '');
      setInboundCarrier(detail.case.inboundCarrier || '顺丰速运');
      setInboundTracking(detail.case.inboundTrackingNumber || '');
      setFinalDecision(detail.case.finalDecision || '保外收费维修');
      setQuoteSummary(detail.inspections[0]?.conclusion || detail.case.description);
      setQuoteItems([]);
      setEngineerMaterialIds([]);
      setCatalogMaterialIds([]);
      setCatalogSearch('');
      setCatalogShowAll(false);
      setQuoteActionMessage('');
      setActiveQuoteId(null);
      setQuotePreview(null);
      setConfirmSendOpen(false);
      setQuoteRecipientEmail('');
      setPhotoViewer(null);
      setOutboundCarrier(detail.case.outboundCarrier || '顺丰速运');
      setOutboundTracking(detail.case.outboundTrackingNumber || '');
      setOutboundSerial(detail.case.outboundSerialNumber || detail.case.serialNumber || '');
      setOutboundRecipientEmail(detail.case.contactEmail || '');
      setOutboundPhotos({});
    } catch (error) {
      setNotice({ tone: 'error', text: errorText(error) });
    }
  };
  useEffect(() => { void load(); const idFromUrl = new URLSearchParams(route.split('?')[1] ?? '').get('caseId'); if (idFromUrl) void open(idFromUrl); }, []);
  const selectedAssetId = selected?.case.assetId ?? '';
  useEffect(() => {
    if (!selected || !['PENDING_QUOTE', 'PENDING_ADMIN_INSPECTION_REVIEW'].includes(selected.case.serviceStage)) {
      setCatalogMaterials([]);
      return;
    }
    void api<{ materials: RepairMaterialChoice[] }>(`/repair-materials?assetId=${encodeURIComponent(selectedAssetId)}&q=${encodeURIComponent(catalogSearch)}&showAll=${catalogShowAll}`)
      .then((data) => setCatalogMaterials(data.materials))
      .catch((error) => setNotice({ tone: 'error', text: errorText(error) }));
  }, [selected?.case.id, selectedAssetId, catalogSearch, catalogShowAll]);
  const filtered = items?.filter((item) => stage === 'all' || item.serviceStage === stage || (stage === 'PENDING_QUOTE' && item.serviceStage === 'PENDING_ADMIN_INSPECTION_REVIEW')) ?? [];
  const latestInspection = selected?.inspections[0] ?? null;
  const latestMaterials = latestInspection && selected ? selected.inspectionMaterials.filter((item) => item.inspectionId === latestInspection.id) : [];
  const photoUrl = (attachment: ServiceDetailV2['attachments'][number]) =>
    attachment.dataUrl || `${apiBaseUrl}/after-sales/${selected?.case.id}/attachments/${attachment.id}/content`;
  const groupedPhotos = selected ? [...selected.attachments].sort((a, b) => {
    const byCategory = afterSalesPhotoOrder.indexOf(a.category) - afterSalesPhotoOrder.indexOf(b.category);
    if (byCategory !== 0) return byCategory;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  }) : [];
  const catalogChoices = catalogMaterials.filter((item) => !latestMaterials.some((material) => material.materialId === item.id));
  const selectedEngineerMaterials = latestMaterials.filter((item) => engineerMaterialIds.includes(item.id));
  const selectedCatalogMaterials = catalogChoices.filter((item) => catalogMaterialIds.includes(item.id));
  const engineerSelectionTotalCents = selectedEngineerMaterials.reduce((sum, item) => sum + (item.suggestedTotalCents ?? 0), 0);
  const engineerSelectionPendingCount = selectedEngineerMaterials.filter((item) => item.suggestedTotalCents === null).length;
  const catalogSelectionTotalCents = selectedCatalogMaterials.reduce((sum, item) => sum + (item.outOfWarrantyPriceCents ?? 0) + (item.calculatedServiceFeeCents ?? 0), 0);
  const catalogSelectionPendingCount = selectedCatalogMaterials.filter((item) => item.outOfWarrantyPriceCents === null || (item.calculatedServiceFeeCents === null && item.calculatedServiceFeeStatus !== 'included')).length;
  const cameraWatermarkLines = ['山东省服务中心', `工号 ${employeeNumberForUser(user) ?? '9353'}`];
  const appendQuoteItems = (rows: QuoteItemDraft[]) => setQuoteItems((current) => {
    const nextIds = new Set(rows.map((item) => item.materialId).filter(Boolean));
    return [...current.filter((item) => !item.materialId || !nextIds.has(item.materialId)), ...rows];
  });
  const addEngineerMaterialsToQuote = () => {
    const rows = selectedEngineerMaterials.map(quoteItemFromMaterial);
    if (!rows.length) {
      setQuoteActionMessage('请先在工程师建议中勾选最终采用的物料。');
      return setNotice({ tone: 'error', text: '请先在工程师建议中勾选最终采用的物料。' });
    }
    appendQuoteItems(rows);
    setQuoteActionMessage(`已将 ${rows.length} 项工程师建议加入最终报价，可在下方继续调整数量和价格。`);
    setNotice({ tone: 'success', text: '已将勾选的工程师建议物料加入最终报价项。' });
  };
  const addCatalogMaterialsToQuote = () => {
    const rows = selectedCatalogMaterials.map(quoteItemFromCatalogMaterial);
    if (!rows.length) {
      setQuoteActionMessage('请先在其他售后物料中勾选最终采用的物料。');
      return setNotice({ tone: 'error', text: '请先在其他可选物料中勾选最终采用的物料。' });
    }
    appendQuoteItems(rows);
    setQuoteActionMessage(`已将 ${rows.length} 项其他售后物料加入最终报价，可在下方继续调整。`);
    setNotice({ tone: 'success', text: '已将勾选的其他物料加入最终报价项。' });
  };
  const addQuickServiceFee = (item: (typeof quickServiceFees)[number]) => {
    setQuoteItems((current) => [...current.filter((row) => !row.quickFeeCode), quoteItemFromQuickFee(item)]);
    setQuoteActionMessage(`已加入 ${item.name}（${item.code}），${item.priceYuan === 0 ? '费用为免费' : `费用为 ¥${item.priceYuan.toFixed(2)}`}。`);
  };
  const updateQuoteItem = (index: number, patch: Partial<QuoteItemDraft>) => setQuoteItems((rows) => rows.map((row, i) => i === index ? { ...row, ...patch } : row));
  const centsFromYuan = (value: string) => {
    const amount = Number(value || 0);
    return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
  };
  const quoteItemSubtotalCents = (item: QuoteItemDraft) => {
    const quantity = Number(item.quantity || 0);
    return (Number.isFinite(quantity) ? quantity : 0) * centsFromYuan(item.unitPrice) + centsFromYuan(item.serviceFee || '0') - centsFromYuan(item.discount || '0');
  };
  const quoteSubtotalBeforeDiscountCents = quoteItems.reduce((sum, item) => sum + Number(item.quantity || 0) * centsFromYuan(item.unitPrice) + centsFromYuan(item.serviceFee || '0'), 0);
  const quoteDiscountCents = quoteItems.reduce((sum, item) => sum + centsFromYuan(item.discount || '0'), 0);
  const quoteTotalCents = quoteItems.reduce((sum, item) => sum + quoteItemSubtotalCents(item), 0);
  const adminReview = async (accepted: boolean) => {
    if (!selected) return;
    if (!accepted && reviewNote.trim().length < 2) return setNotice({ tone: 'error', text: '不受理时必须填写原因。' });
    if (accepted && requiresShipment && !centerId) return setNotice({ tone: 'error', text: '需要寄修时必须选择授权服务中心。' });
    try {
      await api(`/after-sales/${selected.case.id}/admin-review`, { method: 'POST', body: JSON.stringify({ accepted, reason: reviewNote, serviceCenterId: centerId || null, requiresShipment, internalNote: reviewNote, contactName: reviewContactName, contactPhone: reviewContactPhone, contactEmail: reviewContactEmail, contactAddress: reviewContactAddress }) });
      setNotice({ tone: 'success', text: accepted ? '工单已受理。' : '工单已退回补充。' });
      await open(selected.case.id);
      void load();
    } catch (error) {
      setNotice({ tone: 'error', text: errorText(error) });
    }
  };
  const saveInbound = async () => {
    if (!selected || inboundTracking.trim().length < 3) return setNotice({ tone: 'error', text: '请填写寄修快递单号。' });
    try {
      await api(`/after-sales/${selected.case.id}/inbound-shipment`, { method: 'POST', body: JSON.stringify({ carrier: inboundCarrier, trackingNumber: inboundTracking, note: '' }) });
      setNotice({ tone: 'success', text: '寄修单号已保存。' });
      await open(selected.case.id);
      void load();
    } catch (error) {
      setNotice({ tone: 'error', text: errorText(error) });
    }
  };
  const confirmPayment = async () => {
    if (!selected) return;
    try {
      await api(`/after-sales/${selected.case.id}/payment/confirm`, { method: 'POST' });
      setNotice({ tone: 'success', text: '已确认收款，工单已进入待维修及发货流程。' });
      await open(selected.case.id);
      void load();
    } catch (error) {
      setNotice({ tone: 'error', text: errorText(error) });
    }
  };
  const readOutboundPhoto = (slot: OutboundPhotoDraft['slot'], file: File | undefined) => {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return setNotice({ tone: 'error', text: '发货照片仅支持 PNG、JPG 或 WebP 图片。' });
    const reader = new FileReader();
    reader.onload = () => {
      setOutboundPhotos((current) => ({
        ...current,
        [slot]: { slot, originalFilename: file.name || `${slot}.jpg`, contentType: file.type as OutboundPhotoDraft['contentType'], dataUrl: String(reader.result || '') }
      }));
    };
    reader.onerror = () => setNotice({ tone: 'error', text: '图片读取失败，请重新选择。' });
    reader.readAsDataURL(file);
  };
  const submitOutboundShipment = async () => {
    if (!selected) return;
    const photos = outboundPhotoSlots.map((item) => outboundPhotos[item.slot]).filter(Boolean) as OutboundPhotoDraft[];
    if (photos.length !== outboundPhotoSlots.length) return setNotice({ tone: 'error', text: '请上传三张发货照片：产品正面、产品背面、全部物品。' });
    setOutboundBusy(true);
    try {
      const result = await api<{ serviceStage: string; mailStatus: string; failureReason: string }>(`/after-sales/${selected.case.id}/outbound-shipment`, {
        method: 'POST',
        body: JSON.stringify({ carrier: outboundCarrier, trackingNumber: outboundTracking, serialNumber: outboundSerial, recipientEmail: outboundRecipientEmail, photos })
      });
      const text = result.mailStatus === 'sent'
        ? '售后发货已记录，发货邮件已发送给客户。'
        : `售后发货已记录，但发货邮件发送失败：${result.failureReason || '请检查邮件配置。'}`;
      setNotice({ tone: result.mailStatus === 'sent' ? 'success' : 'error', text });
      await open(selected.case.id);
      void load();
    } catch (error) {
      setNotice({ tone: 'error', text: errorText(error) });
    } finally {
      setOutboundBusy(false);
    }
  };
  const quotePayload = (workflowStatus: 'DRAFT' | 'READY_FOR_REVIEW') => ({ inspectionSummary: quoteSummary, finalDecision, validUntil: quoteValidUntil, estimatedCycle: quoteCycle, paymentInstructions: '如需确认本报告，请通过 MaxCINE 客户支持渠道联系我们。', note: '', workflowStatus, items: quoteItems.map((item) => ({ itemName: item.itemName, itemType: item.itemType, quantity: Number(item.quantity), unitPriceCents: centsFromYuan(item.unitPrice), serviceFeeCents: Math.max(0, centsFromYuan(item.serviceFee || '0')), discountCents: Math.max(0, centsFromYuan(item.discount || '0')), materialId: item.materialId, materialCode: item.materialCode || '', customerNote: item.customerNote, note: item.note })) });
  const loadQuotePreview = async (quoteId: string, loadIntoForm = false) => {
    const detail = await api<QuotePreview>(`/after-sales-quotes/${quoteId}`);
    setQuotePreview(detail);
    setQuoteRecipientEmail(detail.quote.customerEmail || '');
    if (loadIntoForm && ['DRAFT', 'READY_FOR_REVIEW'].includes(detail.quote.workflowStatus)) {
      setActiveQuoteId(detail.quote.id);
      setQuoteSummary(detail.quote.snapshot.diagnosisSummary || '');
      setFinalDecision(detail.quote.snapshot.finalSolution || '保外收费维修');
      setQuoteValidUntil(detail.quote.validUntil);
      setQuoteCycle(detail.quote.snapshot.estimatedCycle || '');
      setQuoteItems(detail.items.map((item) => ({ itemName: item.itemName, itemType: item.itemType, quantity: String(item.quantity), unitPrice: String(item.unitPriceCents / 100), serviceFee: String((item.serviceFeeCents ?? 0) / 100), discount: String((item.discountCents ?? 0) / 100), note: '', customerNote: item.customerNote || '', materialId: item.materialId, materialCode: item.materialCode || '' })));
    }
    return detail;
  };
  const saveQuote = async (workflowStatus: 'DRAFT' | 'READY_FOR_REVIEW' = 'READY_FOR_REVIEW', showPreview = true) => {
    if (!selected) return;
    if (!quoteItems.length) return setNotice({ tone: 'error', text: '请先从工程师建议或其他可选物料中勾选最终采用项，或增加手工费用项。' });
    if (quoteItems.some((item) => !item.itemName.trim() || Number(item.quantity) < 1)) return setNotice({ tone: 'error', text: '请完整填写报价项目名称和数量。' });
    setQuoteBusy(true);
    try {
      if (latestInspection) await api(`/after-sales/${selected.case.id}/admin-damage-review`, { method: 'POST', body: JSON.stringify({ inspectionId: latestInspection.id, finalDecision, customerVisibleConclusion: quoteSummary, internalNote: inspectionNote, finalFaultChains: selected.faultChains.filter((item) => item.inspectionId === latestInspection.id), finalMaterials: quoteItems.filter((item) => item.materialId || item.materialCode || ['维修物料', '更换组件'].includes(item.itemType)).map((item) => ({ materialId: item.materialId, materialCode: item.materialCode || '', materialName: item.itemName, quantity: Number(item.quantity), unitPriceCents: Math.max(0, centsFromYuan(item.unitPrice)), serviceFeeCents: Math.max(0, centsFromYuan(item.serviceFee || '0')), discountCents: Math.max(0, centsFromYuan(item.discount || '0')), customerNote: item.customerNote })) }) });
      const result = await api<{ id: string; quoteNo: string; version: number; workflowStatus: string }>(activeQuoteId ? `/after-sales-quotes/${activeQuoteId}` : `/after-sales/${selected.case.id}/quotes`, { method: activeQuoteId ? 'PATCH' : 'POST', body: JSON.stringify(quotePayload(workflowStatus)) });
      setActiveQuoteId(result.id);
      const detail = await loadQuotePreview(result.id);
      if (!showPreview) setQuotePreview(null);
      setNotice({ tone: 'success', text: workflowStatus === 'DRAFT' ? `报价 ${result.quoteNo} 已保存为草稿，尚未发送。` : `报价 ${result.quoteNo} 已生成，请预览并人工确认后发送。` });
      setActiveQuoteId(result.id);
      if (showPreview) setQuotePreview(detail);
      void load();
    } catch (error) {
      setNotice({ tone: 'error', text: errorText(error) });
    } finally {
      setQuoteBusy(false);
    }
  };
  const confirmQuoteSend = async () => {
    if (!quotePreview) return;
    if (!quoteRecipientEmail.trim()) return setNotice({ tone: 'error', text: '请先填写本次收件邮箱。' });
    setQuoteBusy(true);
    try {
      const result = await api<{ workflowStatus: string; failureReason: string }>(`/after-sales-quotes/${quotePreview.quote.id}/confirm-send`, { method: 'POST', body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), recipientEmail: quoteRecipientEmail }) });
      setConfirmSendOpen(false);
      if (selected) await open(selected.case.id);
      await loadQuotePreview(quotePreview.quote.id);
      const successText = quotePreview.quote.totalCents <= 0
        ? '报价已锁定并发送至客户邮箱。金额为 0 元，工单已自动进入待处理流程。'
        : '报价已锁定并发送至客户邮箱。请在客户付款后由管理员确认收款。';
      setNotice({ tone: result.workflowStatus === 'SENT' ? 'success' : 'error', text: result.workflowStatus === 'SENT' ? successText : `报价已锁定，但发送失败：${result.failureReason || '请检查邮件配置后重试。'}` });
    } catch (error) {
      setNotice({ tone: 'error', text: errorText(error) });
    } finally {
      setQuoteBusy(false);
    }
  };
  const createNewQuoteVersion = async () => {
    if (!quotePreview) return;
    setQuoteBusy(true);
    try {
      const result = await api<{ id: string; quoteNo: string }>(`/after-sales-quotes/${quotePreview.quote.id}/new-version`, { method: 'POST' });
      if (selected) await open(selected.case.id);
      await loadQuotePreview(result.id, true);
      setQuotePreview(null);
      setNotice({ tone: 'success', text: `已创建新版本 ${result.quoteNo}，可修改后重新预览。` });
      setActiveQuoteId(result.id);
    } catch (error) {
      setNotice({ tone: 'error', text: errorText(error) });
    } finally {
      setQuoteBusy(false);
    }
  };
  return <Shell user={user} route={route} logout={logout} title="售后管理" text="审核工单、分配服务中心、审核检测结果并生成报价。">
    <Feedback notice={notice} />
    <section className="toolbar"><a className="button" href="#/system/after-sales/new">代客户提交工单</a><Button secondary onClick={() => setShowMaterials(!showMaterials)}>{showMaterials ? '返回工单' : '售后物料'}</Button></section>
    {showMaterials ? <RepairMaterialsPanel notice={setNotice} /> : <>
      <div className="filter-row">{[['PENDING_ADMIN_REVIEW', '待审核'], ['WAITING_CUSTOMER_SHIPMENT', '待寄修'], ['WAITING_SERVICE_CENTER_RECEIPT', '待收货'], ['INSPECTION_IN_PROGRESS', '检测中'], ['PENDING_QUOTE', '待出报价'], ['WAITING_PAYMENT_CONFIRMATION', '确认收款'], ['READY_FOR_PROCESSING', '待处理'], ['WAITING_REPAIR_SHIPMENT', '待维修及发货'], ['RETURN_SHIPPED', '售后已发货'], ['all', '全部']].map(([value, label]) => <button key={value} className={`filter ${stage === value ? 'active' : ''}`} onClick={() => setStage(value)}>{label}</button>)}</div>
      <div className="table-wrap"><table><thead><tr><th>工单编号</th><th>问题</th><th>产品 / SN</th><th>阶段</th><th>创建时间</th><th>操作</th></tr></thead><tbody>{filtered.map((item) => <tr key={item.id}><td>{item.caseNo}</td><td>{caseTypeText[item.caseType] ?? item.subject}</td><td>{item.productName || '—'} / {item.serialNumber || '—'}</td><td>{serviceStageText[item.serviceStage] ?? item.serviceStage}</td><td>{date(item.createdAt)}</td><td><Button secondary onClick={() => void open(item.id)}>查看处理</Button></td></tr>)}</tbody></table></div>
      {!items && <p>正在加载…</p>}
      {items?.length === 0 && <Empty text="暂无售后工单。" />}
      {selected && <section className="panel after-sales-detail">
        {photoViewer && <div className="service-photo-viewer" role="dialog" aria-modal="true"><div className="service-photo-viewer__dialog"><header><strong>{photoViewer.title}</strong><button type="button" onClick={() => setPhotoViewer(null)} aria-label="关闭图片预览">×</button></header><img src={photoViewer.url} alt={`${photoViewer.title} 大图预览`} /></div></div>}
        <h2>{selected.case.caseNo} · {caseTypeText[selected.case.caseType] ?? selected.case.subject}</h2>
        <ol className="service-progress" aria-label="服务进度">
          {serviceProgressSteps.map((step, index) => {
            const currentIndex = serviceProgressIndex(selected.case.serviceStage);
            const state = index < currentIndex ? 'done' : index === currentIndex ? 'active' : 'todo';
            return <li key={step.key} className={`service-progress__item is-${state}`}><span>{index + 1}</span><strong>{step.label}</strong></li>;
          })}
        </ol>
        <dl className="detail-grid"><dt>当前阶段</dt><dd>{serviceStageText[selected.case.serviceStage] ?? selected.case.serviceStage}</dd><dt>经销商</dt><dd>{selected.case.dealerName}</dd><dt>店铺</dt><dd>{selected.case.storeName || '—'}</dd><dt>产品</dt><dd>{selected.case.productName || '—'} {selected.case.productVersion || ''}</dd><dt>SN</dt><dd>{selected.case.serialNumber || '—'}</dd><dt>客户</dt><dd>{selected.case.contactName || '—'} / {selected.case.contactPhone || '—'} / {selected.case.contactEmail || '—'}</dd><dt>客户地址</dt><dd>{selected.case.contactAddress || '—'}</dd><dt>寄修单号</dt><dd>{selected.case.inboundCarrier || '—'} {selected.case.inboundTrackingNumber || ''}</dd><dt>售后发货</dt><dd>{selected.case.outboundCarrier || '—'} {selected.case.outboundTrackingNumber || ''}{selected.case.outboundShippedAt ? ` · ${date(selected.case.outboundShippedAt)}` : ''}</dd><dt>发货邮件</dt><dd>{selected.case.outboundMailStatus === 'sent' ? '已发送' : selected.case.outboundMailStatus === 'failed' ? `发送失败：${selected.case.outboundMailFailureReason || '原因未知'}` : '—'}</dd></dl>
        <div className="action-list"><a className="button button--secondary" href={`#/system/service-center/cases/${selected.case.id}`}>进入检测/定损处理</a></div>
        <section><h3>问题资料</h3><p>{selected.case.description}</p><p className="hint">用户备注：{selected.case.customerNote || '—'}；内部备注：{selected.case.internalNote || '—'}</p></section>
        <section><h3>工单与定损图片</h3>{groupedPhotos.length ? <div className="service-photo-preview-grid admin-after-sales-photos">{groupedPhotos.map((attachment) => {
          const url = photoUrl(attachment);
          const title = afterSalesPhotoSlotText[attachment.photoSlot] || `${afterSalesPhotoText[attachment.category] ?? attachment.category}${attachment.photoSlot ? ` · ${attachment.photoSlot}` : ''}`;
          return <figure key={attachment.id} className="service-photo-preview">
            <img src={url} alt={`${title} 预览`} />
            <figcaption><strong>{title}</strong><span>{attachment.originalFilename}</span><small>{attachment.uploadedByName || '—'} · {date(attachment.createdAt)}</small></figcaption>
            <button type="button" className="button button--secondary" onClick={() => setPhotoViewer({ url, title })}>查看预览</button>
          </figure>;
        })}</div> : <p className="hint">暂无已上传图片。服务中心上传的收货、六面检测和意外损坏照片会显示在这里。</p>}</section>
        {['PENDING_ADMIN_REVIEW', 'NEEDS_MORE_INFO'].includes(selected.case.serviceStage) && <section><h3>管理员初审</h3><div className="form-layout"><label>客户姓名<input value={reviewContactName} onChange={(event) => setReviewContactName(event.target.value)} placeholder="可在审核时修正" /></label><label>客户电话<input value={reviewContactPhone} onChange={(event) => setReviewContactPhone(event.target.value)} placeholder="可在审核时修正" /></label><label>客户邮箱<input type="email" value={reviewContactEmail} onChange={(event) => setReviewContactEmail(event.target.value)} placeholder="用于后续报价邮件" /></label><label>客户地址<textarea value={reviewContactAddress} onChange={(event) => setReviewContactAddress(event.target.value)} placeholder="本次售后联系和寄返地址" /></label></div><label>授权服务中心<select value={centerId} onChange={(event) => setCenterId(event.target.value)}><option value="">请选择服务中心</option>{options?.serviceCenters.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label><input type="checkbox" checked={requiresShipment} onChange={(event) => setRequiresShipment(event.target.checked)} /> 需要客户寄修</label><label>审核说明<textarea value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} /></label><div className="action-list"><Button onClick={() => void adminReview(true)}>受理并分配</Button><Button danger onClick={() => void adminReview(false)}>不受理 / 退回补充</Button></div></section>}
        {selected.case.serviceStage === 'WAITING_CUSTOMER_SHIPMENT' && <section><h3>录入寄修单号</h3><label>快递公司<input value={inboundCarrier} onChange={(event) => setInboundCarrier(event.target.value)} /></label><label>寄修单号<input value={inboundTracking} onChange={(event) => setInboundTracking(event.target.value)} /></label><Button onClick={() => void saveInbound()}>保存寄修单号</Button></section>}
        <section><h3>工程师检测记录</h3>{selected.inspections.map((inspection) => <div key={inspection.id}><p><strong>检测版本 {inspection.version}</strong> · {inspection.submittedByName} · {date(inspection.submittedAt)} · {inspection.status}<br />定损结果：{inspection.testResult || inspection.conclusion || '—'}；建议：{inspection.suggestedAction}；工程师参考金额：{money(inspection.materialSuggestedTotalCents ?? 0)}</p><dl className="detail-grid"><dt>定损结果</dt><dd>{inspection.testResult || inspection.conclusion || '—'}</dd><dt>建议处理</dt><dd>{inspection.suggestedAction || '—'}</dd></dl></div>)}</section>
        {['PENDING_QUOTE', 'PENDING_ADMIN_INSPECTION_REVIEW'].includes(selected.case.serviceStage) && <section><h3>管理员最终方案与报价</h3><p className="hint">工程师定损提交后直接进入本环节。工程师物料仅作为建议，最终是否使用、更换哪些物料，由管理员在下面两个区域勾选后生成报价。</p><section className="panel panel--nested"><h4>报价前核对</h4><dl className="detail-grid"><dt>收件邮箱</dt><dd>{selected.case.contactEmail || '未填写，确认发送前需要补充客户邮箱'}</dd><dt>客户联系方式</dt><dd>{[selected.case.contactName, selected.case.contactPhone].filter(Boolean).join(' / ') || '—'}</dd><dt>用户备注</dt><dd>{selected.case.customerNote || '—'}</dd><dt>内部备注</dt><dd>{selected.case.internalNote || '—'}</dd><dt>最新定损结果</dt><dd>{latestInspection?.testResult || latestInspection?.conclusion || '—'}</dd></dl></section>
          <section className="panel panel--nested"><h4>一、从工程师建议中选择</h4>{latestMaterials.length ? <div className="table-wrap"><table><thead><tr><th>采用</th><th>料号</th><th>物料</th><th>工程师数量</th><th>单价</th><th>服务费</th><th>参考小计</th><th>工程师说明</th></tr></thead><tbody>{latestMaterials.map((material) => <tr key={material.id}><td><input type="checkbox" checked={engineerMaterialIds.includes(material.id)} onChange={(event) => setEngineerMaterialIds((values) => toggleId(values, material.id, event.target.checked))} /></td><td>{material.materialCode || '—'}</td><td>{material.materialName}</td><td>{material.quantity}</td><td>{money(material.unitPriceCents)}</td><td>{money(material.serviceFeeCents)}</td><td>{money(material.suggestedTotalCents)}</td><td>{[material.compatibilityWarning, material.compatibilityOverrideReason, material.engineerNote].filter(Boolean).join('；') || '—'}</td></tr>)}</tbody></table></div> : <p className="hint">工程师未选择物料，管理员可直接从完整物料目录中选择。</p>}<div className="quote-selection-bar"><span>已勾选 <strong>{selectedEngineerMaterials.length}</strong> 项 · 参考金额 <strong>{money(engineerSelectionTotalCents)}</strong>{engineerSelectionPendingCount > 0 ? ` · ${engineerSelectionPendingCount} 项价格待确认` : ''}</span><Button secondary disabled={!selectedEngineerMaterials.length} onClick={addEngineerMaterialsToQuote}>加入已勾选的工程师建议（{selectedEngineerMaterials.length}）</Button></div></section>
          <section className="panel panel--nested"><h4>二、从其他售后物料中选择</h4><div className="toolbar"><input value={catalogSearch} onChange={(event) => setCatalogSearch(event.target.value)} placeholder="搜索料号、物料名称或关键词" /><label><input type="checkbox" checked={catalogShowAll} onChange={(event) => setCatalogShowAll(event.target.checked)} /> 显示全部物料</label></div>{catalogChoices.length ? <div className="table-wrap"><table><thead><tr><th>采用</th><th>料号</th><th>物料</th><th>适用型号</th><th>保外价格</th><th>服务费</th><th>保修规则</th><th>备注</th></tr></thead><tbody>{catalogChoices.map((material) => <tr key={material.id}><td><input type="checkbox" checked={catalogMaterialIds.includes(material.id)} onChange={(event) => setCatalogMaterialIds((values) => toggleId(values, material.id, event.target.checked))} /></td><td>{material.materialCode || '缺料号'}</td><td>{material.materialName}{material.compatibilityWarning && <><br /><small className="hint">{material.compatibilityWarning}</small></>}</td><td>{material.applicableModels || '需确认'}</td><td>{money(material.outOfWarrantyPriceCents)}<br /><small>{material.priceStatus}</small></td><td>{money(material.calculatedServiceFeeCents)}<br /><small>{material.calculatedServiceFeeStatus}</small></td><td>{material.warrantyPolicy || (material.warrantyDays ? `${material.warrantyDays}天` : '需确认')}</td><td>{material.sourceNote || '—'}</td></tr>)}</tbody></table></div> : <p className="hint">暂无其他可选物料，可调整搜索条件或勾选“显示全部物料”。</p>}<div className="quote-selection-bar"><span>已勾选 <strong>{selectedCatalogMaterials.length}</strong> 项 · 参考金额 <strong>{money(catalogSelectionTotalCents)}</strong>{catalogSelectionPendingCount > 0 ? ` · ${catalogSelectionPendingCount} 项价格待确认` : ''}</span><Button secondary disabled={!selectedCatalogMaterials.length} onClick={addCatalogMaterialsToQuote}>加入已勾选的其他物料（{selectedCatalogMaterials.length}）</Button></div></section>
          <section className="panel panel--nested"><h4>三、服务费用</h4><p className="hint">每份报价采用一个服务费等级；重新选择会替换当前已加入的 L0–L3 服务费。</p><div className="quick-fee-grid">{quickServiceFees.map((item) => <button type="button" key={item.code} className={`quick-fee-option ${quoteItems.some((row) => row.quickFeeCode === item.code) ? 'is-selected' : ''}`} onClick={() => addQuickServiceFee(item)}><span>{item.code}</span><strong>{item.name}</strong><b>{item.priceYuan === 0 ? '免费' : `¥${item.priceYuan}`}</b></button>)}</div></section>
          {quoteActionMessage && <p className="quote-action-message" role="status">{quoteActionMessage}</p>}
          <label>检测结论摘要<textarea value={quoteSummary} onChange={(event) => setQuoteSummary(event.target.value)} /></label><div className="quote-quick-phrases" aria-label="报价单快捷短句">{quoteQuickPhrases.map((phrase, index) => <button type="button" key={phrase} onClick={() => setQuoteSummary((value) => `${value}${value.trim() ? '\n\n' : ''}${phrase}`)}>{index === 0 ? phrase : `${phrase.slice(0, 24)}…`}</button>)}</div><label>最终方案<select value={finalDecision} onChange={(event) => setFinalDecision(event.target.value)}>{finalDecisionOptions.map((item) => <option key={item}>{item}</option>)}</select></label><label>管理员内部定损备注<textarea value={inspectionNote} onChange={(event) => setInspectionNote(event.target.value)} placeholder="仅内部记录，不会进入客户邮件" /></label><label>报价有效期<input type="date" value={quoteValidUntil} onChange={(event) => setQuoteValidUntil(event.target.value)} /></label><label>预计周期<input value={quoteCycle} onChange={(event) => setQuoteCycle(event.target.value)} /></label>
          <h4>四、最终报价项目</h4><div className="table-wrap" id="admin-final-quote-items"><table><thead><tr><th>项目</th><th>类型</th><th>数量</th><th>单价（元）</th><th>服务费（元）</th><th>折扣（元）</th><th>实时小计</th><th>内部备注</th><th>客户备注</th><th>操作</th></tr></thead><tbody>{quoteItems.map((item, index) => <tr key={`${item.materialId ?? item.quickFeeCode ?? 'manual'}-${index}`}><td><input value={item.itemName} onChange={(event) => updateQuoteItem(index, { itemName: event.target.value })} /></td><td><select value={item.itemType} onChange={(event) => updateQuoteItem(index, { itemType: event.target.value })}>{['维修物料', '更换组件', '服务费', '检测费', '维修费', '配件费', '人工费', '运费', '折扣', '其他'].map((value) => <option key={value}>{value}</option>)}</select></td><td><input type="number" min="1" step="1" value={item.quantity} onChange={(event) => updateQuoteItem(index, { quantity: event.target.value })} /></td><td><input type="number" step="0.01" value={item.unitPrice} onChange={(event) => updateQuoteItem(index, { unitPrice: event.target.value })} /></td><td><input type="number" min="0" step="0.01" value={item.serviceFee} onChange={(event) => updateQuoteItem(index, { serviceFee: event.target.value })} /></td><td><input type="number" min="0" step="0.01" value={item.discount} onChange={(event) => updateQuoteItem(index, { discount: event.target.value })} /></td><td className="quote-line-total">{money(quoteItemSubtotalCents(item))}</td><td><input value={item.note} onChange={(event) => updateQuoteItem(index, { note: event.target.value })} /></td><td><input value={item.customerNote} onChange={(event) => updateQuoteItem(index, { customerNote: event.target.value })} /></td><td><Button secondary onClick={() => setQuoteItems((rows) => rows.filter((_, i) => i !== index))}>移除</Button></td></tr>)}</tbody></table></div>{!quoteItems.length && <p className="hint">尚未生成报价项。请先从上方区域勾选物料、选择服务费，或增加手工费用项。</p>}{quoteItems.length > 0 && <div className="quote-total-bar" aria-live="polite"><span>共 {quoteItems.length} 项</span><span>折扣前 <strong>{money(quoteSubtotalBeforeDiscountCents)}</strong></span><span>折扣 <strong>-{money(quoteDiscountCents)}</strong></span><span>报价总额 <strong>{money(quoteTotalCents)}</strong></span></div>}<div className="action-list"><Button secondary onClick={() => setQuoteItems((rows) => [...rows, freshQuoteItem()])}>增加手工费用项</Button><Button disabled={quoteBusy} onClick={() => void saveQuote('READY_FOR_REVIEW')}>{quoteBusy ? '正在生成…' : '生成报价预览'}</Button></div></section>}
        {['WAITING_PAYMENT_CONFIRMATION', 'WAITING_CUSTOMER_CONFIRMATION'].includes(selected.case.serviceStage) && <section><h3>确认收款</h3><p className="hint">该工单等待客户确认或付款。客户付款到账后，由管理员确认收款，工单将进入待维修及发货流程。</p><div className="action-list"><Button onClick={() => void confirmPayment()}>确认已收款</Button></div></section>}
        <section><h3>售后发货</h3>{['READY_FOR_PROCESSING', 'WAITING_REPAIR_SHIPMENT'].includes(selected.case.serviceStage) ? <><p className="hint">{selected.case.serviceStage === 'READY_FOR_PROCESSING' ? '该工单报价为 0 元，产品服务报告书发送后已自动进入待处理流程。处理完成后在这里记录发货。' : '管理员已确认收款，请继续安排维修、替换或后续发货。'}发货时间会按点击“确认售后发货”时的系统时间自动记录；照片仅用于系统内留档，不会发送给客户。</p><div className="form-layout"><label>快递公司<input value={outboundCarrier} onChange={(event) => setOutboundCarrier(event.target.value)} /></label><label>快递单号<input value={outboundTracking} onChange={(event) => setOutboundTracking(event.target.value)} placeholder="可为空" /></label><label>产品 SN（如有）<input value={outboundSerial} onChange={(event) => setOutboundSerial(event.target.value)} placeholder="可为空" /></label><label>发货邮件收件邮箱<input type="email" value={outboundRecipientEmail} onChange={(event) => setOutboundRecipientEmail(event.target.value)} placeholder="填写本次发货邮件收件邮箱" /></label></div><div className="service-photo-preview-grid admin-after-sales-photos">{outboundPhotoSlots.map((item) => {
          const photo = outboundPhotos[item.slot];
          return <figure key={item.slot} className="service-photo-preview"><figcaption><strong>{item.label}</strong><span>请上传本次售后寄回发货照片。</span></figcaption>{photo && <img src={photo.dataUrl} alt={`${item.label}预览`} />}<div className="action-list"><label className="button button--secondary">选择图片<input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => readOutboundPhoto(item.slot, event.target.files?.[0])} /></label><CameraPhotoButton label={photo ? '重新拍照' : '摄像头拍照'} fileNamePrefix={`after-sales-outbound-${item.slot}`} watermarkLines={cameraWatermarkLines} maxOutputWidth={1600} quality={0.82} onCapture={(file) => readOutboundPhoto(item.slot, file)} onError={(text) => setNotice({ tone: 'error', text })} />{photo && <Button secondary onClick={() => setPhotoViewer({ url: photo.dataUrl, title: item.label })}>查看预览</Button>}</div></figure>;
        })}</div><div className="action-list"><Button disabled={outboundBusy} onClick={() => void submitOutboundShipment()}>{outboundBusy ? '正在记录发货…' : '确认售后发货并发送邮件'}</Button></div></> : selected.case.serviceStage === 'RETURN_SHIPPED' ? <dl className="detail-grid"><dt>快递公司</dt><dd>{selected.case.outboundCarrier || '—'}</dd><dt>快递单号</dt><dd>{selected.case.outboundTrackingNumber || '—'}</dd><dt>产品 SN</dt><dd>{selected.case.outboundSerialNumber || selected.case.serialNumber || '—'}</dd><dt>发货时间</dt><dd>{date(selected.case.outboundShippedAt)}</dd><dt>邮件状态</dt><dd>{selected.case.outboundMailStatus === 'sent' ? '客户发货邮件已发送' : selected.case.outboundMailStatus === 'failed' ? `发送失败：${selected.case.outboundMailFailureReason || '请检查邮件配置'}` : '—'}</dd></dl> : <p className="hint">该工单当前阶段为“{serviceStageText[selected.case.serviceStage] ?? selected.case.serviceStage}”。报价发送后为 0 元会进入“待处理”，收费工单确认收款后会进入“待维修及发货”，届时可在这里记录发货并发送客户邮件。</p>}</section>
        <section><h3>报价记录</h3>{selected.quotes.length ? <div className="table-wrap"><table><thead><tr><th>报价单</th><th>版本</th><th>状态</th><th>金额</th><th>收件邮箱</th><th>邮件结果</th><th>操作</th></tr></thead><tbody>{selected.quotes.map((quote) => <tr key={quote.id}><td>{quote.quoteNo}</td><td>V{quote.version}</td><td>{quoteWorkflowText[quote.workflowStatus] || quote.workflowStatus}</td><td>{money(quote.totalCents)}</td><td>{quote.customerEmail || '—'}</td><td>{quote.emailStatus === 'sent' ? '已发送' : quote.emailStatus === 'failed' ? `失败：${quote.emailFailureReason || '原因未知'}` : '尚未发送'}</td><td><Button secondary onClick={() => void loadQuotePreview(quote.id, ['DRAFT', 'READY_FOR_REVIEW'].includes(quote.workflowStatus))}>预览</Button></td></tr>)}</tbody></table></div> : <p>暂无报价。</p>}</section>
        <section><h3>售后进度</h3><ul className="timeline">{selected.timeline.map((item) => <li key={`${item.eventType}-${item.createdAt}`}><i /><span><strong>{item.title}</strong><small>{date(item.createdAt)} · {item.actorName || '系统'} · {item.description || '—'}</small></span></li>)}</ul></section>
      </section>}
        {quotePreview && <div className="quote-preview-backdrop" role="presentation"><section className="quote-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="quote-preview-title"><header><div><h2 id="quote-preview-title">产品服务报告书</h2><p>{quoteWorkflowText[quotePreview.quote.workflowStatus] || quotePreview.quote.workflowStatus} · 案例号 {quotePreview.quote.caseNo}</p></div><button type="button" onClick={() => { setQuotePreview(null); setConfirmSendOpen(false); }} aria-label="关闭报价预览">×</button></header><div className="quote-preview-meta"><span>收件人：{quotePreview.quote.customerName}</span><label className="quote-recipient-field">本次收件邮箱<input type="email" value={quoteRecipientEmail} disabled={!(['READY_FOR_REVIEW', 'SEND_FAILED'].includes(quotePreview.quote.workflowStatus))} onChange={(event) => setQuoteRecipientEmail(event.target.value)} placeholder="填写客户收件邮箱" /></label><span>From：MaxCINE 通知中心 &lt;{quotePreview.quote.fromEmail}&gt;</span><span>Reply-To：MaxCINE 客户支持 &lt;{quotePreview.quote.replyToEmail}&gt;</span><span>报告日期：{date(quotePreview.quote.createdAt)}</span><span>有效期：{quotePreview.quote.validUntil}</span></div><div className="quote-preview-content"><iframe title={`${quotePreview.quote.caseNo} 产品服务报告书预览`} srcDoc={quotePreview.quote.htmlContent} /></div><footer><div className="quote-preview-secondary">{['SENT', 'SEND_FAILED', 'SUPERSEDED'].includes(quotePreview.quote.workflowStatus) && <Button secondary disabled={quoteBusy} onClick={() => void createNewQuoteVersion()}>复制为新版本</Button>}</div><div className="action-list">{['DRAFT', 'READY_FOR_REVIEW'].includes(quotePreview.quote.workflowStatus) && <><Button secondary onClick={() => setQuotePreview(null)}>返回修改</Button><Button secondary disabled={quoteBusy} onClick={() => void saveQuote('DRAFT', false)}>保存草稿</Button></>}{['READY_FOR_REVIEW', 'SEND_FAILED'].includes(quotePreview.quote.workflowStatus) && <Button disabled={quoteBusy} onClick={() => setConfirmSendOpen(true)}>{quotePreview.quote.workflowStatus === 'SEND_FAILED' ? '重新发送' : '确认并发送'}</Button>}</div></footer></section>{confirmSendOpen && <div className="quote-confirm-backdrop"><section className="quote-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="quote-confirm-title"><h2 id="quote-confirm-title">确认发送产品服务报告书</h2><dl><dt>收件人</dt><dd>{quotePreview.quote.customerName}</dd><dt>本次收件邮箱</dt><dd><input type="email" value={quoteRecipientEmail} onChange={(event) => setQuoteRecipientEmail(event.target.value)} placeholder="填写客户收件邮箱" /></dd><dt>案例号</dt><dd>{quotePreview.quote.caseNo}</dd><dt>报告总额</dt><dd>{money(quotePreview.quote.totalCents)}</dd><dt>发件邮箱</dt><dd>{quotePreview.quote.fromEmail}</dd><dt>Reply-To</dt><dd>{quotePreview.quote.replyToEmail}</dd></dl><p>确认发送后，本报告版本将锁定；如需修改，应复制为新版本并重新预览。本次填写的邮箱只用于当前报告发送和发送记录。</p><div className="action-list"><Button secondary disabled={quoteBusy} onClick={() => setConfirmSendOpen(false)}>取消</Button><Button disabled={quoteBusy} onClick={() => void confirmQuoteSend()}>{quoteBusy ? '正在发送…' : '确认发送'}</Button></div></section></div>}</div>}
    </>}
  </Shell>;
}

type Props = { user: SessionUser; route: string; logout: () => void };
export function AdminManagementPortal({ user, route, logout }: Props) { const path = route.split('?')[0]; if (path === '/system/admin/products') return <Products user={user} route={route} logout={logout} />; if (path === '/system/admin/dealers') return <Dealers user={user} route={route} logout={logout} />; if (path === '/system/admin/stores') return <Stores user={user} route={route} logout={logout} />; if (path === '/system/admin/after-sales') return <AfterSalesV2 user={user} route={route} logout={logout} />; if (path === '/system/admin/mail-center') return <MailCenter user={user} route={route} logout={logout} />; return <Users user={user} route={route} logout={logout} />; }
