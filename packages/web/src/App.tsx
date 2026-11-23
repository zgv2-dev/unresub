import { useCallback, useEffect, useState } from 'react';
import { formatMoney, LOCAL_CURRENCY } from '@unresub/core';
import { api, ApiError, getApiToken, setApiToken, type Account, type CatalogEntry, type Source, type SubscriptionItem, type SubscriptionsResponse } from './api.ts';
import { daysUntil } from './format.ts';
import { useTheme } from './theme.ts';
import { AlertBanner } from './components/AlertBanner.tsx';
import { CardsTab } from './components/CardsTab.tsx';
import { Icon } from './components/Icon.tsx';
import { Login, Logo } from './components/Login.tsx';
import { Summary } from './components/Summary.tsx';
import { SubscriptionRow } from './components/SubscriptionRow.tsx';
import { SubscriptionSheet } from './components/SubscriptionSheet.tsx';
import { SyncProgress } from './components/SyncProgress.tsx';

type Tab = 'subs' | 'cards';

export const App = () => {
  const [authed, setAuthed] = useState(!!getApiToken());
  return authed ? <Dashboard onLogout={() => (setApiToken(null), setAuthed(false))} /> : <Login onDone={() => setAuthed(true)} />;
};

const Dashboard = ({ onLogout }: { onLogout: () => void }) => {
  const [data, setData] = useState<SubscriptionsResponse | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('subs');
  const [error, setError] = useState<string | null>(null);
  const theme = useTheme();

  const load = useCallback(async () => {
    try {
      const [subs, srcs, accs] = await Promise.all([api.subscriptions(), api.sources(), api.accounts()]);
      setData(subs);
      setSources(srcs);
      setAccounts(accs);
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return onLogout();
      setError((e as Error).message);
    }
  }, [onLogout]);

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

  useEffect(() => {
    scrollTo({ top: 0 });
  }, [tab]);

  const open = data?.items.find(i => i.key === openKey) ?? null;
  // Largest shortfall per card (alerts are cumulative, so the last one wins).
  const shortfall = new Map(data?.alerts.flatMap(a => (a.type === 'low_balance' ? [[a.accountId, { amount: a.shortfall, currency: a.currency }] as const] : [])));
  const lowBalance = shortfall.size > 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Logo />
          UnReSub
        </div>
        <div className="topbar-actions">
          <button className="icon-btn" onClick={theme.cycle} aria-label={`Theme: ${theme.pref}`} title={`Theme: ${theme.pref}`}>
            <Icon name={theme.pref === 'light' ? 'sun' : theme.pref === 'dark' ? 'moon' : 'auto'} />
          </button>
          <button className="icon-btn" onClick={onLogout} aria-label="Log out" title="Log out">
            <Icon name="logout" />
          </button>
        </div>
      </header>

      {error && <div className="alert danger" style={{ marginBottom: 14 }}><span className="alert-icon"><Icon name="alert" /></span><div className="alert-body"><strong>Can't reach the server</strong><span>{error}</span></div></div>}

      {tab === 'subs' ? (
        <SubscriptionsTab data={data} sources={sources} syncing={syncing} onOpen={setOpenKey} onOpenCards={() => setTab('cards')} />
      ) : (
        <CardsTab sources={sources} accounts={accounts} shortfall={shortfall} onChange={load} />
      )}

      <nav className="tabbar" role="tablist">
        <button className="tab" role="tab" aria-selected={tab === 'subs'} onClick={() => setTab('subs')}>
          <Icon name="list" size={22} />
          Subscriptions
        </button>
        <button className="tab" role="tab" aria-selected={tab === 'cards'} onClick={() => setTab('cards')}>
          {(lowBalance || syncing) && <span className="dot" style={syncing && !lowBalance ? { background: 'var(--accent)' } : undefined} />}
          <Icon name="card" size={22} />
          Cards
        </button>
      </nav>

      {open && (
        <SubscriptionSheet
          key={open.key}
          s={open}
          catalog={catalog}
          onClose={() => setOpenKey(null)}
          onSaved={() => (setOpenKey(null), void load())}
        />
      )}
    </div>
  );
};

type SubsProps = {
  data: SubscriptionsResponse | null;
  sources: Source[];
  syncing: boolean;
  onOpen: (key: string) => void;
  onOpenCards: () => void;
};

const SubscriptionsTab = ({ data, sources, syncing, onOpen, onOpenCards }: SubsProps) => {
  const [showIgnored, setShowIgnored] = useState(false);
  if (!data) return <Skeleton />;

  const ignoredCount = data.items.filter(i => i.userStatus === 'ignored').length;
  const items = data.items.filter(i => showIgnored || i.userStatus !== 'ignored');
  const live = items.filter(i => i.status !== 'possibly_cancelled').sort((a, b) => a.nextChargeAt - b.nextChargeAt);
  const groups: [string, SubscriptionItem[]][] = [
    ['Next 7 days', live.filter(i => daysUntil(i.nextChargeAt) <= 7)],
    ['This month', live.filter(i => daysUntil(i.nextChargeAt) > 7 && daysUntil(i.nextChargeAt) <= 31)],
    ['Later', live.filter(i => daysUntil(i.nextChargeAt) > 31)],
    ['Possibly cancelled', items.filter(i => i.status === 'possibly_cancelled')],
  ];
  const lowKeys = new Set(data.alerts.flatMap(a => (a.type === 'low_balance' ? [a.key] : [])));
  const running = sources.find(s => s.sync.running);

  return (
    <>
      <AlertBanner alerts={data.alerts} onOpenCards={onOpenCards} />
      {running && (
        <section className="card pad" style={{ marginBottom: 14 }}>
          <SyncProgress src={running} compact />
        </section>
      )}
      <Summary totals={data.totals} items={live.filter(i => i.userStatus !== 'ignored')} />

      {!live.length && (
        <div className="card empty section">
          <span className="svc"><Icon name={syncing ? 'clock' : 'sparkle'} /></span>
          <strong style={{ color: 'var(--text)' }}>{syncing ? 'Looking through your history…' : sources.length ? 'No subscriptions found yet' : 'Connect monobank to start'}</strong>
          <span className="small">{syncing ? 'Subscriptions show up here as statements load.' : sources.length ? 'They appear after two charges from the same merchant.' : 'UnReSub reads your statements and finds recurring payments.'}</span>
          {!sources.length && <button className="btn sm" onClick={onOpenCards}>Connect</button>}
        </div>
      )}

      {groups.filter(([, list]) => list.length).map(([title, list]) => {
        const total = list.reduce((s, i) => s + i.localPrice, 0);
        const stale = title === 'Possibly cancelled';
        return (
          <section key={title} className="section">
            <div className="section-head">
              <h2>{title}</h2>
              {!stale && <span className="sum num">{formatMoney(total, LOCAL_CURRENCY)}</span>}
            </div>
            <ul className={`list card ${stale ? 'dim' : ''}`}>
              {list.map(s => <SubscriptionRow key={s.key} s={s} lowBalance={lowKeys.has(s.key)} onOpen={() => onOpen(s.key)} />)}
            </ul>
          </section>
        );
      })}

      {!!ignoredCount && (
        <div style={{ textAlign: 'center', marginTop: 18 }}>
          <button className="btn ghost sm" onClick={() => setShowIgnored(v => !v)}>
            {showIgnored ? 'Hide ignored' : `Show ignored (${ignoredCount})`}
          </button>
        </div>
      )}
    </>
  );
};

const Skeleton = () => (
  <div className="stack" aria-busy>
    <div className="skeleton" style={{ height: 168, borderRadius: 24 }} />
    {[0, 1, 2, 3].map(i => <div key={i} className="skeleton" style={{ height: 64 }} />)}
  </div>
);
