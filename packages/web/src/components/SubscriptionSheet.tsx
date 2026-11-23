import { useState } from 'react';
import { formatMoney, LOCAL_CURRENCY, type Period } from '@unresub/core';
import { api, type CatalogEntry, type SubscriptionItem } from '../api.ts';
import { fmtDate, PERIOD_LABEL, relative } from '../format.ts';
import { Icon } from './Icon.tsx';
import { ServiceIcon } from './ServiceIcon.tsx';
import { Sheet } from './Sheet.tsx';

type Props = { s: SubscriptionItem; catalog: CatalogEntry[]; onClose: () => void; onSaved: () => void };

export const SubscriptionSheet = ({ s, catalog, onClose, onSaved }: Props) => {
  const [name, setName] = useState(s.needsDetails ? '' : s.name);
  const [serviceId, setServiceId] = useState(s.serviceId ?? '');
  const [period, setPeriod] = useState<Period>(s.period);
  const [cancelUrl, setCancelUrl] = useState(s.cancelUrl ?? '');
  const [notes, setNotes] = useState(s.notes ?? '');
  const [remindDays, setRemindDays] = useState(s.remindDays ?? 1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const foreign = s.currency !== LOCAL_CURRENCY && s.localPrice > 0;
  const local = (v: number) => (foreign ? formatMoney(v, LOCAL_CURRENCY) : null);
  const pickService = (id: string) => {
    setServiceId(id);
    const c = catalog.find(x => x.id === id);
    if (c?.cancelUrl && !cancelUrl) setCancelUrl(c.cancelUrl);
  };

  const save = async (status: SubscriptionItem['userStatus'] = s.userStatus ?? 'confirmed') => {
    setBusy(true);
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
      setBusy(false);
    }
  };

  return (
    <Sheet onClose={onClose} label={s.name}>
      <div className="sheet-head">
        <ServiceIcon serviceId={serviceId || s.serviceId} name={name || s.name} size="lg" />
        <div>
          <h2>{name || s.name}</h2>
          <div className="muted num">
            {formatMoney(s.price, s.currency)} · {PERIOD_LABEL[s.period].toLowerCase()}
            {foreign && <span className="faint"> · {formatMoney(s.localPrice, LOCAL_CURRENCY)}</span>}
          </div>
        </div>
        <button className="icon-btn sheet-close" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
      </div>

      {s.needsDetails && (
        <div className="callout">
          We don't know this merchant yet. Pick the service or give it a name so it is easy to recognise.
        </div>
      )}

      <div className="stat-grid num">
        <div>
          <span>Next charge</span>
          <strong>{fmtDate(s.nextChargeAt)}</strong>
          <em>{relative(s.nextChargeAt)}</em>
        </div>
        <div>
          <span>Card</span>
          <strong>{s.account?.maskedPan ? `•••• ${s.account.maskedPan.slice(-4)}` : '—'}</strong>
          <em>{s.account?.isSubscriptionCard ? 'subscriptions card' : s.onMainCard ? 'main card, move it' : s.account?.type ?? ''}</em>
        </div>
        <div>
          <span>Per month</span>
          <strong>{formatMoney(s.monthly, s.currency)}</strong>
          {foreign && <em>{local(s.monthlyLocal)}</em>}
        </div>
        <div>
          <span>Per year</span>
          <strong>{formatMoney(s.annual, s.currency)}</strong>
          {foreign && <em>{local(s.annualLocal)}</em>}
        </div>
      </div>

      <div className="sheet-actions">
        {s.cancelUrl ? (
          <a className="btn danger" href={s.cancelUrl} target="_blank" rel="noreferrer">
            <Icon name="external" size={18} /> Cancel
          </a>
        ) : (
          <button className="btn danger" disabled title="Add a cancel URL below">
            <Icon name="external" size={18} /> Cancel
          </button>
        )}
        <button className="btn soft" disabled={busy} onClick={() => void save(s.userStatus === 'ignored' ? null : 'ignored')}>
          <Icon name="eyeOff" size={18} /> {s.userStatus === 'ignored' ? 'Un-ignore' : 'Ignore'}
        </button>
      </div>

      <form className="stack" onSubmit={e => (e.preventDefault(), void save())}>
        <div className="divider-title">Details</div>
        <label className="field">
          <span>Service</span>
          <select className="input" value={serviceId} onChange={e => pickService(e.target.value)}>
            <option value="">Not in the list</option>
            {catalog.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Name</span>
          <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder={s.name} />
        </label>
        <div className="grid-2">
          <label className="field">
            <span>Billing period</span>
            <select className="input" value={period} onChange={e => setPeriod(e.target.value as Period)}>
              {Object.entries(PERIOD_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Remind, days before</span>
            <input className="input num" type="number" inputMode="numeric" min={0} max={30} value={remindDays} onChange={e => setRemindDays(Math.max(0, Math.min(30, Number(e.target.value) || 0)))} />
          </label>
        </div>
        <label className="field">
          <span>Cancel or manage link</span>
          <input className="input" type="url" inputMode="url" value={cancelUrl} onChange={e => setCancelUrl(e.target.value)} placeholder="https://…" />
        </label>
        <label className="field">
          <span>Notes</span>
          <textarea className="input" value={notes} onChange={e => setNotes(e.target.value)} rows={2} />
        </label>
        <p className="xs faint">
          Bank description <code>{s.detectedName}</code> · {s.chargeCount} charges seen{foreign && ` · rate ${s.rate.toFixed(2)}`}
        </p>
        {err && <p className="error small">{err}</p>}
        <button className="btn block" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </form>
    </Sheet>
  );
};
