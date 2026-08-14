import { useState, type ReactNode } from 'react';
import type { SessionUser } from '@maxcine/shared';
import { api } from './api';
import { AccountMenu, SystemNavigation, displayRoleText } from './systemNavigation';

type Props = {
  user: SessionUser;
  route: string;
  logout: () => void;
};

function Shell({ user, route, logout, children }: Props & { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const signOut = async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } finally {
      logout();
    }
  };
  return <div className="system">
    <header className="system-top">
      <img className="system-light-logo" src="/assets/maxcine-logo-on-light.png" alt="MaxCINE" />
      <button className="menu-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>菜单</button>
      <a className="global-search" href="#/system/intelligence" aria-label="MaxCINE Intelligence">MaxCINE Intelligence</a>
      <a className="top-notifications" href="#/system/notifications" aria-label="查看站内通知">通知</a>
      <AccountMenu user={user} logout={() => void signOut()} />
    </header>
    <aside className={`system-nav ${open ? 'is-open' : ''}`}>
      <img className="system-dark-logo" src="/assets/maxcine-logo-on-dark.png" alt="MaxCINE" />
      <SystemNavigation user={user} route={route} onNavigate={() => setOpen(false)} />
    </aside>
    <main className="system-main">
      <header className="page-title">
        <span className="eyebrow">MAXCINE / {displayRoleText(user)}</span>
        <h1>MaxCINE Intelligence</h1>
        <p>智能业务辅助平台</p>
      </header>
      {children}
    </main>
  </div>;
}

export function IntelligencePortal({ user, route, logout }: Props) {
  return <Shell user={user} route={route} logout={logout}>
    <section className="panel intelligence-coming-soon" aria-labelledby="intelligence-title">
      <span className="tag">IN DEVELOPMENT</span>
      <h2 id="intelligence-title">MaxCINE Intelligence</h2>
      <p className="intelligence-subtitle">智能业务辅助平台</p>
      <p>MaxCINE Intelligence 正在开发中。该功能将在后续系统更新中开放。</p>
      <strong>Coming Soon</strong>
    </section>
  </Shell>;
}
