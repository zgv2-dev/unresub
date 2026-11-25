import { useState } from 'react';
import { formatMoney, LOCAL_CURRENCY } from '@unresub/core';
import type { Source, SubscriptionItem, SubscriptionsResponse } from '../api.ts';
import { daysUntil, fmtDate, PERIOD_SHORT, relative } from '../format.ts';
import { AlertBanner } from './AlertBanner.tsx';
import { Icon } from './Icon.tsx';
import { ServiceIcon } from './ServiceIcon.tsx';
import { SummaryTiles, Timeline } from './Summary.tsx';
import { SyncProgress } from './SyncProgress.tsx';

type View = 'active' | 'inactive' | 'archived';

type Props = {
  data: SubscriptionsResponse;
  sources: Source[];
  onOpen: (key: string) => void;
  onOpenCards: () => void;
  onHide: (s: SubscriptionItem) => void;
  onArchive: (s: SubscriptionItem) => void;
  onRestore: (s: SubscriptionItem) => void;
};

const status = (s: SubscriptionItem, low: boolean): [string, string] =>
  s.lifecycle === 'archived' ? [s.archivedBy === 'user' ? 'Archived' : 'Stopped charging', 'off']
  : s.lifecycle === 'inactive' ? ['No recent charge', 'warn']
  : s.status === 'overdue' ? ['Charge late', 'danger']
  : low ? ['Low balance', 'danger']
  : s.needsDetails ? ['Fill in details', 'accent']
  : s.confidence < 0.6 && !s.userStatus ? ['Unsure', 'off']
  : ['Active', 'ok'];

const EMPTY: Record<View, string> = {
  active: 'No subscriptions yet.',
  inactive: 'Every subscription charged on time.',
  archived: 'No archived subscriptions. Archive a subscription after you cancel it.',
};

/** Desktop: cabinet-style table with tabs, like the monobank API cabinet. */
export const SubscriptionsTable = ({ data, sources, onOpen, onOpenCards, onHide, onArchive, onRestore }: Props) => {
  const [view, setView] = useState<View>('active');
  const by = (l: SubscriptionItem['lifecycle']) => data.items.filter(i => i.lifecycle === l);
  const live = by('active').sort((a, b) => a.nextChargeAt - b.nextChargeAt);
  const inactive = by('inactive').sort((a, b) => b.lastChargeAt - a.lastChargeAt);
  const archived = by('archived').sort((a, b) => b.lastChargeAt - a.lastChargeAt);
  const lowKeys = new Set(data.alerts.flatMap(a => (a.type === 'low_balance' ? [a.key] : [])));
  const running = sources.find(s => s.sync.running);
  const cards = new Set(live.map(i => i.account?.id).filter(Boolean)).size;

  const groups: [string, SubscriptionItem[]][] =
    view === 'active'
      ? [
          ['Next 7 days', live.filter(i => daysUntil(i.nextChargeAt) <= 7)],
          ['This month', live.filter(i => daysUntil(i.nextChargeAt) > 7 && daysUntil(i.nextChargeAt) <= 31)],
          ['Later', live.filter(i => daysUntil(i.nextChargeAt) > 31)],
        ]
      : [['', view === 'inactive' ? inactive : archived]];
  const empty = groups.every(([, l]) => !l.length);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Subscriptions</h1>
          <p className="muted">{live.length} active{cards ? ` · on ${cards} ${cards === 1 ? 'card' : 'cards'}` : ''} · prices in the original currency and UAH</p>
        </div>
      </div>

      <AlertBanner alerts={data.alerts} onOpenCards={onOpenCards} />
      {running && (
        <div className="card pad" style={{ marginBottom: 14 }}>
          <SyncProgress src={running} compact />
        </div>
      )}
      <SummaryTiles totals={data.totals} items={live} />
      <Timeline items={live} onOpen={onOpen} />

      <div className="tabs" role="tablist">
        {([['active', 'Active', live.length], ['inactive', 'Inactive', inactive.length], ['archived', 'Archived', archived.length]] as const).map(([v, label, n]) => (
          <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)}>
            {label} <span className="faint num">{n}</span>
          </button>
        ))}
      </div>
      <div className="tbl-wrap">
        {empty ? (
          <div className="empty small">{EMPTY[view]}</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Service</th>
                <th>{view === 'active' ? 'Next charge' : 'Last charge'}</th>
                <th className="r">Price</th>
                <th className="r col-year">Per year</th>
                <th>Card</th>
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            {groups.filter(([, l]) => l.length).map(([title, list]) => (
              <tbody key={title || view}>
                {title && (
                  <tr className="tbl-group">
                    <td colSpan={7}>
                      {title}
                      <span className="num">{formatMoney(list.reduce((s, i) => s + i.localPrice, 0), LOCAL_CURRENCY)}</span>
                    </td>
                  </tr>
                )}
                {list.map(s => {
                  const foreign = s.currency !== LOCAL_CURRENCY && s.localPrice > 0;
                  const low = lowKeys.has(s.key);
                  const [label, tone] = status(s, low);
                  const days = daysUntil(s.nextChargeAt);
                  return (
                    <tr key={s.key} onClick={() => onOpen(s.key)} className={view === 'archived' ? 'dim' : ''}>
                      <td>
                        <div className="tbl-svc">
                          <ServiceIcon serviceId={s.serviceId} name={s.needsDetails ? s.detectedName : s.name} />
                          <div>
                            <strong>{s.name}</strong>
                            <span className="xs faint">{s.needsDetails ? s.detectedName : PERIOD_SHORT[s.period]}</span>
                          </div>
                        </div>
                      </td>
                      <td className="num">
                        {view === 'active' ? (
                          <>
                            <div className={s.status === 'overdue' ? 'late' : days <= 3 ? 'soon' : ''}>{fmtDate(s.nextChargeAt)}</div>
                            <span className="xs faint">{relative(s.nextChargeAt)}</span>
                          </>
                        ) : (
                          fmtDate(s.lastChargeAt)
                        )}
                      </td>
                      <td className="r num">
                        <strong>{formatMoney(s.price, s.currency)}</strong>
                        {foreign && <div className="xs faint">{formatMoney(s.localPrice, LOCAL_CURRENCY)}</div>}
                      </td>
                      <td className="r num col-year">
                        {formatMoney(s.annual, s.currency)}
                        {foreign && <div className="xs faint">{formatMoney(s.annualLocal, LOCAL_CURRENCY)}</div>}
                      </td>
                      <td className="num">
                        {s.account?.maskedPan ? `•• ${s.account.maskedPan.slice(-4)}` : '—'}
                        <div className={`xs ${s.onMainCard ? 'warn-text' : 'faint'}`}>{s.account?.isSubscriptionCard ? 'subscriptions' : s.onMainCard ? 'main card' : s.account?.type ?? ''}</div>
                      </td>
                      <td>
                        <span className={`dot-status ${tone}`}>{label}</span>
                      </td>
                      <td className="tbl-actions" onClick={e => e.stopPropagation()}>
                        {s.cancelUrl && (
                          <a className="icon-btn sm danger" href={s.cancelUrl} target="_blank" rel="noreferrer" title="Cancel subscription" aria-label={`Cancel ${s.name}`}>
                            <Icon name="external" size={16} />
                          </a>
                        )}
                        {s.lifecycle === 'archived' ? (
                          <button className="btn soft sm" onClick={() => onRestore(s)}>Restore</button>
                        ) : s.lifecycle === 'inactive' ? (
                          <button className="icon-btn sm" onClick={() => onArchive(s)} title="Archive" aria-label={`Archive ${s.name}`}>
                            <Icon name="archive" size={16} />
                          </button>
                        ) : (
                          <button className="icon-btn sm" onClick={() => onHide(s)} title="Not a subscription" aria-label={`${s.name} is not a subscription`}>
                            <Icon name="eyeOff" size={16} />
                          </button>
                        )}
                        <button className="icon-btn sm" onClick={() => onOpen(s.key)} title="Details" aria-label={`${s.name} details`}>
                          <Icon name="pencil" size={15} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            ))}
          </table>
        )}
      </div>
    </>
  );
};
