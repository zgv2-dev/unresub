import { useEffect, useState, type FormEvent } from 'react';
import { formatMoney, type Period } from '@unresub/core';
import { api, type CatalogEntry, type SimilarResponse, type TransactionRow } from '../api.ts';
import { fmtDate, PERIOD_OPTIONS } from '../format.ts';
import { Icon } from './Icon.tsx';
import { ServiceIcon } from './ServiceIcon.tsx';
import { Sheet } from './Sheet.tsx';
import { Select } from './Select.tsx';

type Props = {
  t: TransactionRow;
  catalog: CatalogEntry[];
  onClose: () => void;
  onOpenSubscription: (key: string) => void;
  /** Called with the new subscription key. */
  onCreated: (key: string) => void;
};

export const TransactionSheet = ({ t, catalog, onClose, onOpenSubscription, onCreated }: Props) => {
  const [similar, setSimilar] = useState<SimilarResponse | null>(null);
  const [making, setMaking] = useState(false);
  const [name, setName] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [period, setPeriod] = useState<Period>('monthly');
  const [matchAmount, setMatchAmount] = useState(true);
  const [attach, setAttach] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const charge = t.operationAmount < 0;
  const owned = !!t.subscriptionKey;

  useEffect(() => {
    if (!charge) return;
    void api.similar(t.id).then(r => {
      setSimilar(r);
      setName(r.suggested.name);
      setServiceId(r.suggested.serviceId ?? '');
      // Pre-tick earlier charges with the same amount that aren't already someone else's.
      setAttach(new Set(r.items.filter(i => i.sameAmount && !i.subscriptionKey).map(i => i.id)));
    }, e => setErr((e as Error).message));
  }, [t.id, charge]);

  const toggle = (id: string) => setAttach(s => {
    const n = new Set(s);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { key } = await api.createManual({ transactionId: t.id, name: name.trim(), serviceId: serviceId || null, period, matchAmount, attachIds: [...attach] });
      onCreated(key);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  const amount = formatMoney(Math.abs(t.operationAmount), t.operationCurrency);

  return (
    <Sheet onClose={onClose} label={t.description}>
      <div className="sheet-head">
        <ServiceIcon serviceId={serviceId || null} name={t.counterName || t.description} size="lg" />
        <div>
          <h2>{t.description}</h2>
          <div className="muted num">
            {t.amount > 0 ? '+' : '−'}{formatMoney(Math.abs(t.amount), t.accountCurrency)}
            {t.operationCurrency !== t.accountCurrency && <span className="faint"> · {amount}</span>}
            <span className="faint"> · {fmtDate(t.time)}</span>
          </div>
        </div>
        <button className="icon-btn sheet-close" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
      </div>

      {owned && (
        <div className="fix-row" style={{ marginBottom: 16 }}>
          <span>
            <strong>{t.hidden ? 'Hidden subscription' : 'Part of a subscription'}</strong>
            <em>{t.subscriptionName}</em>
          </span>
          <button className="btn soft sm" onClick={() => onOpenSubscription(t.subscriptionKey!)}>Open</button>
        </div>
      )}

      {!charge && <p className="small muted">Incoming money can't be a subscription.</p>}

      {charge && !owned && !making && (
        <button className="btn block" onClick={() => setMaking(true)}>
          <Icon name="plus" size={18} /> Make it a subscription
        </button>
      )}

      {charge && !owned && making && (
        <form className="stack" onSubmit={e => void create(e)}>
          <div className="divider-title">New subscription</div>
          <div className="field">
            <span>Service</span>
            <Select label="Service" value={serviceId} onChange={setServiceId} options={[{ value: '', label: 'Not in the list' }, ...catalog.map(c => ({ value: c.id, label: c.name, icon: <ServiceIcon serviceId={c.id} name={c.name} /> }))]} />
          </div>
          <label className="field">
            <span>Name</span>
            <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder={t.description} required />
          </label>
          <div className="field">
            <span>Billing period</span>
            <Select label="Billing period" value={period} onChange={setPeriod} options={PERIOD_OPTIONS} />
          </div>
          <label className="check">
            <input type="checkbox" checked={matchAmount} onChange={e => setMatchAmount(e.target.checked)} />
            <span>
              Future charges from this merchant count only if they are about {amount}
              <em>Turn off if the price changes every time.</em>
            </span>
          </label>

          {!!similar?.items.length && (
            <>
              <div className="divider-title">Earlier charges from this merchant</div>
              <ul className="list card attach">
                {similar.items.map(i => (
                  <li key={i.id}>
                    <label className="row-btn">
                      <input type="checkbox" checked={attach.has(i.id)} onChange={() => toggle(i.id)} disabled={!!i.subscriptionKey && !attach.has(i.id)} />
                      <div className="row-main">
                        <span className="row-title">{fmtDate(i.time)}</span>
                        <span className="row-meta">{i.subscriptionName ? `in ${i.subscriptionName}` : i.description}</span>
                      </div>
                      <div className="row-price num"><strong>{formatMoney(Math.abs(i.operationAmount), i.operationCurrency)}</strong></div>
                    </label>
                  </li>
                ))}
              </ul>
              <p className="xs faint">Ticked charges are added now. New charges after today are picked up automatically.</p>
            </>
          )}

          {err && <p className="error small">{err}</p>}
          <button className="btn block" disabled={busy || !name.trim()}>{busy ? 'Saving…' : `Add subscription${attach.size ? ` with ${attach.size + 1} charges` : ''}`}</button>
        </form>
      )}

      <p className="xs faint" style={{ marginTop: 16 }}>
        Bank description <code>{t.description}</code>{t.mcc != null && <> · MCC {t.mcc}</>}
      </p>
    </Sheet>
  );
};
