import { type ChangeEvent, useCallback, useEffect, useMemo, useState } from 'react';
import type { SessionUser } from '@maxcine/shared';
import { api, apiResourceUrl, ApiClientError, uploadFormData } from './api';
import { Shell } from './OperationsPortal';

type Props = { user: SessionUser; route: string; logout: () => void };
type InspectionResult = 'PASS' | 'FAIL' | 'ADVISORY' | 'N/A';
type Grade = 'A+' | 'A' | 'B+' | 'B' | 'Parts / Repair';
type InspectionTask = {
  id: string;
  assetId: string;
  assignedTo: string | null;
  assignedToName?: string | null;
  status: string;
  result: InspectionResult | null;
  grade: Grade | null;
  finalQc: number | null;
  notes: string;
  assetCode: string;
  currentSn: string | null;
  productName: string;
  productVersion?: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
};
type Evidence = {
  id: string;
  evidenceType: 'photo' | 'video' | 'note' | 'test_data';
  contentText: string;
  contentUrl: string | null;
  metadata?: { originalFilename?: string; contentType?: string; fileSize?: number };
  createdAt?: string;
  createdByName?: string | null;
};
type TaskDetailResponse = { task: InspectionTask; evidence: Evidence[]; canFinalQc: boolean };
type WarehouseAsset = { assetId: string; assetCode?: string; currentSn: string | null; productName: string; status: string; warehouseCode: string };
type Listing = { id: string; currentSn: string | null; title: string; channelCode: string; salesAccountName: string; priceMinor: number; currency: string; status: string };
type ChecklistAnswer = { code: string; label: string; result: InspectionResult | ''; note: string };
type InspectionNotes = { version: 'certified-v1'; overallNote: string; checklist: ChecklistAnswer[] };

const CERTIFIED_V1_CHECKLIST: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'appearance', label: '外观' },
  { code: 'power', label: '开机' },
  { code: 'screen', label: '屏幕' },
  { code: 'buttons', label: '按键' },
  { code: 'usb_c', label: 'USB-C' },
  { code: 'camera', label: '相机' },
  { code: 'recording', label: '录像' },
  { code: 'gimbal', label: '云台' },
  { code: 'microphone', label: '麦克风' },
  { code: 'wireless', label: 'Wi-Fi / Bluetooth' },
  { code: 'battery', label: '电池' },
  { code: 'firmware', label: '固件 / 系统状态' }
];
const RESULT_OPTIONS: InspectionResult[] = ['PASS', 'FAIL', 'ADVISORY', 'N/A'];
const GRADE_OPTIONS: Grade[] = ['A+', 'A', 'B+', 'B', 'Parts / Repair'];

const errorText = (error: unknown) => error instanceof ApiClientError ? error.message : '操作未完成，请稍后重试。';
const formatMoney = (minor: number, currency: string) => new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(minor / 100);
const dateTime = (value: string | null | undefined) => {
  if (!value) return '—';
  const normalized = value.includes('T') || value.endsWith('Z') ? value : `${value.replace(' ', 'T')}Z`;
  const valueDate = new Date(normalized);
  return Number.isNaN(valueDate.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', hour12: false }).format(valueDate);
};
const statusText = (status: string) => ({ assigned: '待检测', in_progress: '检测中', completed: '待 Final QC', failed: '检测未通过', cancelled: '已取消' } as Record<string, string>)[status] ?? status;
const resultText = (result: InspectionResult) => ({ PASS: '通过', FAIL: '不通过', ADVISORY: '建议项', 'N/A': '不适用' } as Record<InspectionResult, string>)[result];
const emptyChecklist = (): ChecklistAnswer[] => CERTIFIED_V1_CHECKLIST.map((item) => ({ ...item, result: '', note: '' }));
const parseInspectionNotes = (notes: string): InspectionNotes => {
  try {
    const parsed = JSON.parse(notes) as Partial<InspectionNotes>;
    if (parsed.version === 'certified-v1' && Array.isArray(parsed.checklist)) {
      const byCode = new Map(parsed.checklist.map((item) => [item.code, item]));
      return { version: 'certified-v1', overallNote: parsed.overallNote ?? '', checklist: emptyChecklist().map((item) => ({ ...item, ...(byCode.get(item.code) ?? {}) })) };
    }
  } catch { /* Legacy notes are shown as an overall note. */ }
  return { version: 'certified-v1', overallNote: notes || '', checklist: emptyChecklist() };
};
const canFinalQc = (user: SessionUser) => user.permissions.includes('data:read:all') || user.permissions.includes('certified:final-qc');

function Loading({ text = '正在加载…' }: { text?: string }) { return <div className="certified-loading" role="status">{text}</div>; }
function Notice({ tone, children }: { tone: 'success' | 'error' | 'info'; children: string }) { return <div className={`notice notice--${tone === 'success' ? 'success' : tone}`}>{children}</div>; }
function StatusBadge({ status }: { status: string }) { return <span className={`status certified-status certified-status--${status}`}>{statusText(status)}</span>; }

function CertifiedTasks({ user, route, logout, finalQcOnly = false }: Props & { finalQcOnly?: boolean }) {
  const [tasks, setTasks] = useState<InspectionTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const load = useCallback(() => {
    setLoading(true); setError('');
    api<{ tasks: InspectionTask[] }>('/certified/tasks').then((value) => setTasks(value.tasks)).catch((reason) => setError(errorText(reason))).finally(() => setLoading(false));
  }, []);
  useEffect(() => { void load(); }, [load]);
  const visible = useMemo(() => tasks.filter((task) => {
    if (finalQcOnly && (!['completed', 'failed'].includes(task.status) || task.finalQc === 1)) return false;
    if (!finalQcOnly && status !== 'all' && task.status !== status) return false;
    const query = search.trim().toLowerCase();
    return !query || `${task.assetCode} ${task.currentSn ?? ''} ${task.productName}`.toLowerCase().includes(query);
  }), [finalQcOnly, search, status, tasks]);
  const start = async (task: InspectionTask) => {
    setError('');
    try {
      await api(`/certified/tasks/${task.id}/start`, { method: 'POST' });
      location.hash = `#/system/certified/tasks/${task.id}`;
    } catch (reason) { setError(errorText(reason)); }
  };
  return <Shell user={user} route={route} title={finalQcOnly ? '待最终审核' : 'Certified 检测工作台'} subtitle={finalQcOnly ? '复核检测结果与证据后签发 MaxCINE Certified。' : '仅显示当前账户有权查看和处理的检测任务。'} logout={logout}>
    {error && <Notice tone="error">{error}</Notice>}
    <div className="certified-toolbar">
      <input aria-label="搜索任务" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索 Asset Code 或 SN" />
      {!finalQcOnly && <select aria-label="筛选状态" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">全部状态</option><option value="assigned">待检测</option><option value="in_progress">检测中</option><option value="completed">已提交</option><option value="failed">未通过</option><option value="cancelled">已取消</option></select>}
      {canFinalQc(user) && <a className="button button--secondary" href="#/system/certified/final-qc">待最终审核</a>}
    </div>
    {loading ? <Loading /> : <div className="table-wrap"><table className="certified-task-table"><thead><tr><th>Asset Code</th><th>Product</th><th>SN 尾号</th><th>Status</th><th>Assigned</th><th>Started</th><th>Grade</th><th>操作</th></tr></thead><tbody>
      {visible.map((task) => <tr key={task.id}><td><strong>{task.assetCode}</strong></td><td>{task.productName}<small>{task.productVersion || ''}</small></td><td>{task.currentSn ? task.currentSn.slice(-6) : '—'}</td><td><StatusBadge status={task.status} /></td><td>{dateTime(task.createdAt)}</td><td>{dateTime(task.startedAt)}</td><td>{task.grade || '—'}</td><td>{task.status === 'assigned' && !finalQcOnly ? <button className="button" onClick={() => void start(task)}>开始检测</button> : <a className="button button--secondary" href={`#/system/certified/tasks/${task.id}`}>{task.status === 'in_progress' ? '继续检测' : finalQcOnly ? 'Review' : '查看结果'}</a>}</td></tr>)}
    </tbody></table>{!visible.length && <div className="empty-state"><h2>{finalQcOnly ? '当前没有待最终审核任务。' : '当前没有符合条件的检测任务。'}</h2><p>新任务分配后会自动出现在这里。</p></div>}</div>}
  </Shell>;
}

function EvidenceGallery({ evidence }: { evidence: Evidence[] }) {
  if (!evidence.length) return <div className="certified-evidence-empty">尚未上传 Evidence。</div>;
  return <div className="certified-evidence-grid">{evidence.map((item) => <article key={item.id} className="certified-evidence-card">
    {item.evidenceType === 'photo' && item.contentUrl ? <a href={apiResourceUrl(item.contentUrl)} target="_blank" rel="noreferrer"><img src={apiResourceUrl(item.contentUrl)} alt={item.metadata?.originalFilename || '检测照片'} /></a> : <div className="certified-evidence-file">{item.evidenceType.toUpperCase()}</div>}
    <strong>{item.metadata?.originalFilename || item.evidenceType}</strong><span>{item.createdByName || '检测人员'} · {dateTime(item.createdAt)}</span>{item.contentText && <p>{item.contentText}</p>}
  </article>)}</div>;
}

function InspectionTaskPage({ user, route, logout, taskId }: Props & { taskId: string }) {
  const [data, setData] = useState<TaskDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [checklist, setChecklist] = useState<ChecklistAnswer[]>(emptyChecklist);
  const [overallResult, setOverallResult] = useState<InspectionResult>('PASS');
  const [grade, setGrade] = useState<Grade | ''>('');
  const [overallNote, setOverallNote] = useState('');
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmQc, setConfirmQc] = useState(false);
  const load = useCallback(() => {
    setLoading(true);
    api<TaskDetailResponse>(`/certified/tasks/${taskId}`).then((value) => {
      setData(value);
      const notes = parseInspectionNotes(value.task.notes);
      setChecklist(notes.checklist);
      setOverallNote(notes.overallNote);
      setOverallResult(value.task.result ?? 'PASS');
      setGrade(value.task.grade ?? '');
    }).catch((reason) => setNotice({ tone: 'error', text: errorText(reason) })).finally(() => setLoading(false));
  }, [taskId]);
  useEffect(() => { void load(); }, [load]);
  const editable = data?.task.status === 'in_progress';
  const updateItem = (index: number, values: Partial<ChecklistAnswer>) => setChecklist((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...values } : item));
  const uploadPhoto = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return setNotice({ tone: 'error', text: '检测照片仅支持 JPG、PNG 或 WebP。' });
    const form = new FormData(); form.set('evidenceType', 'photo'); form.set('file', file);
    setUploadProgress(0); setNotice({ tone: 'info', text: `正在上传 ${file.name}…` });
    try {
      const uploaded = await uploadFormData<Evidence>(`/certified/tasks/${taskId}/evidence`, form, setUploadProgress);
      setData((current) => current ? { ...current, evidence: [...current.evidence, uploaded] } : current);
      setNotice({ tone: 'success', text: 'Photo Evidence 上传成功。' });
    } catch (reason) { setNotice({ tone: 'error', text: errorText(reason) }); }
    finally { setUploadProgress(null); }
  };
  const submit = async () => {
    const missing = checklist.filter((item) => !item.result);
    if (missing.length) return setNotice({ tone: 'error', text: `请完成全部检测项目：${missing.map((item) => item.label).join('、')}` });
    const missingReasons = checklist.filter((item) => (item.result === 'FAIL' || item.result === 'ADVISORY') && !item.note.trim());
    if (missingReasons.length) return setNotice({ tone: 'error', text: `FAIL / ADVISORY 必须填写说明：${missingReasons.map((item) => item.label).join('、')}` });
    if (!grade) return setNotice({ tone: 'error', text: '请选择 Grade 后再完成检测。' });
    setSubmitting(true); setNotice(null);
    try {
      await api(`/certified/tasks/${taskId}/complete`, { method: 'POST', body: JSON.stringify({ result: overallResult, grade, finalQc: false, notes: JSON.stringify({ version: 'certified-v1', overallNote, checklist } satisfies InspectionNotes) }) });
      setNotice({ tone: 'success', text: '检测已提交，正在等待 Final QC。' });
      await load();
    } catch (reason) { setNotice({ tone: 'error', text: errorText(reason) }); }
    finally { setSubmitting(false); }
  };
  const approve = async () => {
    setSubmitting(true); setNotice(null);
    try {
      const result = await api<{ certificationId: string; verificationCode?: string }>(`/certified/tasks/${taskId}/final-qc`, { method: 'POST', body: JSON.stringify({ action: 'approve', notes: 'Final QC approved in Certified workspace' }) });
      setNotice({ tone: 'success', text: `Certified 已签发 · ${result.certificationId}${result.verificationCode ? ` · 验证码 ${result.verificationCode}` : ''}` });
      setConfirmQc(false);
      await load();
    } catch (reason) { setNotice({ tone: 'error', text: errorText(reason) }); }
    finally { setSubmitting(false); }
  };
  return <Shell user={user} route={route} title="Certified 检测" subtitle={data?.task.assetCode || '正在加载检测任务'} logout={logout}>
    {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
    {loading ? <Loading /> : !data ? <div className="empty-state"><h2>无法加载检测任务。</h2></div> : <div className="certified-task-page">
      <section className="panel certified-identity"><div><StatusBadge status={data.task.status} /><h2>{data.task.assetCode}</h2><p>{data.task.productName} {data.task.productVersion}</p></div><dl><dt>Current SN</dt><dd>{data.task.currentSn || '—'}</dd><dt>Inspector</dt><dd>{data.task.assignedToName || '—'}</dd><dt>Started At</dt><dd>{dateTime(data.task.startedAt)}</dd></dl></section>
      <section className="panel"><div className="panel-title"><h2>V1 检测项目</h2><span>{checklist.filter((item) => item.result).length} / {checklist.length}</span></div><div className="certified-checklist">{checklist.map((item, index) => <article key={item.code} className={`certified-check-item certified-check-item--${item.result || 'pending'}`}><div><strong>{item.label}</strong><div className="certified-result-options">{RESULT_OPTIONS.map((result) => <label key={result}><input type="radio" name={`result-${item.code}`} value={result} checked={item.result === result} disabled={!editable} onChange={() => updateItem(index, { result })} /><span>{resultText(result)}</span></label>)}</div></div><label>Note<textarea value={item.note} disabled={!editable} onChange={(event) => updateItem(index, { note: event.target.value })} placeholder={item.result === 'FAIL' || item.result === 'ADVISORY' ? '必须填写原因或建议' : '可选说明'} /></label></article>)}</div></section>
      <section className="panel"><div className="panel-title"><h2>Photo Evidence</h2><span>JPG / PNG / WebP，最大 25MB</span></div>{editable && <label className="certified-upload-button"><input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => void uploadPhoto(event)} disabled={uploadProgress !== null} /><span>{uploadProgress === null ? '选择并上传照片' : `上传中 ${uploadProgress}%`}</span></label>}{uploadProgress !== null && <progress className="certified-progress" max="100" value={uploadProgress} />}<EvidenceGallery evidence={data.evidence} /></section>
      <section className="panel certified-submit"><div className="panel-title"><h2>检测结论</h2><span>Grade 与配件完整度独立记录</span></div><div className="certified-conclusion"><label>Overall Result<select value={overallResult} disabled={!editable} onChange={(event) => setOverallResult(event.target.value as InspectionResult)}>{RESULT_OPTIONS.map((result) => <option key={result} value={result}>{result} · {resultText(result)}</option>)}</select></label><label>Grade<select value={grade} disabled={!editable} onChange={(event) => setGrade(event.target.value as Grade | '')}><option value="">请选择 Grade</option>{GRADE_OPTIONS.map((value) => <option key={value}>{value}</option>)}</select></label></div><label>Overall Note<textarea value={overallNote} disabled={!editable} onChange={(event) => setOverallNote(event.target.value)} placeholder="补充整体检测结论" /></label>{editable && <button className="button certified-primary-action" disabled={submitting || uploadProgress !== null} onClick={() => void submit()}>{submitting ? '正在提交…' : '完成检测'}</button>}
        {!editable && data.task.finalQc !== 1 && data.canFinalQc && data.task.status === 'completed' && <div className="certified-qc-action"><div><strong>Final QC</strong><p>{confirmQc ? '签发后将生成认证记录和 Lifecycle Event。确认继续？' : '请确认所有检测项目、说明、Evidence 和 Grade 后签发认证。'}</p></div><div className="action-list">{confirmQc ? <><button className="button" disabled={submitting} onClick={() => void approve()}>{submitting ? '正在签发…' : '确认签发 Certified'}</button><button className="button button--secondary" disabled={submitting} onClick={() => setConfirmQc(false)}>返回</button></> : <button className="button" onClick={() => setConfirmQc(true)}>Approve & Certify</button>}</div></div>}
        {data.task.finalQc === 1 && <Notice tone="success">Final QC 已完成，MaxCINE Certified 已签发。</Notice>}
      </section>
    </div>}
  </Shell>;
}

function WarehouseAssets({ user, route, logout, ukOnly }: Props & { ukOnly?: boolean }) {
  const [assets, setAssets] = useState<WarehouseAsset[]>([]);
  const [error, setError] = useState('');
  useEffect(() => { api<{ assets: WarehouseAsset[] }>(`/international/warehouses/assets${ukOnly ? '?warehouseId=wh-uk' : ''}`).then((value) => setAssets(value.assets)).catch((reason) => setError(errorText(reason))); }, [ukOnly]);
  return <Shell user={user} route={route} title={ukOnly ? 'UK 库存' : '全球 Certified 库存'} subtitle="以同一 Asset 为中心；不替换国内新品库存。" logout={logout}>{error && <Notice tone="error">{error}</Notice>}<div className="table-wrap"><table><thead><tr><th>Asset / SN</th><th>产品</th><th>仓库</th><th>状态</th></tr></thead><tbody>{assets.map((asset) => <tr key={asset.assetId}><td>{asset.assetCode || asset.currentSn || asset.assetId}</td><td>{asset.productName}</td><td>{asset.warehouseCode}</td><td>{asset.status}</td></tr>)}</tbody></table>{!assets.length && <div className="empty-state"><h2>暂无可见库存。</h2></div>}</div></Shell>;
}

function Listings({ user, route, logout }: Props) {
  const [listings, setListings] = useState<Listing[]>([]);
  const [error, setError] = useState('');
  useEffect(() => { api<{ listings: Listing[] }>('/marketplace/listings').then((value) => setListings(value.listings)).catch((reason) => setError(errorText(reason))); }, []);
  return <Shell user={user} route={route} title="渠道与 Listing" subtitle="每台 Asset 保留完整 Listing 历史。" logout={logout}>{error && <Notice tone="error">{error}</Notice>}<div className="table-wrap"><table><thead><tr><th>Asset / SN</th><th>Listing</th><th>渠道</th><th>销售账号</th><th>价格</th><th>状态</th></tr></thead><tbody>{listings.map((listing) => <tr key={listing.id}><td>{listing.currentSn || '—'}</td><td>{listing.title}</td><td>{listing.channelCode}</td><td>{listing.salesAccountName}</td><td>{formatMoney(listing.priceMinor, listing.currency)}</td><td>{listing.status}</td></tr>)}</tbody></table>{!listings.length && <div className="empty-state"><h2>暂无 Listing。</h2></div>}</div></Shell>;
}

function InternationalHome({ user, route, logout, title, subtitle, mode }: Props & { title: string; subtitle: string; mode: 'certified' | 'international' | 'uk' }) {
  if (mode === 'certified') return <CertifiedTasks user={user} route={route} logout={logout} />;
  const cards = mode === 'uk' ? [['UK 库存', '/system/uk-fulfilment/inventory', '查看可履约 Asset'], ['UK 订单', '/system/uk-fulfilment/orders', '处理待发订单'], ['UK RMA', '/system/uk-fulfilment/rma', '处理退货与售后']] : [['Certified 检测', '/system/certified', '处理认证任务'], ['全球库存', '/system/international/inventory', '查看 Asset 位置'], ['渠道与 Listing', '/system/international/listings', '管理 Listing 历史'], ['UK 履约', '/system/uk-fulfilment/inventory', 'UK 库存与发货']];
  return <Shell user={user} route={route} title={title} subtitle={subtitle} logout={logout}><div className="stats operations-stats">{cards.map(([label, href, detail]) => <a className="stat" href={`#${href}`} key={href}><p>{label}</p><strong>→</strong><span>{detail}</span></a>)}</div></Shell>;
}

export function InternationalPortal({ user, route, logout, mode }: Props & { mode: 'certified' | 'international' | 'uk' }) {
  const path = route.split('?')[0];
  const taskMatch = path.match(/^\/system\/certified\/tasks\/([^/]+)$/);
  if (taskMatch) return <InspectionTaskPage user={user} route={route} logout={logout} taskId={taskMatch[1]} />;
  if (path === '/system/certified/final-qc' && canFinalQc(user)) return <CertifiedTasks user={user} route={route} logout={logout} finalQcOnly />;
  if (path === '/system/certified' || path === '/system/certified/tasks') return <CertifiedTasks user={user} route={route} logout={logout} />;
  if (path.endsWith('/inventory')) return <WarehouseAssets user={user} route={route} logout={logout} ukOnly={mode === 'uk'} />;
  if (path === '/system/international/listings') return <Listings user={user} route={route} logout={logout} />;
  const copy = mode === 'uk' ? ['UK 履约工作台', '仅访问 UK 库存、订单、发货、退货和 RMA。'] : ['国际业务工作台', '认证、国际库存、调拨、渠道、订单和售后共用核心业务底座。'];
  return <InternationalHome user={user} route={route} logout={logout} title={copy[0]} subtitle={copy[1]} mode={mode} />;
}
