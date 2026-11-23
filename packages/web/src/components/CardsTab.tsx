import { useState, type FormEvent } from 'react';
import { formatMoney } from '@unresub/core';
import { api, type Account, type Source } from '../api.ts';
import { fmtDate, last4 } from '../format.ts';
import { Icon } from './Icon.tsx';
import { SyncProgress } from './SyncProgress.tsx';

type Props = { sources: Source[]; accounts: Account[]; shortfall: Map<string, { amount: number; currency: number }>; onChange: () => void };

export const CardsTab = ({ sources, accounts, shortfall, onChange }: Props) => {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const hasSubsCard = accounts.some(a => a.isSubscriptionCard);

  const connect = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.connectMonobank(token.trim());
      setToken('');
      setMsg({ ok: true, text: `Connected ${r.name} with ${r.accounts} accounts. History is loading; monobank allows one request a minute, so a full year takes a while.` });
      onChange();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1 className="page-title">Cards</h1>
      {!!accounts.length && !hasSubsCard && (
        <div className="alert neutral" style={{ marginBottom: 14 }}>
          <span className="alert-icon"><Icon name="sparkle" /></span>
          <div className="alert-body">
            <strong>Pick your subscriptions card</strong>
            <span>We'll warn you when its balance won't cover the next charges.</span>
          </div>
        </div>
      )}

      {sources.map(src => (
        <section key={src.id} className="card pad stack" style={{ marginBottom: 14 }}>
          <div className="toggle-row">
            <div>
              <div style={{ fontWeight: 650 }}>{src.name}</div>
              <div className="xs muted">
                <span className={`status-dot ${src.webhookUrl ? 'on' : ''}`} />
                {src.webhookUrl ? 'Live updates on' : 'Live updates off, set PUBLIC_URL'}
                {src.sync.lastFinishedAt && !src.sync.running && <> · synced {fmtDate(src.sync.lastFinishedAt)}</>}
              </div>
            </div>
            <button className="btn soft sm" disabled={src.sync.running} onClick={() => void api.syncSource(src.id).then(onChange)}>
              <Icon name="refresh" size={16} /> {src.sync.running ? 'Syncing' : 'Sync'}
            </button>
          </div>
          {src.sync.lastError && <p className="small error">{src.sync.lastError}</p>}
          {src.sync.running && <SyncProgress src={src} />}

          {accounts.filter(a => a.sourceId === src.id).map(a => (
            <div key={a.id} className="account-row">
              <div className={`bank-card ${a.isSubscriptionCard ? 'subs' : ''}`}>
                <div className="top">
                  <span style={{ textTransform: 'capitalize' }}>{a.type ?? 'card'}</span>
                  {a.isSubscriptionCard && <span className="tag">Subscriptions</span>}
                </div>
                <div className="bottom">
                  <span className="bal num">{formatMoney(a.balance, a.currency)}</span>
                  <span className="pan num">{last4(a.maskedPan) ? `•••• ${last4(a.maskedPan)}` : ''}</span>
                </div>
                {shortfall.has(a.id) && (
                  <span className="tag danger">
                    Top up {formatMoney(shortfall.get(a.id)!.amount, shortfall.get(a.id)!.currency)} to cover upcoming charges
                  </span>
                )}
              </div>
              <label className="toggle-row small" style={{ padding: '0 4px' }}>
                <span>Use for subscriptions</span>
                <span className="switch">
                  <input type="checkbox" checked={a.isSubscriptionCard} onChange={e => void api.setSubscriptionCard(a.id, e.target.checked).then(onChange)} />
                  <i />
                </span>
              </label>
            </div>
          ))}
        </section>
      ))}

      <form onSubmit={connect} className="card pad stack">
        <div style={{ fontWeight: 650 }}>{sources.length ? 'Add another monobank account' : 'Connect monobank'}</div>
        <label className="field">
          <span>Personal token</span>
          <input className="input" type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="from api.monobank.ua" autoComplete="off" />
        </label>
        <p className="xs faint">
          <Icon name="lock" size={12} style={{ verticalAlign: '-1px' }} /> Read-only. Stored encrypted on your server and never sent back to this app.
        </p>
        <button className="btn block" disabled={busy || !token.trim()}>
          <Icon name="plus" size={18} /> {busy ? 'Connecting…' : 'Connect'}
        </button>
        {msg && <p className={`small ${msg.ok ? 'muted' : 'error'}`}>{msg.text}</p>}
      </form>
    </>
  );
};
