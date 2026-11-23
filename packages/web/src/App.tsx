import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { formatMoney, LOCAL_CURRENCY, type Alert, type Period } from '@unresub/core';
import {
  api,
  ApiError,
  getApiToken,
  setApiToken,
  type Account,
  type CatalogEntry,
  type Source,
  type SubscriptionItem,
  type SubscriptionsResponse,
} from './api.ts';

const PERIOD_LABEL: Record<Period, string> = {
  weekly: 'weekly',
  monthly: 'monthly',
  quarterly: 'quarterly',
  semiannual: 'every 6 months',
  annual: 'yearly',
};

const dateFmt = new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'short', year: 'numeric' });
const daysUntil = (unix: number) => Math.ceil((unix * 1000 - Date.now()) / 86_400_000);
const relative = (unix: number) => {
  const d = daysUntil(unix);
  return d === 0 ? 'today' : d === 1 ? 'tomorrow' : d > 0 ? `in ${d} days` : `${-d} days ago`;
};

export const App = () => {
  const [authed, setAuthed] = useState(!!getApiToken());
  return authed ? <Dashboard onLogout={() => (setApiToken(null), setAuthed(false))} /> : <Login onDone={() => setAuthed(true)} />;
};

const Login = ({ onDone }: { onDone: () => void }) => {
  const [token, setToken] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setApiToken(token.trim());
    onDone();
  };
  return (
    <main className="narrow">
      <h1>UnReSub</h1>
      <form onSubmit={submit} className="card stack">
        <label>
          API token
          <input type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="UNRESUB_API_TOKEN from your .env" autoFocus />
        </label>
        <button disabled={!token.trim()}>Open</button>
      </form>
    </main>
  );
};

const Dashboard = ({ onLogout }: { onLogout: () => void }) => {
  const [data, setData] = useState<SubscriptionsResponse | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [editing, setEditing] = useState<SubscriptionItem | null>(null);
  const [showIgnored, setShowIgnored] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  // Poll while a sync is running so new subscriptions appear during the backfill.
  const syncing = sources.some(s => s.sync.running);
  useEffect(() => {
    if (!syncing) return;
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [syncing, load]);

  const items = data?.items.filter(i => showIgnored || i.userStatus !== 'ignored') ?? [];
  const active = items.filter(i => i.status !== 'possibly_cancelled');
  const stale = items.filter(i => i.status === 'possibly_cancelled');

  return (
    <main>
      <header className="row between">
        <h1>UnReSub</h1>
        <button className="ghost" onClick={onLogout}>Log out</button>
      </header>

      {error && <p className="error">{error}</p>}

      {data && <AlertBanner alerts={data.alerts} />}

      {data && (
        <section className="totals card">
          <div>
            <span className="muted">Per month</span>
            <strong>{formatMoney(data.totals.monthlyLocal, LOCAL_CURRENCY)}</strong>
          </div>
          <div>
            <span className="muted">Per year</span>
            <strong>{formatMoney(data.totals.annualLocal, LOCAL_CURRENCY)}</strong>
          </div>
          <div>
            <span className="muted">Active</span>
            <strong>{data.totals.count}</strong>
          </div>
        </section>
      )}

      <section>
        <div className="row between">
          <h2>Upcoming payments</h2>
          <label className="row small">
            <input type="checkbox" checked={showIgnored} onChange={e => setShowIgnored(e.target.checked)} /> show ignored
          </label>
        </div>
        {data && !active.length && <p className="muted">No subscriptions detected yet{syncing ? ', still syncing…' : '.'}</p>}
        <ul className="list">
          {active.map(s => (
            <SubscriptionRow key={s.key} s={s} lowBalance={data?.alerts.some(a => a.type === 'low_balance' && a.key === s.key) ?? false} onEdit={() => setEditing(s)} />
          ))}
        </ul>
        {!!stale.length && (
          <>
            <h3 className="muted">Possibly cancelled</h3>
            <ul className="list dim">
              {stale.map(s => <SubscriptionRow key={s.key} s={s} lowBalance={false} onEdit={() => setEditing(s)} />)}
            </ul>
          </>
        )}
      </section>

      <Connections sources={sources} accounts={accounts} onChange={load} />

      {editing && (
        <EditDialog
          s={editing}
          catalog={catalog}
          onClose={() => setEditing(null)}
          onSaved={() => (setEditing(null), void load())}
        />
      )}
    </main>
  );
};

const SubscriptionRow = ({ s, lowBalance, onEdit }: { s: SubscriptionItem; lowBalance: boolean; onEdit: () => void }) => {
  const foreign = s.currency !== LOCAL_CURRENCY && s.localPrice > 0;
  const days = daysUntil(s.nextChargeAt);
  return (
    <li className={`card sub ${days <= 1 && s.status === 'active' ? 'soon' : ''} ${s.onMainCard ? 'main-card' : ''}`}>
      <div className="grow">
        <div className="row gap">
          <strong>{s.name}</strong>
          {s.needsDetails && <span className="badge warn">fill in details</span>}
          {s.status === 'overdue' && <span className="badge warn">charge late</span>}
          {s.userStatus === 'ignored' && <span className="badge">ignored</span>}
          {s.onMainCard && <span className="badge warn">on main card</span>}
          {lowBalance && <span className="badge danger">not enough on subs card</span>}
          {s.confidence < 0.6 && !s.userStatus && <span className="badge">maybe</span>}
        </div>
        <div className="muted small">
          {PERIOD_LABEL[s.period]} · next {dateFmt.format(s.nextChargeAt * 1000)} ({relative(s.nextChargeAt)})
          {s.account?.maskedPan && <> · card {s.account.maskedPan.slice(-4)}</>}
        </div>
        <div className="muted small">
          {s.period === 'monthly' || s.period === 'weekly'
            ? <>≈ {formatMoney(s.annual, s.currency)} / year{foreign && <> ({formatMoney(s.annualLocal, LOCAL_CURRENCY)})</>}</>
            : <>≈ {formatMoney(s.monthly, s.currency)} / month{foreign && <> ({formatMoney(s.monthlyLocal, LOCAL_CURRENCY)})</>}</>}
        </div>
      </div>
      <div className="price">
        <strong>{formatMoney(s.price, s.currency)}</strong>
        {foreign && (
          <span className="muted small" title={`Rate at last charge: ${s.rate}`}>
            {formatMoney(s.localPrice, LOCAL_CURRENCY)}
          </span>
        )}
        <div className="row gap">
          {s.cancelUrl && <a className="button ghost small" href={s.cancelUrl} target="_blank" rel="noreferrer">Cancel</a>}
          <button className="ghost small" onClick={onEdit}>Edit</button>
        </div>
      </div>
    </li>
  );
};

const EditDialog = ({ s, catalog, onClose, onSaved }: { s: SubscriptionItem; catalog: CatalogEntry[]; onClose: () => void; onSaved: () => void }) => {
  const [name, setName] = useState(s.needsDetails ? '' : s.name);
  const [serviceId, setServiceId] = useState(s.serviceId ?? '');
  const [period, setPeriod] = useState<Period>(s.period);
  const [cancelUrl, setCancelUrl] = useState(s.cancelUrl ?? '');
  const [notes, setNotes] = useState(s.notes ?? '');
  const [remindDays, setRemindDays] = useState(s.remindDays ?? 1);
  const [err, setErr] = useState<string | null>(null);

  const save = async (status: SubscriptionItem['userStatus'] = s.userStatus ?? 'confirmed') => {
    try {
      await api.updateSubscription(s.key, {
        name: name.trim() || null,
        serviceId: serviceId || null,
        period,
        cancelUrl: cancelUrl.trim() || null,
        notes: notes.trim() || null,
        remindDays,
        status,
      });
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="backdrop" onClick={onClose}>
      <form className="card dialog stack" onClick={e => e.stopPropagation()} onSubmit={e => (e.preventDefault(), void save())}>
        <h2>{s.name}</h2>
        <p className="muted small">
          Bank description: <code>{s.detectedName}</code> · {s.chargeCount} charges
        </p>
        <label>
          Service
          <select value={serviceId} onChange={e => setServiceId(e.target.value)}>
            <option value="">— not in the list —</option>
            {catalog.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label>
          Name
          <input value={name} onChange={e => setName(e.target.value)} placeholder={s.name} />
        </label>
        <label>
          Billing period
          <select value={period} onChange={e => setPeriod(e.target.value as Period)}>
            {Object.entries(PERIOD_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label>
          Cancel / manage URL
          <input value={cancelUrl} onChange={e => setCancelUrl(e.target.value)} placeholder="https://…" />
        </label>
        <label>
          Remind me (days before)
          <input type="number" min={0} max={30} value={remindDays} onChange={e => setRemindDays(Math.max(0, Math.min(30, Number(e.target.value) || 0)))} />
        </label>
        <label>
          Notes
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} />
        </label>
        {err && <p className="error">{err}</p>}
        <div className="row between">
          <button type="button" className="ghost" onClick={() => void save(s.userStatus === 'ignored' ? null : 'ignored')}>
            {s.userStatus === 'ignored' ? 'Un-ignore' : 'Not a subscription'}
          </button>
          <div className="row gap">
            <button type="button" className="ghost" onClick={onClose}>Close</button>
            <button>Save</button>
          </div>
        </div>
      </form>
    </div>
  );
};

const Connections = ({ sources, accounts, onChange }: { sources: Source[]; accounts: Account[]; onChange: () => void }) => {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const connect = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.connectMonobank(token.trim());
      setToken('');
      setMsg(`Connected ${r.name}: ${r.accounts} accounts. History is loading (monobank allows one request a minute, so a year takes a while). Webhook: ${r.webhook}.`);
      onChange();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2>Banks and cards</h2>
      {sources.map(src => (
        <div key={src.id} className="card stack">
          <div className="row between">
            <strong>{src.name}</strong>
            <div className="row gap">
              <button className="ghost small" disabled={src.sync.running} onClick={() => void api.syncSource(src.id).then(onChange)}>
                {src.sync.running ? `Syncing ${src.sync.done}/${src.sync.total}` : 'Sync now'}
              </button>
            </div>
          </div>
          <div className="muted small">
            {src.webhookUrl ? 'Live updates on' : 'Live updates off (set PUBLIC_URL)'}
            {src.sync.lastFinishedAt && <> · last sync {dateFmt.format(src.sync.lastFinishedAt * 1000)}</>}
            {src.sync.lastError && <span className="error"> · {src.sync.lastError}</span>}
          </div>
          <ul className="accounts">
            {accounts.filter(a => a.sourceId === src.id).map(a => (
              <li key={a.id} className="row between">
                <span>
                  {a.maskedPan ? `•••• ${a.maskedPan.slice(-4)}` : a.type} <span className="muted small">{a.type}</span>
                </span>
                <span className="row gap">
                  <span>{formatMoney(a.balance, a.currency)}</span>
                  <label className="row small">
                    <input type="checkbox" checked={a.isSubscriptionCard} onChange={e => void api.setSubscriptionCard(a.id, e.target.checked).then(onChange)} />
                    subscriptions card
                  </label>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <form onSubmit={connect} className="card stack">
        <label>
          Connect monobank
          <input type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="Personal token from api.monobank.ua" autoComplete="off" />
        </label>
        <p className="muted small">The token is read-only and stored encrypted on your server. It never comes back to this page.</p>
        <button disabled={busy || !token.trim()}>{busy ? 'Connecting…' : 'Connect'}</button>
        {msg && <p className="small">{msg}</p>}
      </form>
    </section>
  );
};

/** Not dismissable on purpose: it goes away when the charge is detected or the balance is topped up. */
const AlertBanner = ({ alerts }: { alerts: Alert[] }) => {
  const upcoming = alerts.filter(a => a.type === 'upcoming_charge');
  const low = alerts.filter(a => a.type === 'low_balance');
  const onMain = alerts.filter(a => a.type === 'on_main_card');
  if (!alerts.length) return null;
  // Show only the last (largest) shortfall per card.
  const lowByCard = [...new Map(low.map(a => [a.accountId, a])).values()];
  return (
    <section className="stack alerts" role="status">
      {lowByCard.map(a => (
        <div key={a.accountId} className="alert danger">
          <strong>Top up the subscriptions card by {formatMoney(a.shortfall, a.currency)}</strong>
          <span className="small">
            Charges due by {dateFmt.format(a.chargeAt * 1000)} need {formatMoney(a.required, a.currency)}, the card has {formatMoney(a.balance, a.currency)}.
          </span>
        </div>
      ))}
      {upcoming.map(a => (
        <div key={a.key} className="alert">
          <strong>{a.overdue ? `${a.name}: charge expected` : `${a.name} charges ${relative(a.chargeAt)}`}</strong>
          <span className="small">
            {formatMoney(a.price, a.currency)} · {a.overdue ? `was due ${dateFmt.format(a.chargeAt * 1000)}, not seen yet` : dateFmt.format(a.chargeAt * 1000)}
          </span>
        </div>
      ))}
      {!!onMain.length && (
        <div className="alert subtle">
          <strong>{onMain.length} {onMain.length === 1 ? 'subscription is' : 'subscriptions are'} still on the main card</strong>
          <span className="small">{onMain.map(a => a.name).join(', ')}</span>
        </div>
      )}
    </section>
  );
};
