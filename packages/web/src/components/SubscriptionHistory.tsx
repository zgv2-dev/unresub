import { useCallback, useEffect, useState } from 'react';
import { formatMoney, LOCAL_CURRENCY } from '@unresub/core';
import { api, type HistoryResponse, type HistoryRow } from '../api.ts';
import { fmtDate, last4 } from '../format.ts';
import { Icon } from './Icon.tsx';

type Props = {
  subscriptionKey: string;
  /** Jump to the charge in the Transactions tab. */
  onOpenTransaction?: (transactionId: string) => void;
  /** Something changed (a charge unlinked or relinked): refresh the subscription list. */
  onChanged?: () => void;
};

const SHOW = 6;

/** Charge history for one subscription: newest first, UAH at each charge's rate, price changes and card moves. */
export const SubscriptionHistory = ({ subscriptionKey, onOpenTransaction, onChanged }: Props) => {
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [unlinked, setUnlinked] = useState<HistoryRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    () => api.history(subscriptionKey).then(setData, e => setErr((e as Error).message)),
    [subscriptionKey],
  );
  useEffect(() => void load(), [load]);

  const unlink = async (r: HistoryRow) => {
    setBusy(r.id);
    try {
      await api.unlink(subscriptionKey, r.id);
      setUnlinked(r);
      await load();
      onChanged?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const undo = async () => {
    if (!unlinked) return;
    await api.relink(unlinked.id).catch(e => setErr((e as Error).message));
    setUnlinked(null);
    await load();
    onChanged?.();
  };

  if (err) return <p className="error small">{err}</p>;
  if (!data) return <div className="skeleton" style={{ height: 120 }} />;

  const foreignTotals = Object.entries(data.totalByCurrency).filter(([c]) => Number(c) !== LOCAL_CURRENCY);
  const rows = all ? data.items : data.items.slice(0, SHOW);

  return (
    <section className="history">
      <div className="divider-title">Charges</div>
      <div className="history-total num">
        <div>
          <span>Spent so far</span>
          <strong>{formatMoney(data.totalLocal, LOCAL_CURRENCY)}</strong>
          {!!foreignTotals.length && <em>{foreignTotals.map(([c, v]) => formatMoney(v, Number(c))).join(' + ')}</em>}
        </div>
        <div>
          <span>{data.count} {data.count === 1 ? 'charge' : 'charges'}</span>
          <strong>{data.since ? `since ${fmtDate(data.since)}` : '—'}</strong>
        </div>
      </div>

      {unlinked && (
        <div className="history-undo small">
          <span>Charge from {fmtDate(unlinked.time)} moved back to Transactions.</span>
          <button className="btn ghost sm" onClick={() => void undo()}>Undo</button>
        </div>
      )}

      <ul className="list card history-list">
        {rows.map(r => (
          <li key={r.id}>
            <div className="history-row">
              <div className="row-main">
                <span className="row-title">
                  {fmtDate(r.time)}
                  {r.hold && <span className="chip">pending</span>}
                </span>
                <span className="row-meta">
                  {r.card?.maskedPan && <>••{last4(r.card.maskedPan)}</>}
                  {r.movedFrom && <span className="chip accent">moved from ••{last4(r.movedFrom.maskedPan) ?? '?'}</span>}
                  {r.priceChange && (
                    <span className={`chip ${r.priceChange.delta > 0 ? 'danger' : 'ok'}`}>
                      {r.priceChange.delta > 0 ? '+' : '−'}{formatMoney(Math.abs(r.priceChange.delta), r.currency)} ({r.priceChange.delta > 0 ? '+' : ''}{r.priceChange.pct}%)
                    </span>
                  )}
                  {r.currencyChanged && <span className="chip">new currency</span>}
                </span>
              </div>
              <div className="row-price num">
                <strong>{formatMoney(r.price, r.currency)}</strong>
                {r.currency !== LOCAL_CURRENCY && <span>{r.local != null ? `${formatMoney(r.local, LOCAL_CURRENCY)} · ${r.rate?.toFixed(2)}` : 'no rate'}</span>}
              </div>
              <div className="history-actions">
                {onOpenTransaction && (
                  <button className="icon-btn" onClick={() => onOpenTransaction(r.id)} aria-label={`Open the ${fmtDate(r.time)} charge in Transactions`} title="Open in Transactions">
                    <Icon name="receipt" size={16} />
                  </button>
                )}
                <button className="icon-btn" disabled={busy === r.id} onClick={() => void unlink(r)} aria-label={`Not part of this subscription: ${fmtDate(r.time)}`} title="Not part of this subscription">
                  <Icon name="x" size={16} />
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>

      {data.items.length > SHOW && (
        <button className="btn ghost sm" onClick={() => setAll(v => !v)}>
          {all ? 'Show fewer' : `Show all ${data.items.length}`}
        </button>
      )}
    </section>
  );
};
