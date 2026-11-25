import { useId, useState } from 'react';
import { formatMoney, LOCAL_CURRENCY, type Period } from '@unresub/core';
import { api, type CatalogEntry, type SubscriptionItem } from '../api.ts';
import { fmtDate, PERIOD_LABEL, PERIOD_OPTIONS, PERIOD_SHORT, relative } from '../format.ts';
import { Icon } from './Icon.tsx';
import { ServiceIcon } from './ServiceIcon.tsx';
import { Sheet } from './Sheet.tsx';
import { SubscriptionHistory } from './SubscriptionHistory.tsx';
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
  /** Jump to one of its charges in the Transactions tab. */
  onOpenTransaction?: (transactionId: string) => void;
  /** A charge was unlinked or relinked: refresh lists without closing the sheet. */
  onRefresh?: () => void;
  /** Archive (cancelled/ended) with an undo toast. */
  onArchive: () => void;
  /** Un-hide or un-archive. */
  onRestore: () => void;
};

export const SubscriptionSheet = ({ s, catalog, others, onClose, onSaved, onHide, onArchive, onRestore, onOpenTransaction, onRefresh }: Props) => {
  const formId = useId();
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
    <Sheet
      onClose={onClose}
      label={s.name}
      head={
        <>
          <ServiceIcon serviceId={serviceId || s.serviceId} name={name || s.name} size="lg" />
          <div>
            <h2>{name || s.name}</h2>
            <div className="muted num">
              {formatMoney(s.price, s.currency)} · {PERIOD_LABEL[s.period].toLowerCase()}
              {foreign && <span className="faint"> · {formatMoney(s.localPrice, LOCAL_CURRENCY)}</span>}
            </div>
          </div>
        </>
      }
      footer={
        <>
          {err && <p className="error small">{err}</p>}
          <button className="btn block" form={formId} disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
        </>
      }
    >
      {s.lifecycle !== 'active' && (
        <div className={`callout ${s.lifecycle === 'inactive' ? '' : 'neutral'}`}>
          {s.lifecycle === 'inactive' && <>The charge expected on {fmtDate(s.nextChargeAt)} never came. The last one was on {fmtDate(s.lastChargeAt)}. If you cancelled it, archive it.</>}
          {s.lifecycle === 'archived' && (
            <>
              {s.archivedBy === 'user' && s.archivedAt ? `You archived it on ${fmtDate(s.archivedAt)}. A new charge moves it back to Active.` : `No charge since ${fmtDate(s.lastChargeAt)}. A new charge moves it back to Active.`}
            </>
          )}
        </div>
      )}
      {s.needsDetails && (
        <div className="callout">
          UnReSub doesn't recognise this merchant. Pick the service or enter a name.
        </div>
      )}

      <div className="stat-grid num">
        <div>
          {s.lifecycle === 'active' ? (
            <>
              <span>Next charge</span>
              <strong>{fmtDate(s.nextChargeAt)}</strong>
              <em>{relative(s.nextChargeAt)}</em>
            </>
          ) : (
            <>
              <span>Last charge</span>
              <strong>{fmtDate(s.lastChargeAt)}</strong>
              <em>{relative(s.lastChargeAt)}</em>
            </>
          )}
        </div>
        <div>
          <span>Card</span>
          <strong>{s.account?.maskedPan ? `•••• ${s.account.maskedPan.slice(-4)}` : '—'}</strong>
          <em>{s.account?.isSubscriptionCard ? 'Subscriptions card' : s.onMainCard ? 'Main card. Move it to the subscriptions card.' : s.account?.type ?? ''}</em>
          {s.movedFrom && <em>Moved from ••{s.movedFrom.maskedPan?.slice(-4) ?? '?'}</em>}
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
          <button className="btn danger" disabled title="Add a cancel link below">
            <Icon name="external" size={18} /> Cancel
          </button>
        )}
        {s.lifecycle === 'archived' ? (
          <button className="btn soft" disabled={busy} onClick={onRestore}>
            <Icon name="refresh" size={18} /> Restore
          </button>
        ) : (
          <button className="btn soft" disabled={busy} onClick={onArchive}>
            <Icon name="archive" size={18} /> Archive
          </button>
        )}
      </div>

      <SubscriptionHistory subscriptionKey={s.key} onOpenTransaction={onOpenTransaction} onChanged={onRefresh} />

      <form id={formId} className="stack" onSubmit={e => (e.preventDefault(), void save())}>
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
          Bank description <code>{s.detectedName}</code> · {s.chargeCount} charges seen{foreign && ` · rate ${s.rate.toFixed(2)}`}
        </p>
      </form>

      <div className="stack fix">
        <div className="divider-title">Detected wrong?</div>
        <p className="xs faint">To fix the service or period, change it above and save.</p>

        <div className="fix-row">
          <span>
            <strong>Not a subscription</strong>
            <em>Its charges, including future ones, move back to Transactions.</em>
          </span>
          <button className="btn ghost sm" disabled={busy} onClick={onHide}>
            <Icon name="eyeOff" size={16} /> Not a subscription
          </button>
        </div>

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
              <em>This happens after a price change or a new bank description.</em>
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
            </span>
            <button className="btn ghost sm" disabled={busy} onClick={() => void act(() => api.setSplit(s.groupKey, false))}>Undo split</button>
          </div>
        )}
      </div>
    </Sheet>
  );
};
