import { useRef, useState, type PointerEvent } from 'react';
import { formatMoney, LOCAL_CURRENCY } from '@unresub/core';
import type { SubscriptionItem } from '../api.ts';
import { daysUntil, fmtDate, PERIOD_SHORT, relative } from '../format.ts';
import { Icon } from './Icon.tsx';
import { ServiceIcon } from './ServiceIcon.tsx';

type Props = {
  s: SubscriptionItem;
  lowBalance: boolean;
  onOpen: () => void;
  /** "Not a subscription": swipe left on touch, or the eye button on hover. */
  onHide?: () => void;
  /** In the Hidden list: show a Restore button instead. */
  onRestore?: () => void;
  /** Inactive list: swipe or the hover button archives instead of hiding. */
  onArchive?: () => void;
};

const REVEAL = 132;

export const SubscriptionRow = ({ s, lowBalance, onOpen, onHide, onRestore, onArchive }: Props) => {
  const action = onArchive
    ? { run: onArchive, icon: 'archive' as const, label: 'Archive', title: `Archive ${s.name}` }
    : onHide
      ? { run: onHide, icon: 'eyeOff' as const, label: 'Not a sub', title: `${s.name} is not a subscription` }
      : null;
  const foreign = s.currency !== LOCAL_CURRENCY && s.localPrice > 0;
  const days = daysUntil(s.nextChargeAt);
  const live = s.status !== 'possibly_cancelled';
  const when = s.status === 'overdue' ? 'late' : live && days <= 3 ? 'soon' : '';

  // Swipe-to-reveal. Only horizontal drags count, so vertical scrolling stays smooth.
  const [dx, setDx] = useState(0);
  const drag = useRef<{ x: number; y: number; base: number; horizontal: boolean | null } | null>(null);
  const moved = useRef(false);
  const onDown = (e: PointerEvent) => {
    if (!action || e.pointerType === 'mouse') return;
    drag.current = { x: e.clientX, y: e.clientY, base: dx, horizontal: null };
    moved.current = false;
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const mx = e.clientX - d.x;
    const my = e.clientY - d.y;
    if (d.horizontal === null && Math.hypot(mx, my) > 8) d.horizontal = Math.abs(mx) > Math.abs(my);
    if (!d.horizontal) return;
    moved.current = true;
    setDx(Math.max(-REVEAL - 24, Math.min(0, d.base + mx)));
  };
  const onUp = () => {
    if (!drag.current) return;
    drag.current = null;
    setDx(v => (v < -REVEAL / 2 ? -REVEAL : 0));
  };

  return (
    <li className={`swipe ${dx ? 'swiping' : ''}`}>
      {action && (
        <button className={`swipe-action ${onArchive ? 'neutral' : ''}`} onClick={action.run} tabIndex={dx ? 0 : -1} aria-hidden={!dx}>
          <Icon name={action.icon} size={18} /> {action.label}
        </button>
      )}
      <div
        className="swipe-body"
        style={{ transform: dx ? `translateX(${dx}px)` : undefined, transition: drag.current ? 'none' : undefined }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <button
          className="row-btn"
          onClick={() => (moved.current ? (moved.current = false) : dx ? setDx(0) : onOpen())}
        >
          <ServiceIcon serviceId={s.serviceId} name={s.needsDetails ? s.detectedName : s.name} dot={lowBalance ? 'var(--danger)' : undefined} />
          <div className="row-main">
            <span className="row-title">{s.name}</span>
            <span className="row-meta">
              <span className={when}>{live ? (days <= 60 ? `${fmtDate(s.nextChargeAt)} · ${relative(s.nextChargeAt)}` : fmtDate(s.nextChargeAt)) : `last ${fmtDate(s.lastChargeAt)}`}</span>
            </span>
            {!onRestore && (s.needsDetails || s.onMainCard || lowBalance || s.status === 'overdue' || (s.confidence < 0.6 && !s.userStatus)) && (
              <span className="chips">
                {s.needsDetails && <span className="chip accent">Fill in details</span>}
                {s.status === 'overdue' && <span className="chip danger">Charge late</span>}
                {lowBalance && <span className="chip danger">Low balance</span>}
                {s.onMainCard && <span className="chip warn">Main card{s.account?.maskedPan && ` ··${s.account.maskedPan.slice(-4)}`}</span>}
                {s.confidence < 0.6 && !s.userStatus && <span className="chip">Unsure</span>}
              </span>
            )}
          </div>
          <div className="row-price num">
            <strong>{formatMoney(s.price, s.currency)}</strong>
            <span>{foreign && `${formatMoney(s.localPrice, LOCAL_CURRENCY)} · `}{PERIOD_SHORT[s.period]}</span>
          </div>
        </button>
        {action && (
          <button className="icon-btn row-hide" onClick={action.run} aria-label={action.title} title={action.title}>
            <Icon name={action.icon} size={18} />
          </button>
        )}
        {onRestore && (
          <button className="btn soft sm row-restore" onClick={onRestore}>Restore</button>
        )}
      </div>
    </li>
  );
};
