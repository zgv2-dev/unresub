import { formatMoney, type Alert } from '@unresub/core';
import { fmtDate, relative } from '../format.ts';
import { Icon } from './Icon.tsx';

/** Not dismissable on purpose: it goes away when the charge is detected or the balance is topped up. */
export const AlertBanner = ({ alerts, onOpenCards }: { alerts: Alert[]; onOpenCards: () => void }) => {
  if (!alerts.length) return null;
  const upcoming = alerts.filter(a => a.type === 'upcoming_charge');
  const onMain = alerts.filter(a => a.type === 'on_main_card');
  // Show only the last (largest) shortfall per card.
  const lowByCard = [...new Map(alerts.filter(a => a.type === 'low_balance').map(a => [a.accountId, a])).values()];
  return (
    <section className="alerts" role="status" aria-live="polite">
      {lowByCard.map(a => (
        <div key={a.accountId} className="alert hot">
          <div className="alert-body">
            <span>Top up the subscriptions card</span>
            <strong className="big num">{formatMoney(a.shortfall, a.currency)}</strong>
            <p>
              Charges until {fmtDate(a.chargeAt)} need {formatMoney(a.required, a.currency)}, and the card has {formatMoney(a.balance, a.currency)}.
            </p>
          </div>
          <button className="chip-btn" onClick={onOpenCards}>Cards</button>
        </div>
      ))}
      {upcoming.map(a => (
        <div key={a.key} className={`alert ${a.overdue ? 'danger' : ''}`}>
          <span className="alert-icon"><Icon name={a.overdue ? 'alert' : 'bell'} /></span>
          <div className="alert-body">
            <strong>{a.overdue ? `No charge from ${a.name} yet` : `${a.name} charges ${relative(a.chargeAt)}`}</strong>
            <span className="num">
              {formatMoney(a.price, a.currency)} · {a.overdue ? `was due ${fmtDate(a.chargeAt)}` : fmtDate(a.chargeAt)}
            </span>
          </div>
        </div>
      ))}
      {!!onMain.length && (
        <div className="alert neutral">
          <span className="alert-icon"><Icon name="card" /></span>
          <div className="alert-body">
            <strong>Move {onMain.length} {onMain.length === 1 ? 'subscription' : 'subscriptions'} to the subscriptions card</strong>
            <span className="clamp-1">{[...new Set(onMain.map(a => a.name))].join(', ')}</span>
          </div>
        </div>
      )}
    </section>
  );
};
