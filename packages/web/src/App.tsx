import { useCallback, useEffect, useState } from 'react';
import { formatMoney, LOCAL_CURRENCY } from '@unresub/core';
import { api, ApiError, auth, type Account, type AuthStatus, type User, type CatalogEntry, type TransactionRow, type Source, type SubscriptionItem, type SubscriptionsResponse } from './api.ts';
import { daysUntil } from './format.ts';
import { useTheme } from './theme.ts';
import { AccountSheet } from './components/AccountSheet.tsx';
import { AlertBanner } from './components/AlertBanner.tsx';
import { CardsTab } from './components/CardsTab.tsx';
import { Icon, type IconName } from './components/Icon.tsx';
import { SubscriptionsTable } from './components/SubscriptionsTable.tsx';
import { useMedia } from './hooks.ts';
import { Enrol, Login, Logo, RecoveryCodes } from './components/Login.tsx';
import { Summary } from './components/Summary.tsx';
import { SubscriptionRow } from './components/SubscriptionRow.tsx';
import { SubscriptionSheet } from './components/SubscriptionSheet.tsx';
import { SyncProgress } from './components/SyncProgress.tsx';
import { TransactionSheet } from './components/TransactionSheet.tsx';
import { TransactionsTab } from './components/TransactionsTab.tsx';
import { Toast } from './components/Toast.tsx';

type Tab = 'subs' | 'tx' | 'cards';

export const App = () => {
  // undefined: loading; null: server unreachable.
  const [status, setStatus] = useState<AuthStatus | null | undefined>(undefined);
  const [codes, setCodes] = useState<string[] | null>(null);
  const refresh = useCallback(() => auth.status().then(setStatus, () => setStatus(null)), []);
  useEffect(() => void refresh(), [refresh]);

  const signOut = async (server = true) => {
    await (server ? auth.logout() : auth.forget());
    void refresh();
  };
  const user = status?.user;
  if (status === undefined) return <main className="login" aria-busy><Logo size={28} /></main>;
  if (codes?.length) return <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />;
  if (!user) {
    return (
      <Login
        key={String(status?.setupRequired)}
        status={status}
        onDone={r => (setCodes(r.recoveryCodes ?? null), setStatus(s => s && { ...s, setupRequired: false, user: r.user, mustEnrol: r.mustEnrol }))}
        onServerChange={() => void refresh()}
      />
    );
  }
  if (status.mustEnrol) {
    return <Enrol username={user.username} onDone={c => (setCodes(c), setStatus(s => s && { ...s, mustEnrol: false }))} onCancel={() => void signOut()} />;
  }
  return <Dashboard user={user} onLogout={() => void signOut()} onExpired={() => void signOut(false)} />;
};

const Dashboard = ({ user, onLogout, onExpired }: { user: User; onLogout: () => void; onExpired: () => void }) => {
  const [accountOpen, setAccountOpen] = useState(false);
  const [data, setData] = useState<SubscriptionsResponse | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [txn, setTxn] = useState<TransactionRow | null>(null);
  const [txVersion, setTxVersion] = useState(0);
  const [tab, setTab] = useState<Tab>('subs');
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; undo: () => Promise<unknown> } | null>(null);
  const theme = useTheme();
  const desktop = useMedia('(min-width: 960px)');

  const load = useCallback(async () => {
    try {
      const [subs, srcs, accs] = await Promise.all([api.subscriptions(), api.sources(), api.accounts()]);
      setData(subs);
      setSources(srcs);
      setAccounts(accs);
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return onExpired();
      setError((e as Error).message);
    }
  }, [onExpired]);

  useEffect(() => {
    void load();
    void api.catalog().then(setCatalog, () => {});
  }, [load]);

  // Poll while a sync is running so progress moves and new subscriptions appear during the backfill.
  const syncing = sources.some(s => s.sync.running);
  useEffect(() => {
    if (!syncing) return;
    const t = setInterval(() => void load(), 5_000);
    return () => clearInterval(t);
  }, [syncing, load]);

  // Refetch transactions once a sync finishes.
  useEffect(() => {
    if (!syncing) setTxVersion(v => v + 1);
  }, [syncing]);

  useEffect(() => {
    scrollTo({ top: 0 });
  }, [tab]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6_000);
    return () => clearTimeout(t);
  }, [toast]);

  /** "Not a subscription": its charges go back to Transactions; the server keeps detection from proposing it again. */
  const hide = async (s: SubscriptionItem) => {
    setOpenKey(null);
    // Drop it from the list right away; the reload confirms.
    setData(d => d && { ...d, items: d.items.filter(i => i.key !== s.key) });
    try {
      const { batch } = await api.dismiss(s.key);
      setToast({ text: `${s.name} moved to Transactions`, undo: () => api.undoDismiss(batch) });
    } catch (e) {
      setError((e as Error).message);
    }
    setTxVersion(v => v + 1);
    void load();
  };
  /** Archive (cancelled or ended) with undo. A new charge brings it back on its own. */
  const archive = async (s: SubscriptionItem) => {
    setOpenKey(null);
    setData(d => d && { ...d, items: d.items.map(i => (i.key === s.key ? { ...i, lifecycle: 'archived', archivedBy: 'user' } : i)) });
    try {
      await api.archive(s.key);
      setToast({ text: `${s.name} archived`, undo: () => api.archive(s.key, false) });
    } catch (e) {
      setError((e as Error).message);
    }
    void load();
  };
  /** Back to the list from Archived. */
  const restore = async (s: SubscriptionItem) => {
    await api.archive(s.key, false).catch(e => setError((e as Error).message));
    setToast({ text: `${s.name} restored`, undo: () => api.archive(s.key) });
    void load();
  };

  // A key from a transaction can be older than the list (a series merged or moved cards since).
  const matches = (key: string | null) => (i: SubscriptionItem) => i.key === key || i.merged.some(m => m.key === key);
  const open = (openKey && data?.items.find(matches(openKey))) || null;
  const openSubscription = (key: string) => {
    setTxn(null);
    setOpenKey(key);
    if (data?.items.some(matches(key))) return;
    // Not in the list yet (a charge that just arrived): reload, the sheet opens once it is there.
    api.subscriptions().then(
      subs => (setData(subs), !subs.items.some(matches(key)) && setError('That subscription is no longer in the list.')),
      e => setError((e as Error).message),
    );
  };
  // Largest shortfall per card (alerts are cumulative, so the last one wins).
  const shortfall = new Map(data?.alerts.flatMap(a => (a.type === 'low_balance' ? [[a.accountId, { amount: a.shortfall, currency: a.currency }] as const] : [])));
  const lowBalance = shortfall.size > 0;

  const subsContent = !data ? (
    <Skeleton />
  ) : desktop ? (
    <SubscriptionsTable data={data} sources={sources} onOpen={setOpenKey} onOpenCards={() => setTab('cards')} onHide={hide} onArchive={archive} onRestore={restore} />
  ) : (
    <SubscriptionsTab data={data} sources={sources} syncing={syncing} onOpen={setOpenKey} onOpenCards={() => setTab('cards')} onHide={hide} onArchive={archive} onRestore={restore} />
  );
  const content =
    tab === 'subs' ? subsContent
    : tab === 'tx' ? <TransactionsTab accounts={accounts} version={txVersion} onOpenTransaction={setTxn} />
    : <CardsTab sources={sources} accounts={accounts} shortfall={shortfall} onChange={load} />;
  const errorBox = error && (
    <div className="alert danger" style={{ marginBottom: 14 }}>
      <span className="alert-icon"><Icon name="alert" /></span>
      <div className="alert-body"><strong>{error}</strong></div>
    </div>
  );
  const themeBtn = (
    <button className="icon-btn" onClick={theme.cycle} aria-label={`Theme: ${theme.pref}`} title={`Theme: ${theme.pref}`}>
      <Icon name={theme.pref === 'light' ? 'sun' : theme.pref === 'dark' ? 'moon' : 'auto'} />
    </button>
  );
  const navItems: { id: Tab; label: string; icon: IconName; badge?: string | number; dot?: string }[] = [
    { id: 'subs', label: 'Subscriptions', icon: 'list', badge: data?.totals.count },
    { id: 'tx', label: 'Transactions', icon: 'receipt' },
    { id: 'cards', label: 'Cards', icon: 'card', dot: lowBalance ? 'var(--danger)' : syncing ? 'var(--accent)' : undefined },
  ];
  const owner = user.username;

  return (
    <div className={desktop ? 'desk' : 'app'}>
      {desktop ? (
        <>
          <header className="desk-header">
            <div className="desk-header-in">
              <div className="brand">
                <Logo />
                <span>Un<span className="brand-accent">ReSub</span></span>
              </div>
              <div className="topbar-actions">
                {syncing && <span className="pill accent"><Icon name="refresh" size={14} /> Syncing</span>}
                {themeBtn}
                <span className="vsep" />
                <button className="avatar" onClick={() => setAccountOpen(true)} title="Account" aria-label="Account">
                  {initials(owner)}
                  <span className="avatar-hover"><Icon name="user" size={16} /></span>
                </button>
              </div>
            </div>
          </header>
          <div className="desk-body">
            <aside className="desk-side card">
              <div className="profile">
                <span className="avatar static">{initials(owner)}</span>
                <div>
                  <strong>{owner}</strong>
                  {user.isAdmin && <span className="xs muted">Admin</span>}
                </div>
              </div>
              <nav className="side-nav">
                <div className="side-title">Overview</div>
                {navItems.map(n => (
                  <button key={n.id} className="side-item" aria-current={tab === n.id ? 'page' : undefined} onClick={() => setTab(n.id)}>
                    <span className="side-ico"><Icon name={n.icon} size={16} /></span>
                    {n.label}
                    {n.dot && <span className="side-dot" style={{ background: n.dot }} />}
                    {n.badge != null && <span className="side-badge num">{n.badge}</span>}
                  </button>
                ))}
              </nav>
              {data && (
                <div className="side-stat">
                  <span className="xs muted">Per month</span>
                  <strong className="num">{formatMoney(data.totals.monthlyLocal, LOCAL_CURRENCY)}</strong>
                </div>
              )}
              <button className="btn outline block" onClick={() => setTab('cards')}>
                <Icon name="plus" size={18} /> Connect monobank
              </button>
            </aside>
            <main className="desk-main card">
              {errorBox}
              {content}
            </main>
          </div>
        </>
      ) : (
        <>
          <header className="topbar">
            <div className="brand">
              <Logo />
              UnReSub
            </div>
            <div className="topbar-actions">
              {themeBtn}
              <button className="icon-btn" onClick={() => setAccountOpen(true)} aria-label="Account" title="Account">
                <Icon name="user" />
              </button>
            </div>
          </header>
          {errorBox}
          {content}
          <nav className="tabbar" role="tablist" style={{ gridTemplateColumns: `repeat(${navItems.length}, 1fr)` }}>
            {navItems.map(n => (
              <button key={n.id} className="tab" role="tab" aria-selected={tab === n.id} onClick={() => setTab(n.id)}>
                {n.dot && <span className="dot" style={{ background: n.dot }} />}
                <Icon name={n.icon} size={22} />
                {n.label}
              </button>
            ))}
          </nav>
        </>
      )}

      {open && (
        <SubscriptionSheet
          key={open.key}
          s={open}
          catalog={catalog}
          others={data?.items.filter(i => i.key !== open.key) ?? []}
          onClose={() => setOpenKey(null)}
          onSaved={() => (setOpenKey(null), void load())}
          onHide={() => void hide(open)}
          onRefresh={() => (setTxVersion(v => v + 1), void load())}
          onOpenTransaction={id => void api.similar(id).then(r => (setOpenKey(null), setTab('tx'), setTxn(r.transaction)), e => setError((e as Error).message))}
          onArchive={() => void archive(open)}
          onRestore={() => (setOpenKey(null), void restore(open))}
        />
      )}

      {txn && (
        <TransactionSheet
          key={txn.id}
          t={txn}
          account={accounts.find(a => a.id === txn.accountId)}
          catalog={catalog}
          onClose={() => setTxn(null)}
          onOpenSubscription={openSubscription}
          onCreated={key => (setTxn(null), setTxVersion(v => v + 1), void load().then(() => setOpenKey(key)))}
        />
      )}

      {accountOpen && <AccountSheet user={user} onClose={() => setAccountOpen(false)} onLogout={onLogout} />}

      {toast && (
        <Toast
          key={toast.text}
          text={toast.text}
          onUndo={() => { const t = toast; setToast(null); void t.undo().then(load); }}
          onDismiss={() => setToast(null)}
        />
      )}
    </div>
  );
};

type SubsProps = {
  sources: Source[];
  syncing: boolean;
  onOpen: (key: string) => void;
  onOpenCards: () => void;
  onHide: (s: SubscriptionItem) => void;
  onArchive: (s: SubscriptionItem) => void;
  onRestore: (s: SubscriptionItem) => void;
};

type SubsView = 'active' | 'inactive' | 'archived';

const SubscriptionsTab = ({ data, sources, syncing, onOpen, onOpenCards, onHide, onArchive, onRestore }: SubsProps & { data: SubscriptionsResponse }) => {
  const [view, setView] = useState<SubsView>('active');
  useEffect(() => {
    scrollTo({ top: 0 });
  }, [view]);

  const by = (l: SubscriptionItem['lifecycle']) => data.items.filter(i => i.lifecycle === l);
  const active = by('active').sort((a, b) => a.nextChargeAt - b.nextChargeAt);
  const inactive = by('inactive').sort((a, b) => b.lastChargeAt - a.lastChargeAt);
  const archived = by('archived').sort((a, b) => b.lastChargeAt - a.lastChargeAt);
  const lowKeys = new Set(data.alerts.flatMap(a => (a.type === 'low_balance' ? [a.key] : [])));
  const running = sources.find(s => s.sync.running);

  // Archived and Hidden live on their own screen, off the main list.
  if (view === 'archived') {
    const list = archived;
    return (
      <>
        <div className="subpage-head">
          <button className="icon-btn" onClick={() => setView('active')} aria-label="Back"><Icon name="chevronLeft" /></button>
          <h1 className="page-title">Archived</h1>
        </div>
        <p className="small muted" style={{ margin: '0 4px 14px' }}>
          A new charge moves a subscription back to Active.
        </p>
        {list.length ? (
          <ul className="list card dim-soft">
            {list.map(s => <SubscriptionRow key={s.key} s={s} lowBalance={false} onOpen={() => onOpen(s.key)} onRestore={() => onRestore(s)} />)}
          </ul>
        ) : (
          <div className="card empty small">No archived subscriptions.</div>
        )}
      </>
    );
  }

  const groups: [string, SubscriptionItem[]][] =
    view === 'active'
      ? [
          ['Next 7 days', active.filter(i => daysUntil(i.nextChargeAt) <= 7)],
          ['This month', active.filter(i => daysUntil(i.nextChargeAt) > 7 && daysUntil(i.nextChargeAt) <= 31)],
          ['Later', active.filter(i => daysUntil(i.nextChargeAt) > 31)],
        ]
      : [['No charge when expected', inactive]];

  return (
    <>
      <AlertBanner alerts={data.alerts} onOpenCards={onOpenCards} />
      {running && (
        <section className="card pad" style={{ marginBottom: 14 }}>
          <SyncProgress src={running} compact />
        </section>
      )}
      <Summary totals={data.totals} items={active} />

      <div className="seg seg-wide" role="tablist" style={{ marginTop: 20 }}>
        {([['active', 'Active', active.length], ['inactive', 'Inactive', inactive.length]] as const).map(([v, label, n]) => (
          <button key={v} role="tab" aria-pressed={view === v} aria-selected={view === v} onClick={() => setView(v)}>
            {label} <span className="faint num">{n}</span>
          </button>
        ))}
      </div>

      {view === 'active' && !active.length && (
        <div className="card empty section">
          <span className="svc"><Icon name={syncing ? 'clock' : 'sparkle'} /></span>
          <strong style={{ color: 'var(--text)' }}>{syncing ? 'Loading your statements…' : sources.length ? 'No subscriptions found' : 'Connect monobank to find your subscriptions.'}</strong>
          {!syncing && !!sources.length && <span className="small">A subscription appears after two charges from the same merchant. To add one sooner, open its charge in Transactions.</span>}
          {!sources.length && <button className="btn sm" onClick={onOpenCards}>Connect</button>}
        </div>
      )}
      {view === 'inactive' && (
        <p className="small muted" style={{ margin: '14px 4px 0' }}>
          {inactive.length ? 'These subscriptions missed their expected charge. Archive the ones you cancelled.' : 'Every subscription charged on time.'}
        </p>
      )}

      {groups.filter(([, list]) => list.length).map(([title, list]) => (
        <section key={title} className="section" style={{ marginTop: 18 }}>
          <div className="section-head">
            <h2>{title}</h2>
            {view === 'active' && <span className="sum num">{formatMoney(list.reduce((s, i) => s + i.localPrice, 0), LOCAL_CURRENCY)}</span>}
          </div>
          <ul className="list card">
            {list.map(s =>
              view === 'active' ? (
                <SubscriptionRow key={s.key} s={s} lowBalance={lowKeys.has(s.key)} onOpen={() => onOpen(s.key)} onHide={() => onHide(s)} />
              ) : (
                <SubscriptionRow key={s.key} s={s} lowBalance={false} onOpen={() => onOpen(s.key)} onArchive={() => onArchive(s)} />
              ),
            )}
          </ul>
        </section>
      ))}

      <div className="link-rows card section">
        <button onClick={() => setView('archived')}>
          <span className="side-ico"><Icon name="archive" size={16} /></span>
          Archived
          <span className="faint num">{archived.length}</span>
          <Icon name="chevron" size={16} className="faint" />
        </button>
      </div>
    </>
  );
};

const Skeleton = () => (
  <div className="stack" aria-busy>
    <div className="skeleton" style={{ height: 168, borderRadius: 24 }} />
    {[0, 1, 2, 3].map(i => <div key={i} className="skeleton" style={{ height: 64 }} />)}
  </div>
);

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('') || 'U';
