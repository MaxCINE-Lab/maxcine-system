import { useEffect, useState } from 'react';
import type { SessionUser } from '@maxcine/shared';
import { api, ApiClientError } from './api';
import { Shell } from './OperationsPortal';

type Props = { user: SessionUser; route: string; logout: () => void };
type InspectionTask = { id: string; assetId: string; assignedTo: string | null; status: string; result: string | null; grade: string | null; finalQc: number | null; currentSn: string | null; productName: string; updatedAt: string };
type WarehouseAsset = { assetId: string; currentSn: string | null; productName: string; status: string; warehouseCode: string };
type Listing = { id: string; currentSn: string | null; title: string; channelCode: string; salesAccountName: string; priceMinor: number; currency: string; status: string };

const errorText = (error: unknown) => error instanceof ApiClientError ? error.message : '数据加载失败，请稍后重试。';
const formatMoney = (minor: number, currency: string) => new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(minor / 100);

function CertifiedTasks({ user, route, logout }: Props) {
  const [tasks, setTasks] = useState<InspectionTask[]>([]);
  const [error, setError] = useState('');
  useEffect(() => { api<{ tasks: InspectionTask[] }>('/certified/tasks').then((value) => setTasks(value.tasks)).catch((reason) => setError(errorText(reason))); }, []);
  return <Shell user={user} route={route} title="Certified 检测任务" subtitle="仅展示当前账户可处理的单机检测任务。" logout={logout}>
    {error && <div className="notice notice--error">{error}</div>}
    <div className="table-wrap"><table><thead><tr><th>Asset / SN</th><th>产品</th><th>状态</th><th>结果</th><th>Grade</th><th>Final QC</th></tr></thead><tbody>
      {tasks.map((task) => <tr key={task.id}><td>{task.currentSn || task.assetId}</td><td>{task.productName || '—'}</td><td>{task.status}</td><td>{task.result || '待检'}</td><td>{task.grade || '—'}</td><td>{task.finalQc ? '完成' : '待完成'}</td></tr>)}
    </tbody></table>{!tasks.length && <div className="empty-state"><h2>暂无检测任务。</h2></div>}</div>
  </Shell>;
}

function WarehouseAssets({ user, route, logout, ukOnly }: Props & { ukOnly?: boolean }) {
  const [assets, setAssets] = useState<WarehouseAsset[]>([]);
  const [error, setError] = useState('');
  useEffect(() => { api<{ assets: WarehouseAsset[] }>(`/international/warehouses/assets${ukOnly ? '?warehouseId=wh-uk' : ''}`).then((value) => setAssets(value.assets)).catch((reason) => setError(errorText(reason))); }, [ukOnly]);
  return <Shell user={user} route={route} title={ukOnly ? 'UK 库存' : '全球 Certified 库存'} subtitle="以同一 Asset 为中心；不替换国内新品库存。" logout={logout}>
    {error && <div className="notice notice--error">{error}</div>}
    <div className="table-wrap"><table><thead><tr><th>Asset / SN</th><th>产品</th><th>仓库</th><th>状态</th></tr></thead><tbody>{assets.map((asset) => <tr key={asset.assetId}><td>{asset.currentSn || asset.assetId}</td><td>{asset.productName}</td><td>{asset.warehouseCode}</td><td>{asset.status}</td></tr>)}</tbody></table>{!assets.length && <div className="empty-state"><h2>暂无可见库存。</h2></div>}</div>
  </Shell>;
}

function Listings({ user, route, logout }: Props) {
  const [listings, setListings] = useState<Listing[]>([]);
  const [error, setError] = useState('');
  useEffect(() => { api<{ listings: Listing[] }>('/marketplace/listings').then((value) => setListings(value.listings)).catch((reason) => setError(errorText(reason))); }, []);
  return <Shell user={user} route={route} title="渠道与 Listing" subtitle="一机一 Listing；订单绑定时由服务端锁定 Asset。" logout={logout}>
    {error && <div className="notice notice--error">{error}</div>}
    <div className="table-wrap"><table><thead><tr><th>Asset / SN</th><th>Listing</th><th>渠道</th><th>销售账号</th><th>价格</th><th>状态</th></tr></thead><tbody>{listings.map((listing) => <tr key={listing.id}><td>{listing.currentSn || '—'}</td><td>{listing.title}</td><td>{listing.channelCode}</td><td>{listing.salesAccountName}</td><td>{formatMoney(listing.priceMinor, listing.currency)}</td><td>{listing.status}</td></tr>)}</tbody></table>{!listings.length && <div className="empty-state"><h2>暂无 Listing。</h2></div>}</div>
  </Shell>;
}

function InternationalHome({ user, route, logout, title, subtitle, mode }: Props & { title: string; subtitle: string; mode: 'certified' | 'international' | 'uk' }) {
  const cards = mode === 'certified'
    ? [['Certified 检测任务', '/system/certified/tasks', '处理分配任务']]
    : mode === 'uk'
      ? [['UK 库存', '/system/uk-fulfilment/inventory', '查看可履约 Asset'], ['UK 订单', '/system/uk-fulfilment/orders', '处理待发订单'], ['UK RMA', '/system/uk-fulfilment/rma', '处理退货与售后']]
      : [['Certified 检测', '/system/certified/tasks', '处理认证任务'], ['全球库存', '/system/international/inventory', '查看 Asset 位置'], ['渠道与 Listing', '/system/international/listings', '一机一 Listing'], ['UK 履约', '/system/uk-fulfilment/inventory', 'UK 库存与发货']];
  return <Shell user={user} route={route} title={title} subtitle={subtitle} logout={logout}><div className="stats operations-stats">
    {cards.map(([label, href, detail]) => <a className="stat" href={`#${href}`} key={href}><p>{label}</p><strong>→</strong><span>{detail}</span></a>)}
  </div></Shell>;
}

export function InternationalPortal({ user, route, logout, mode }: Props & { mode: 'certified' | 'international' | 'uk' }) {
  const path = route.split('?')[0];
  if (path === '/system/certified/tasks') return <CertifiedTasks user={user} route={route} logout={logout} />;
  if (path.endsWith('/inventory')) return <WarehouseAssets user={user} route={route} logout={logout} ukOnly={mode === 'uk'} />;
  if (path === '/system/international/listings') return <Listings user={user} route={route} logout={logout} />;
  const copy = mode === 'certified' ? ['Certified 工作台', '检测、证据、Final QC 与认证均绑定同一台 Asset。'] : mode === 'uk' ? ['UK 履约工作台', '仅访问 UK 库存、订单、发货、退货和 RMA。'] : ['国际业务工作台', '认证、国际库存、调拨、渠道、订单和售后共用核心业务底座。'];
  return <InternationalHome user={user} route={route} logout={logout} title={copy[0]} subtitle={copy[1]} mode={mode} />;
}
