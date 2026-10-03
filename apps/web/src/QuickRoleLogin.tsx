/* eslint-disable react-refresh/only-export-components */
import { useState } from 'react';
import { api, ApiClientError, type LoginResponse } from './api';

type QuickPersona = 'ADMIN' | 'CN_SD_WAREHOUSE' | 'CERTIFIED' | 'INTERNATIONAL' | 'UK_FULFILMENT';

const quickRoles: Array<{ persona: QuickPersona; title: string; description: string }> = [
  { persona: 'ADMIN', title: '管理员', description: '查看全部模块' },
  { persona: 'CN_SD_WAREHOUSE', title: '山东总仓', description: '收货 / 库存 / 调拨' },
  { persona: 'CERTIFIED', title: '检测中心', description: '检测任务 / Final QC / Certified' },
  { persona: 'INTERNATIONAL', title: '国际运营', description: '全球资产 / 调拨 / Listings / Orders' },
  { persona: 'UK_FULFILMENT', title: '英国履约', description: 'UK库存 / 收货 / 发货 / RMA' }
];

export function isTestEnvironment(): boolean {
  const environment = import.meta.env.VITE_APP_ENV;
  const host = location.hostname;
  return environment === 'development' || environment === 'staging'
    || host === 'localhost' || host === '127.0.0.1' || host === '::1'
    || host === 'maxcine-web-staging.pages.dev';
}

async function selectQuickRole(persona: QuickPersona): Promise<void> {
  await api<LoginResponse>('/dev/quick-login', { method: 'POST', body: JSON.stringify({ persona }) });
  location.hash = '#/';
  location.reload();
}

export function QuickRoleButtons() {
  const [loading, setLoading] = useState<QuickPersona | null>(null);
  const [error, setError] = useState('');
  if (!isTestEnvironment()) return null;
  async function signIn(persona: QuickPersona) {
    setLoading(persona);
    setError('');
    try { await selectQuickRole(persona); }
    catch (reason) {
      setError(reason instanceof ApiClientError ? reason.message : '快捷登录暂时不可用，请稍后重试。');
      setLoading(null);
    }
  }
  return <section className="quick-role-login" aria-label="测试角色快捷登录">
    <div className="quick-role-login__heading"><strong>测试角色快捷登录</strong><span>仅限 STAGING TEST ENVIRONMENT</span></div>
    <div className="quick-role-login__grid">
      {quickRoles.map((role) => <button key={role.persona} type="button" className="quick-role-login__button" disabled={loading !== null} onClick={() => void signIn(role.persona)}>
        <strong>{loading === role.persona ? '正在登录…' : role.title}</strong><small>{role.description}</small>
      </button>)}
    </div>
    {error && <div className="notice notice--error">{error}</div>}
  </section>;
}

export function QuickRoleSwitcher() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState<QuickPersona | null>(null);
  const [error, setError] = useState('');
  if (!isTestEnvironment()) return null;
  async function switchRole(persona: QuickPersona) {
    setLoading(persona);
    setError('');
    try { await selectQuickRole(persona); }
    catch (reason) {
      setError(reason instanceof ApiClientError ? reason.message : '切换测试角色失败，请稍后重试。');
      setLoading(null);
    }
  }
  return <div className="quick-role-switcher">
    <button type="button" className="account-switch-role" onClick={() => setOpen(!open)} aria-expanded={open}>切换测试角色</button>
    {open && <div className="quick-role-switcher__options">
      {quickRoles.map((role) => <button key={role.persona} type="button" disabled={loading !== null} onClick={() => void switchRole(role.persona)}>
        <strong>{loading === role.persona ? '正在切换…' : role.title}</strong><small>{role.description}</small>
      </button>)}
      {error && <span className="quick-role-switcher__error">{error}</span>}
    </div>}
  </div>;
}
