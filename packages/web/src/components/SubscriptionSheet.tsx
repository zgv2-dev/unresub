import { useState } from 'react';
import { formatMoney, LOCAL_CURRENCY, type Period } from '@unresub/core';
import { api, type CatalogEntry, type SubscriptionItem } from '../api.ts';
import { fmtDate, PERIOD_LABEL, PERIOD_OPTIONS, PERIOD_SHORT, relative } from '../format.ts';
import { Icon } from './Icon.tsx';
import { ServiceIcon } from './ServiceIcon.tsx';
import { Sheet } from './Sheet.tsx';
import { Select } from './Select.tsx';
import { Stepper } from './Stepper.tsx';

type Props = {
  s: SubscriptionItem;
  catalog: CatalogEntry[];
  /** Other visible subscriptions, for "same as…" merging. */
  others: SubscriptionItem[];
  onClose: () => void;
  onSaved: () => void;
  /** Hides with an undo toast (handled by the parent). */
  onHide: () => void;
};

export const SubscriptionSheet = ({ s, catalog, others, onClose, onSaved, onHide }: Props) => {
  const [name, setName] = useState(s.needsDetails ? '' : s.name);
  const [serviceId, setServiceId] = useState(s.serviceId ?? '');
  const [period, setPeriod] = useState<Period>(s.period);
  const [cancelUrl, setCancelUrl] = useState(s.cancelUrl ?? '');
  const [notes, setNotes] = useState(s.notes ?? '');
  const [remindDays, setRemindDays] = useState(s.remindDays ?? 1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [mergeInto, setMergeInto] = useState('');

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

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
        {s.userStatus === 'ignored' ? (
          <button className="btn soft" disabled={busy} onClick={() => void act(() => api.hide(s.key, false))}>
            <Icon name="eyeOff" size={18} /> Restore
          </button>
        ) : (
          <button className="btn soft" disabled={busy} onClick={onHide}>
            <Icon name="eyeOff" size={18} /> Not a subscription
          </button>
        )}
      </div>

      <form className="stack" onSubmit={e => (e.preventDefault(), void save())}>
        <div className="divider-title">Details</div>
        <div className="field">
          <span>Service</span>
          <Select label="Service" value={serviceId} onChange={pickService} options={[{ value: '', label: 'Not in the list' }, ...catalog.map(c => ({ value: c.id, label: c.name, icon: <ServiceIcon serviceId={c.id} name={c.name} /> }))]} />
        </div>
        <label className="field">
          <span>Name</span>
          <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder={s.name} />
        </label>
        <div className="grid-2">
          <div className="field">
            <span>Billing period</span>
            <Select label="Billing period" value={period} onChange={setPeriod} options={PERIOD_OPTIONS} />
          </div>
          <div className="field">
            <span>Remind, days before</span>
            <Stepper label="Remind, days before" value={remindDays} onChange={setRemindDays} min={0} max={30} />
          </div>
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
          {s.periodCorrected ? 'Period set by you; the next date follows it. ' : ''}Bank description <code>{s.detectedName}</code> · {s.chargeCount} charges seen{foreign && ` · rate ${s.rate.toFixed(2)}`}
        </p>
        {err && <p className="error small">{err}</p>}
        <button className="btn block" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </form>

      <div className="stack fix">
        <div className="divider-title">Detected wrong?</div>
        <p className="xs faint">
          Wrong service or period: change it above and save. It sticks when new charges come in.
        </p>

        {!!s.merged.length && (
          <div className="fix-row">
            <span>
              <strong>Combined with</strong>
              <em>{s.merged.map(m => m.name).join(', ')}</em>
            </span>
            <div className="fix-btns">
              {s.merged.map(m => (
                <button key={m.key} className="btn ghost sm" disabled={busy} onClick={() => void act(() => api.merge(m.key, null))}>
                  Separate {s.merged.length > 1 ? m.name : ''}
                </button>
              ))}
            </div>
          </div>
        )}

        {!!others.length && (
          <div className="fix-row">
            <span>
              <strong>Same subscription as another row</strong>
              <em>For example after a price change or a new bank description.</em>
            </span>
            <div className="fix-btns">
              <Select
                label="Combine with"
                placeholder="Pick one…"
                value={mergeInto}
                onChange={setMergeInto}
                options={others.map(o => ({ value: o.key, label: o.name, hint: `${formatMoney(o.price, o.currency)} · ${PERIOD_SHORT[o.period]}`, icon: <ServiceIcon serviceId={o.serviceId} name={o.name} /> }))}
              />
              <button className="btn soft sm" disabled={busy || !mergeInto} onClick={() => void act(() => api.merge(s.key, mergeInto))}>
                Combine
              </button>
            </div>
          </div>
        )}

        {s.manual && (
          <div className="fix-row">
            <span>
              <strong>Added by you</strong>
              <em>Remove it to send its charges back to Transactions.</em>
            </span>
            <button className="btn ghost sm" disabled={busy} onClick={() => void act(() => api.deleteManual(s.key))}>Remove</button>
          </div>
        )}

        {s.canSplit && (
          <div className="fix-row">
            <span>
              <strong>Several subscriptions in one</strong>
              <em>Split charges from {s.detectedName} by price.</em>
            </span>
            <button className="btn soft sm" disabled={busy} onClick={() => void act(() => api.setSplit(s.groupKey, true))}>Split by price</button>
          </div>
        )}

        {s.isSplit && (
          <div className="fix-row">
            <span>
              <strong>Split by price</strong>
              <em>All charges from {s.detectedName} are separated by amount.</em>
            </span>
            <button className="btn ghost sm" disabled={busy} onClick={() => void act(() => api.setSplit(s.groupKey, false))}>Undo split</button>
          </div>
        )}
      </div>
    </Sheet>
  );
};
