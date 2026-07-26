import { type ChangeEvent, type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { HISTORICAL_WARRANTY_COLUMNS, type SessionUser } from '@maxcine/shared';
import { api, ApiClientError } from './api';
import { Shell } from './OperationsPortal';

type Props = { user: SessionUser; route: string; logout: () => void };
type Notice = { tone: 'success' | 'error'; text: string } | null;
type ImportIssue = { severity: 'warning' | 'error'; code: string; message: string };
type ImportPreview = { batch: { id: string; sourceFilename: string; sourceSheet: string; status: string; totalRows: number; normalRows: number; warningRows: number; errorRows: number; confirmedAt: string | null }; rows: Array<{ rowNumber: number; sequence: string; currentSn: string | null; originalSn: string | null; version: string; sourceChannel: string; issues: ImportIssue[]; disposition: string }>; alreadyPrepared?: boolean; alreadyCompleted?: boolean; importedRows?: number; skippedRows?: number };
type Asset = { id: string; currentSn: string | null; originalSn?: string | null; productName: string; version: string; sourceChannel: string; shippingWarehouse: string; warrantyStatus: string; warrantyEndAt: string | null; assetStatus: string; dataQualityStatus: string; latestEvent: string | null; updatedAt: string };
type AssetListResponse = { items: Asset[]; filters: { versions: string[]; channels: string[]; warehouses: string[] }; pagination: { page: number; total: number; totalPages: number } };
type AssetDetail = { asset: { id: string; currentSn: string | null; originalSn: string | null; productName: string; version: string; assetStatus: string; warrantyPolicy: string; warrantyStartAt: string | null; warrantyEndAt: string | null; warrantyOverrideStatus: string | null; warrantyOverrideReason: string; warrantyStatus: string; sourceChannel: string; shippingWarehouse: string; dealerName: string | null; storeName: string | null; latestOrderId: string | null; latestOrderNo: string | null; dataQualityStatus: string; createdAt: string; updatedAt: string }; identifiers: Array<{ identifierType: string; identifierValue: string; isCurrent: number; validFrom: string | null; validTo: string | null; reason: string; source: string; createdAt: string }>; events: Array<{ id: string; eventType: string; occurredAt: string | null; title: string; description: string; relatedOrderId: string | null; relatedServiceCaseId: string | null; operatorName: string | null; visibility: string; source: string; createdAt: string }>; serviceCases: Array<{ id: string; caseNo: string; status: string; workflowStage: string; subject: string; createdAt: string; updatedAt: string }>; notes: Array<{ category: string; content: string; source: string; createdAt: string }>; sales: Array<{ sourceChannel: string; purchaseDate: string | null; trackingNumber: string | null; shippingWarehouse: string; purchasePriceRaw?: string; paymentRaw?: string; paymentStatus?: string }>; audit: Array<{ action: string; createdAt: string; actorName: string | null }> };
type Store = { id: string; name: string };

const inputText = (value: unknown) => value === null || value === undefined ? '' : String(value).trim();
const errorText = (error: unknown) => {
  if (!(error instanceof ApiClientError)) return '系统繁忙，请稍后再试。';
  if (error.code === 'UNAUTHENTICATED') return '登录状态已失效，请重新登录。';
  if (error.code === 'FORBIDDEN') return '你没有权限查看该资产。';
  if (error.code === 'NOT_FOUND') return '未找到相关资产。';
  if (error.code === 'INTERNAL_ERROR') return '系统繁忙，请稍后再试。';
  return error.message || '操作未完成，请稍后重试。';
};
const date = (value: string | null | undefined) => value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', hour12: false }).format(new Date(`${value.replace(' ', 'T')}Z`)) : '—';
const statusTone = (value: string) => value === '在保' || value === 'active' ? 'good' : ['异常', '拒保', '注销', '报废', 'duplicate_identifier', 'invalid_identifier', 'missing_identifier'].includes(value) ? 'risk' : 'neutral';

function GsxTabs({ active, canImport }: { active: string; canImport: boolean }) {
  const tabs = [
    ['GSX 查询', '/system/admin/assets'], ['资产列表', '/system/admin/assets/list'], ['在保资产', '/system/admin/assets/warranty'], ['异常资产', '/system/admin/assets/exceptions'], ['售后工单', '/system/admin/after-sales'], ...(canImport ? [['历史数据导入', '/system/admin/assets/import']] : [])
  ];
  return <nav className="gsx-tabs" aria-label="资产与保修菜单">{tabs.map(([label, href]) => <a key={href} href={`#${href}`} className={active === href ? 'is-active' : ''}>{label}</a>)}</nav>;
}

function Notice({ notice }: { notice: Notice }) { return notice ? <div className={`notice notice--${notice.tone === 'error' ? 'error' : 'info'}`}>{notice.text}</div> : null; }
function Pill({ value }: { value: string }) { return <span className={`status gsx-status gsx-status--${statusTone(value)}`}>{value}</span>; }

async function fingerprint(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, '0')).join('');
}

async function readHistoricalWarranty(file: File) {
  const arrayBuffer = await file.arrayBuffer();
  const workbook = XLSX.read(arrayBuffer, { type: 'array', cellDates: false });
  const sourceSheet = workbook.SheetNames[0];
  if (!sourceSheet) throw new Error('未找到可读取的工作表。');
  const values = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sourceSheet], { header: 1, raw: true, defval: null });
  const headerIndex = values.findIndex((row) => Array.isArray(row) && HISTORICAL_WARRANTY_COLUMNS.every((column) => row.some((cell) => inputText(cell) === column)));
  if (headerIndex < 0) throw new Error('未识别到当前历史保修表的完整表头，请使用原始文件。');
  const headerRow = values[headerIndex];
  const headers = headerRow.map(inputText).filter(Boolean);
  const index = new Map(headerRow.map((cell, columnIndex) => [inputText(cell), columnIndex]));
  const records = values.slice(headerIndex + 1).map((row, offset) => {
    const source: Record<string, string | number | boolean | null> = {};
    for (const column of HISTORICAL_WARRANTY_COLUMNS) {
      const value = row[index.get(column)!];
      source[column] = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null ? value : inputText(value);
    }
    return { rowNumber: headerIndex + offset + 2, values: source };
  }).filter((record) => Object.values(record.values).some((value) => inputText(value)));
  if (!records.length) throw new Error('未读取到历史保修记录。');
  return { sourceSheet, headers, records, sourceFileFingerprint: await fingerprint(arrayBuffer) };
}

function SearchHome({ user, route, logout }: Props) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<Asset[]>([]);
  const [notice, setNotice] = useState<Notice>(null);
  const [recentQueries, setRecentQueries] = useState<string[]>(() => {
    try { return JSON.parse(sessionStorage.getItem('maxcine-gsx-recent-queries') || '[]') as string[]; }
    catch { return []; }
  });
  const search = async (event: FormEvent) => {
    event.preventDefault(); setNotice(null);
    try {
      const result = await api<{ items: Asset[] }>(`/gsx/search?q=${encodeURIComponent(query)}`);
      setItems(result.items);
      const normalized = query.trim();
      if (normalized) {
        const next = [normalized, ...recentQueries.filter((item) => item !== normalized)].slice(0, 5);
        setRecentQueries(next);
        sessionStorage.setItem('maxcine-gsx-recent-queries', JSON.stringify(next));
      }
      if (!result.items.length) setNotice({ tone: 'success', text: '未找到匹配的资产、订单、运单或工单。' });
    }
    catch (error) { setNotice({ tone: 'error', text: errorText(error) }); }
  };
  return <Shell user={user} route={route} title="GSX 查询" subtitle="通过 SN、运单号、订单号或工单号查找资产。" logout={logout}><GsxTabs active="/system/admin/assets" canImport={user.permissions.includes('asset:import')} /><div className="gsx-home-grid"><section className="panel gsx-search"><form onSubmit={search}><label htmlFor="gsx-search">统一查询</label><p>支持当前 SN、历史 SN、顺丰单号、订单号和售后工单号。</p><div className="gsx-search-row"><input id="gsx-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入当前 SN、原 SN、顺丰单号、订单号或工单号" minLength={2} /><button className="button" type="submit" disabled={query.trim().length < 2}>查询</button></div></form>{recentQueries.length > 0 && <div className="gsx-recent-queries"><span>最近查询</span>{recentQueries.map((item) => <button type="button" key={item} onClick={() => setQuery(item)}>{item}</button>)}</div>}</section><section className="panel gsx-home-actions"><div className="panel-title"><h2>快捷入口</h2></div><div className="gsx-quick-grid"><a href="#/system/admin/assets/list"><strong>资产列表</strong><span>浏览全部资产记录</span></a><a href="#/system/admin/assets/warranty"><strong>在保资产</strong><span>查看有效保修中的资产</span></a><a href="#/system/admin/assets/exceptions"><strong>异常资产</strong><span>处理待核验的历史数据</span></a><a href="#/system/admin/after-sales"><strong>最近售后</strong><span>进入售后工单处理列表</span></a>{user.permissions.includes('asset:import') && <a href="#/system/admin/assets/import"><strong>历史导入</strong><span>查看并继续历史数据导入</span></a>}</div></section></div><section className="panel gsx-search-help"><div><h2>查询说明</h2><p>优先使用产品 SN 查询；当标签异常或更换过 SN 时，也可以输入原 SN 或历史标签。</p></div><span>查询结果会按资产、订单、物流和售后关联信息汇总展示。</span></section><Notice notice={notice} />{items.length > 0 && <section className="panel"><div className="panel-title"><h2>查询结果</h2><span>{items.length} 条结果</span></div><div className="gsx-result-grid">{items.map((item) => <a className="gsx-result" href={`#/system/admin/assets/${item.id}`} key={item.id}><Pill value={item.warrantyStatus} /><strong>{item.currentSn || item.originalSn || '待补充 SN'}</strong><span>{item.productName} · {item.version || '未标注版本'}</span><small>{item.sourceChannel || '未标注渠道'} · {item.assetStatus}</small></a>)}</div></section>}</Shell>;
}

function AssetList({ user, route, logout, mode = 'all' }: Props & { mode?: 'all' | 'warranty' | 'exceptions' }) {
  const [data, setData] = useState<AssetListResponse | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [search, setSearch] = useState(''); const [version, setVersion] = useState(''); const [channel, setChannel] = useState(''); const [warehouse, setWarehouse] = useState(''); const [quality, setQuality] = useState(''); const [page, setPage] = useState(1);
  const fixed = mode === 'warranty' ? 'warrantyStatus=在保' : mode === 'exceptions' ? 'quality=exception' : '';
  const query = useMemo(() => { const params = new URLSearchParams({ page: String(page), limit: '30' }); if (search) params.set('search', search); if (version) params.set('version', version); if (channel) params.set('channel', channel); if (warehouse) params.set('warehouse', warehouse); if (quality) params.set('quality', quality); if (fixed) { const [key, value] = fixed.split('='); params.set(key, value); } return params.toString(); }, [search, version, channel, warehouse, quality, fixed, page]);
  const load = useCallback(() => { void api<AssetListResponse>(`/assets?${query}`).then(setData).catch((error) => setNotice({ tone: 'error', text: errorText(error) })); }, [query]);
  useEffect(() => { load(); }, [load]);
  const title = mode === 'warranty' ? '在保资产' : mode === 'exceptions' ? '异常资产' : '资产列表';
  const subtitle = mode === 'warranty' ? '查看当前仍在有效保修期内的资产。' : mode === 'exceptions' ? '查看需要人工核验 SN、保修或历史数据的资产。' : '查看历史与当前资产的保修状态和生命周期。';
  return <Shell user={user} route={route} title={title} subtitle={subtitle} logout={logout}><GsxTabs active={mode === 'all' ? '/system/admin/assets/list' : mode === 'warranty' ? '/system/admin/assets/warranty' : '/system/admin/assets/exceptions'} canImport={user.permissions.includes('asset:import')} /><Notice notice={notice} /><section className="toolbar gsx-filter"><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="搜索当前 SN、原 SN 或产品" /><select value={version} onChange={(event) => { setVersion(event.target.value); setPage(1); }}><option value="">全部版本</option>{data?.filters.versions.map((value) => <option key={value} value={value}>{value}</option>)}</select><select value={channel} onChange={(event) => { setChannel(event.target.value); setPage(1); }}><option value="">全部销售渠道</option>{data?.filters.channels.map((value) => <option key={value} value={value}>{value}</option>)}</select><select value={warehouse} onChange={(event) => { setWarehouse(event.target.value); setPage(1); }}><option value="">全部发货仓库</option>{data?.filters.warehouses.map((value) => <option key={value} value={value}>{value}</option>)}</select>{mode !== 'exceptions' && <select value={quality} onChange={(event) => { setQuality(event.target.value); setPage(1); }}><option value="">全部数据质量</option><option value="normal">正常</option><option value="warning">待核验</option><option value="duplicate_identifier">重复标签</option><option value="invalid_identifier">标签异常</option><option value="missing_identifier">缺少 SN</option></select>}</section>{!data ? <p>正在加载…</p> : <><div className="table-wrap"><table><thead><tr><th>当前 SN</th><th>产品与版本</th><th>销售渠道</th><th>保修状态</th><th>保修结束</th><th>资产状态</th><th>最近事件</th><th>数据质量</th><th>操作</th></tr></thead><tbody>{data.items.map((item) => <tr key={item.id}><td>{item.currentSn || '待补充'}</td><td>{item.productName}<br /><small>{item.version || '未标注版本'}</small></td><td>{item.sourceChannel || '—'}</td><td><Pill value={item.warrantyStatus} /></td><td>{date(item.warrantyEndAt)}</td><td>{item.assetStatus}</td><td>{item.latestEvent || '—'}</td><td><Pill value={item.dataQualityStatus === 'normal' ? '正常' : item.dataQualityStatus === 'warning' ? '待核验' : item.dataQualityStatus === 'duplicate_identifier' ? '重复标签' : item.dataQualityStatus === 'invalid_identifier' ? '标签异常' : '缺少 SN'} /></td><td><a href={`#/system/admin/assets/${item.id}`}>查看详情</a></td></tr>)}</tbody></table>{!data.items.length && <div className="empty-state"><h2>暂无符合条件的资产。</h2></div>}</div>{data.pagination.totalPages > 1 && <div className="pagination"><button className="button button--secondary" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</button><span>第 {data.pagination.page} / {data.pagination.totalPages} 页，共 {data.pagination.total} 条</span><button className="button button--secondary" disabled={page >= data.pagination.totalPages} onClick={() => setPage((value) => value + 1)}>下一页</button></div>}</>}</Shell>;
}

function ImportPage({ user, route, logout }: Props) {
  const [preview, setPreview] = useState<ImportPreview | null>(null); const [notice, setNotice] = useState<Notice>(null); const [busy, setBusy] = useState(false);
  const selectFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return;
    setBusy(true); setNotice(null); setPreview(null);
    try { const source = await readHistoricalWarranty(file); const result = await api<ImportPreview>('/admin/gsx/imports/precheck', { method: 'POST', body: JSON.stringify({ sourceFilename: file.name, ...source }) }); setPreview(result); setNotice({ tone: 'success', text: result.alreadyPrepared ? '该文件已有预检查记录，可继续确认导入。' : '预检查完成，请查看警告和错误后确认导入。' }); }
    catch (error) { setNotice({ tone: 'error', text: error instanceof Error && !(error instanceof ApiClientError) ? error.message : errorText(error) }); }
    finally { setBusy(false); event.target.value = ''; }
  };
  const confirm = async () => { if (!preview || !window.confirm('确认导入可处理的历史保修记录吗？导入后会生成资产、销售记录和生命周期事件。')) return; setBusy(true); setNotice(null); try { const skipRowNumbers = preview.rows.filter((row) => row.issues.some((issue) => issue.severity === 'error')).map((row) => row.rowNumber); const result = await api<ImportPreview>(`/admin/gsx/imports/${preview.batch.id}/confirm`, { method: 'POST', body: JSON.stringify({ skipRowNumbers }) }); setPreview(result); setNotice({ tone: 'success', text: result.alreadyCompleted ? '该文件此前已完成导入，未重复创建记录。' : `导入完成：已导入 ${result.importedRows ?? 0} 条，跳过 ${result.skippedRows ?? 0} 条。` }); } catch (error) { setNotice({ tone: 'error', text: errorText(error) }); } finally { setBusy(false); } };
  return <Shell user={user} route={route} title="历史数据导入" subtitle="先预检查，再确认写入；异常行不会阻断整批处理。" logout={logout}><GsxTabs active="/system/admin/assets/import" canImport /><Notice notice={notice} /><section className="panel"><h2>选择历史保修表</h2><p>仅支持当前结构的 .xlsx 文件。预检查不会立即生成资产或保修记录。</p><label className="button button--secondary">{busy ? '正在处理…' : '选择 .xlsx 文件'}<input type="file" accept=".xlsx" hidden disabled={busy} onChange={(event) => void selectFile(event)} /></label></section>{preview && <section className="panel"><div className="panel-title"><h2>预检查结果</h2><span>{preview.batch.status === 'prepared' ? '等待确认' : '已完成'}</span></div><div className="stats gsx-import-stats"><article className="stat"><p>记录总数</p><strong>{preview.batch.totalRows}</strong></article><article className="stat"><p>正常记录</p><strong>{preview.batch.normalRows}</strong></article><article className="stat"><p>警告记录</p><strong>{preview.batch.warningRows}</strong></article><article className="stat"><p>错误记录</p><strong>{preview.batch.errorRows}</strong></article></div><div className="table-wrap"><table><thead><tr><th>原表行号</th><th>序号</th><th>当前 SN</th><th>版本</th><th>检查结果</th><th>处理方式</th></tr></thead><tbody>{preview.rows.map((row) => <tr key={row.rowNumber}><td>{row.rowNumber}</td><td>{row.sequence || '—'}</td><td>{row.currentSn || row.originalSn || '缺少 SN'}</td><td>{row.version || '—'}</td><td>{row.issues.length ? row.issues.map((issue) => <p className={issue.severity === 'error' ? 'text-danger' : ''} key={`${issue.code}-${issue.message}`}>{issue.message}</p>) : '正常'}</td><td>{row.disposition === 'imported' ? '已导入' : row.disposition === 'skipped' ? '已跳过' : row.issues.some((issue) => issue.severity === 'error') ? '确认时跳过' : '确认后导入'}</td></tr>)}</tbody></table></div>{preview.batch.status === 'prepared' && <div className="action-list"><button className="button" onClick={() => void confirm()} disabled={busy}>确认导入</button></div>}</section>}</Shell>;
}

function AssetDetailPage({ user, route, logout, assetId }: Props & { assetId: string }) {
  const [data, setData] = useState<AssetDetail | null>(null); const [notice, setNotice] = useState<Notice>(null); const [tab, setTab] = useState('overview'); const [override, setOverride] = useState(''); const [reason, setReason] = useState(''); const [stores, setStores] = useState<Store[]>([]); const [storeId, setStoreId] = useState(''); const [subject, setSubject] = useState(''); const [description, setDescription] = useState(''); const [creating, setCreating] = useState(false);
  const load = useCallback(() => { void api<AssetDetail>(`/assets/${assetId}`).then((result) => { setData(result); setOverride(result.asset.warrantyOverrideStatus ?? ''); setReason(result.asset.warrantyOverrideReason ?? ''); }).catch((error) => setNotice({ tone: 'error', text: errorText(error) })); }, [assetId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (user.permissions.includes('after-sales:create')) void api<{ stores: Store[] }>('/stores').then((result) => setStores(result.stores)).catch(() => undefined); }, [user.permissions]);
  const saveOverride = async () => { try { await api(`/admin/assets/${assetId}/warranty`, { method: 'PATCH', body: JSON.stringify({ warrantyOverrideStatus: override || null, warrantyOverrideReason: reason }) }); setNotice({ tone: 'success', text: '保修状态已更新。' }); load(); } catch (error) { setNotice({ tone: 'error', text: errorText(error) }); } };
  const createCase = async (event: FormEvent) => { event.preventDefault(); setCreating(true); try { const result = await api<{ id: string; caseNo: string }>(`/assets/${assetId}/after-sales`, { method: 'POST', body: JSON.stringify({ storeId, caseType: '产品异常', subject, description }) }); setNotice({ tone: 'success', text: `售后工单已创建：${result.caseNo}` }); setSubject(''); setDescription(''); load(); } catch (error) { setNotice({ tone: 'error', text: errorText(error) }); } finally { setCreating(false); } };
  const tabs = [['overview', '概览'], ['events', '生命周期'], ['warranty', '保修与售后'], ['identifiers', 'SN 与标识历史'], ['sales', '订单与物流'], ['notes', '内部备注'], ['audit', '审计记录']];
  return <Shell user={user} route={route} title="资产详情" subtitle={data?.asset.currentSn || data?.asset.originalSn || '正在加载资产'} logout={logout}><GsxTabs active="" canImport={user.permissions.includes('asset:import')} /><Notice notice={notice} />{!data ? <p>正在加载…</p> : <><p className="breadcrumb"><a href="#/system/admin/assets/list">资产列表</a> / {data.asset.currentSn || data.asset.originalSn || '历史资产'}</p><section className="panel gsx-asset-head"><div><Pill value={data.asset.warrantyStatus} /><h2>{data.asset.currentSn || '待补充 SN'}</h2><p>{data.asset.productName} · {data.asset.version || '未标注版本'}</p></div><dl><dt>资产状态</dt><dd>{data.asset.assetStatus}</dd><dt>保修期限</dt><dd>{date(data.asset.warrantyStartAt)} 至 {date(data.asset.warrantyEndAt)}</dd><dt>销售渠道</dt><dd>{data.asset.sourceChannel || '—'}</dd><dt>发货仓库</dt><dd>{data.asset.shippingWarehouse || '—'}</dd><dt>关联经销商</dt><dd>{data.asset.dealerName || '未关联'}</dd><dt>关联订单</dt><dd>{data.asset.latestOrderNo || '—'}</dd></dl></section><div className="filter-row gsx-detail-tabs">{tabs.map(([key, label]) => <button className={`filter ${tab === key ? 'active' : ''}`} key={key} onClick={() => setTab(key)}>{label}</button>)}</div>{tab === 'overview' && <section className="panel"><h2>资产概览</h2><dl className="summary"><dt>原 SN</dt><dd>{data.asset.originalSn || '—'}</dd><dt>数据质量</dt><dd>{data.asset.dataQualityStatus}</dd><dt>创建时间</dt><dd>{date(data.asset.createdAt)}</dd><dt>最近更新时间</dt><dd>{date(data.asset.updatedAt)}</dd></dl></section>}{tab === 'events' && <section className="panel"><h2>生命周期</h2><div className="gsx-timeline">{data.events.length ? data.events.map((event) => <article key={event.id}><i /><time>{date(event.occurredAt || event.createdAt)}</time><h3>{event.title}</h3><p>{event.description || '—'}</p><small>{event.operatorName || '系统'}{event.relatedServiceCaseId ? ' · 已关联售后工单' : ''}{event.relatedOrderId ? ' · 已关联订单' : ''}</small></article>) : <p>暂无生命周期记录。</p>}</div></section>}{tab === 'warranty' && <section className="panel"><h2>保修与售后</h2><dl className="summary"><dt>当前保修状态</dt><dd><Pill value={data.asset.warrantyStatus} /></dd><dt>保修起止</dt><dd>{date(data.asset.warrantyStartAt)} 至 {date(data.asset.warrantyEndAt)}</dd><dt>人工覆盖</dt><dd>{data.asset.warrantyOverrideStatus || '未设置'}</dd></dl>{user.permissions.includes('asset:manage') && <div className="gsx-inline-form"><label>人工保修状态<select value={override} onChange={(event) => setOverride(event.target.value)}><option value="">按保修日期计算</option><option value="no_warranty">无保修</option><option value="denied">拒保</option><option value="exception">异常</option><option value="cancelled">注销</option><option value="scrapped">报废</option></select></label><label>处理原因<input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="设置人工状态时必填" /></label><button className="button button--secondary" onClick={() => void saveOverride()}>保存保修状态</button></div>}<h3>已有售后工单</h3>{data.serviceCases.length ? <div className="table-wrap"><table><thead><tr><th>工单编号</th><th>主题</th><th>状态</th><th>更新时间</th></tr></thead><tbody>{data.serviceCases.map((item) => <tr key={item.id}><td><a href={`#/system/admin/after-sales/${item.id}`}>{item.caseNo}</a></td><td>{item.subject}</td><td>{item.status}</td><td>{date(item.updatedAt)}</td></tr>)}</tbody></table></div> : <p>暂无关联售后工单。</p>}{user.permissions.includes('after-sales:create') && <form className="gsx-case-form" onSubmit={createCase}><h3>创建售后工单</h3><label>关联店铺<select value={storeId} onChange={(event) => setStoreId(event.target.value)} required><option value="">请选择店铺</option>{stores.map((store) => <option value={store.id} key={store.id}>{store.name}</option>)}</select></label><label>工单主题<input value={subject} onChange={(event) => setSubject(event.target.value)} minLength={3} required /></label><label>问题描述<textarea value={description} onChange={(event) => setDescription(event.target.value)} minLength={10} required /></label><button className="button" type="submit" disabled={creating}>{creating ? '正在创建…' : '创建售后工单'}</button></form>}</section>}{tab === 'identifiers' && <section className="panel"><h2>SN 与标识历史</h2><div className="table-wrap"><table><thead><tr><th>类型</th><th>标识</th><th>当前使用</th><th>原因</th><th>来源</th></tr></thead><tbody>{data.identifiers.map((item, index) => <tr key={`${item.identifierValue}-${index}`}><td>{item.identifierType}</td><td>{item.identifierValue}</td><td>{item.isCurrent ? '是' : '否'}</td><td>{item.reason || '—'}</td><td>{item.source || '—'}</td></tr>)}</tbody></table></div></section>}{tab === 'sales' && <section className="panel"><h2>订单与物流</h2><div className="table-wrap"><table><thead><tr><th>销售渠道</th><th>购买日期</th><th>运单号</th><th>发货仓库</th>{user.permissions.includes('data:read:all') && <th>原始价格记录</th>}</tr></thead><tbody>{data.sales.map((sale, index) => <tr key={index}><td>{sale.sourceChannel || '—'}</td><td>{date(sale.purchaseDate)}</td><td>{sale.trackingNumber || '—'}</td><td>{sale.shippingWarehouse || '—'}</td>{user.permissions.includes('data:read:all') && <td>{sale.purchasePriceRaw || '—'}</td>}</tr>)}</tbody></table></div></section>}{tab === 'notes' && <section className="panel"><h2>内部备注</h2>{data.notes.length ? data.notes.map((note, index) => <article className="gsx-note" key={index}><strong>{note.category}</strong><p>{note.content}</p><small>{note.source} · {date(note.createdAt)}</small></article>) : <p>当前账户无可查看的内部备注。</p>}</section>}{tab === 'audit' && <section className="panel"><h2>审计记录</h2>{data.audit.length ? <div className="table-wrap"><table><thead><tr><th>操作</th><th>操作人</th><th>时间</th></tr></thead><tbody>{data.audit.map((item, index) => <tr key={index}><td>{item.action}</td><td>{item.actorName || '系统'}</td><td>{date(item.createdAt)}</td></tr>)}</tbody></table></div> : <p>当前账户无可查看的审计记录。</p>}</section>}</>}</Shell>;
}

export function GsxPortal(props: Props) {
  const path = props.route.split('?')[0];
  if (path === '/system/admin/assets/import') return <ImportPage {...props} />;
  if (path === '/system/admin/assets/list') return <AssetList {...props} />;
  if (path === '/system/admin/assets/warranty') return <AssetList {...props} mode="warranty" />;
  if (path === '/system/admin/assets/exceptions') return <AssetList {...props} mode="exceptions" />;
  if (path.startsWith('/system/admin/assets/')) return <AssetDetailPage {...props} assetId={path.split('/').at(-1)!} />;
  return <SearchHome {...props} />;
}
