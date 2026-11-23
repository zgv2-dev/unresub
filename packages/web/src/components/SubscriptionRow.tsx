import { formatMoney, LOCAL_CURRENCY } from '@unresub/core';
import type { SubscriptionItem } from '../api.ts';
import { daysUntil, fmtDate, PERIOD_SHORT, relative } from '../format.ts';
import { ServiceIcon } from './ServiceIcon.tsx';

export const SubscriptionRow = ({ s, lowBalance, onOpen }: { s: SubscriptionItem; lowBalance: boolean; onOpen: () => void }) => {
  const foreign = s.currency !== LOCAL_CURRENCY && s.localPrice > 0;
  const days = daysUntil(s.nextChargeAt);
  const live = s.status !== 'possibly_cancelled';
  const when = s.status === 'overdue' ? 'late' : live && days <= 3 ? 'soon' : '';
  return (
    <li>
      <button className="row-btn" onClick={onOpen}>
        <ServiceIcon serviceId={s.serviceId} name={s.needsDetails ? s.detectedName : s.name} dot={lowBalance ? 'var(--danger)' : undefined} />
        <div className="row-main">
          <span className="row-title">{s.name}</span>
          <span className="row-meta">
            <span className={when}>{live ? (days <= 60 ? `${fmtDate(s.nextChargeAt)} · ${relative(s.nextChargeAt)}` : fmtDate(s.nextChargeAt)) : `last charge ${fmtDate(s.lastChargeAt)}`}</span>
          </span>
          {(s.needsDetails || s.onMainCard || lowBalance || s.status === 'overdue' || s.userStatus === 'ignored' || (s.confidence < 0.6 && !s.userStatus)) && (
            <span className="chips">
              {s.needsDetails && <span className="chip accent">Fill in details</span>}
              {s.status === 'overdue' && <span className="chip danger">Charge late</span>}
              {lowBalance && <span className="chip danger">Low balance</span>}
              {s.onMainCard && <span className="chip warn">Main card{s.account?.maskedPan && ` ··${s.account.maskedPan.slice(-4)}`}</span>}
              {s.userStatus === 'ignored' && <span className="chip">Ignored</span>}
              {s.confidence < 0.6 && !s.userStatus && <span className="chip">Unsure</span>}
            </span>
          )}
        </div>
        <div className="row-price num">
          <strong>{formatMoney(s.price, s.currency)}</strong>
          <span>{foreign && `${formatMoney(s.localPrice, LOCAL_CURRENCY)} · `}{PERIOD_SHORT[s.period]}</span>
        </div>
      </button>
    </li>
  );
};
