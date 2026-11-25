import { formatMoney, LOCAL_CURRENCY } from '@unresub/core';
import type { SubscriptionItem, SubscriptionsResponse } from '../api.ts';
import { daysUntil, fmtDate, relative, splitMoney } from '../format.ts';
import { ServiceIcon } from './ServiceIcon.tsx';

const CATEGORY: Record<string, { label: string; color: string }> = {
  ai: { label: 'AI', color: 'var(--c-ai)' },
  video: { label: 'Video', color: 'var(--c-video)' },
  music: { label: 'Music', color: 'var(--c-music)' },
  cloud: { label: 'Cloud', color: 'var(--c-cloud)' },
  software: { label: 'Software', color: 'var(--c-software)' },
  social: { label: 'Social', color: 'var(--c-social)' },
  telecom: { label: 'Mobile', color: 'var(--c-mobile)' },
  gaming: { label: 'Games', color: 'var(--c-gaming)' },
  store: { label: 'App stores', color: 'var(--c-store)' },
  other: { label: 'Other', color: 'var(--c-other)' },
};
const cat = (c: string) => CATEGORY[c] ?? CATEGORY.other!;

type Totals = SubscriptionsResponse['totals'];

const byCategory = (items: SubscriptionItem[]) => {
  const m = new Map<string, number>();
  for (const i of items) m.set(i.category ?? 'other', (m.get(i.category ?? 'other') ?? 0) + i.monthlyLocal);
  const parts = [...m].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  return { parts, sum: parts.reduce((s, [, v]) => s + v, 0) };
};

const Amount = ({ minor, className = '' }: { minor: number; className?: string }) => {
  const { whole, cents } = splitMoney(minor, LOCAL_CURRENCY);
  return (
    <div className={`big num ${className}`}>
      {whole}
      <span className="cents">{cents}</span>
    </div>
  );
};

/** Category ring with the active count in the middle. */
const Ring = ({ items, count, size, stroke }: { items: SubscriptionItem[]; count: number; size: number; stroke: number }) => {
  const { parts, sum } = byCategory(items);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const gap = parts.length > 1 ? 4 : 0;
  let off = 0;
  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" strokeWidth={stroke} />
        {sum > 0 &&
          parts.map(([k, v]) => {
            const len = (c * v) / sum;
            const el = (
              <circle
                key={k}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={cat(k).color}
                strokeWidth={stroke}
                strokeLinecap="round"
                strokeDasharray={`${Math.max(len - gap, 0.5)} ${c}`}
                strokeDashoffset={-off}
              />
            );
            off += len;
            return el;
          })}
      </svg>
      <div className="ring-mid">
        <strong className="num">{count}</strong>
        <span>active</span>
      </div>
    </div>
  );
};

const Legend = ({ items, max }: { items: SubscriptionItem[]; max: number }) => {
  const { parts, sum } = byCategory(items);
  if (!sum) return null;
  return (
    <div className="legend">
      {parts.slice(0, max).map(([k, v]) => (
        <span key={k}>
          <b style={{ background: cat(k).color }} />
          {cat(k).label}
          <em className="num">{Math.round((v / sum) * 100)}%</em>
        </span>
      ))}
    </div>
  );
};

/** Mobile hero. */
export const Summary = ({ totals, items }: { totals: Totals; items: SubscriptionItem[] }) => (
  <>
    <section className="hero glass">
      <div className="hero-row">
        <div>
          <div className="hero-label">Spending per month</div>
          <Amount minor={totals.monthlyLocal} className="hero-amount" />
        </div>
        <Ring items={items} count={totals.count} size={104} stroke={9} />
      </div>
      <Legend items={items} max={4} />
    </section>
    <div className="hero-stats">
      <div className="tile">
        <span>Per year</span>
        <strong className="num">{formatMoney(totals.annualLocal, LOCAL_CURRENCY)}</strong>
      </div>
      <div className="tile">
        <span>Next 30 days</span>
        <strong className="num">{formatMoney(dueWithin(items, 30), LOCAL_CURRENCY)}</strong>
      </div>
    </div>
  </>
);

const dueWithin = (items: SubscriptionItem[], days: number) =>
  items.filter(i => daysUntil(i.nextChargeAt) <= days).reduce((s, i) => s + i.localPrice, 0);

/** Desktop: hero with the category ring, plus per-year and next-charge tiles. */
export const SummaryTiles = ({ totals, items }: { totals: Totals; items: SubscriptionItem[] }) => {
  const next = items.toSorted((a, b) => a.nextChargeAt - b.nextChargeAt)[0];
  return (
    <section className="tiles">
      <div className="tile hero">
        <div className="hero-text">
          <div className="hero-label">Spending per month</div>
          <Amount minor={totals.monthlyLocal} className="hero-amount" />
          <div className="hero-sub num">{formatMoney(totals.annualLocal, LOCAL_CURRENCY)} per year</div>
          <Legend items={items} max={6} />
        </div>
        <Ring items={items} count={totals.count} size={156} stroke={12} />
      </div>
      <div className="tile">
        <span>Next charge</span>
        {next ? (
          <>
            <div className="tile-svc">
              <ServiceIcon serviceId={next.serviceId} name={next.name} />
              <div>
                <strong>{next.name}</strong>
                <em className="num">{fmtDate(next.nextChargeAt)}, {relative(next.nextChargeAt)}</em>
              </div>
            </div>
            <div className="tile-foot">
              <span className="big num">{formatMoney(next.price, next.currency)}</span>
              {next.currency !== LOCAL_CURRENCY && next.localPrice > 0 && <em className="num">{formatMoney(next.localPrice, LOCAL_CURRENCY)}</em>}
            </div>
          </>
        ) : (
          <strong>—</strong>
        )}
      </div>
      <div className="tile">
        <span>Next 30 days</span>
        <Amount minor={dueWithin(items, 30)} />
        <em className="tile-foot">{items.filter(i => daysUntil(i.nextChargeAt) <= 30).length} charges</em>
      </div>
    </section>
  );
};

const DAY = 86_400;
const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime() / 1000;
};

/** Desktop: charges over the next 30 days on one axis. */
export const Timeline = ({ items, onOpen }: { items: SubscriptionItem[]; onOpen: (key: string) => void }) => {
  const days = 30;
  const t0 = startOfToday();
  const due = items.filter(i => i.nextChargeAt < t0 + (days + 1) * DAY).sort((a, b) => a.nextChargeAt - b.nextChargeAt);
  if (!due.length) return null;
  const x = (unix: number) => Math.min(Math.max((unix - t0) / (days * DAY), 0), 1) * 100;
  // Stack icons that would overlap into separate levels.
  const lastAt: number[] = [];
  const placed = due.map(s => {
    const pos = x(s.nextChargeAt);
    let level = lastAt.findIndex(p => pos - p > 5.5);
    if (level < 0) level = lastAt.length;
    lastAt[level] = pos;
    return { s, pos, level };
  });
  const ticks = Array.from({ length: 7 }, (_, i) => t0 + i * 5 * DAY);
  return (
    <section className="timeline glass">
      <div className="timeline-head">
        <h2>Next 30 days</h2>
        <span className="muted num">{formatMoney(due.reduce((s, i) => s + i.localPrice, 0), LOCAL_CURRENCY)}</span>
      </div>
      <div className="tl" style={{ height: 70 + Math.min(lastAt.length, 3) * 44 }}>
        <div className="tl-axis" />
        {ticks.map(t => (
          <span key={t} className="tl-tick num" style={{ left: `${x(t)}%` }}>{fmtDate(t)}</span>
        ))}
        <span className="tl-today" />
        {placed.map(({ s, pos, level }) => (
          <button
            key={s.key}
            className={`tl-ev ${daysUntil(s.nextChargeAt) <= 1 ? 'hot' : ''}`}
            style={{ left: `${pos}%`, bottom: 26 + 14 + (level % 3) * 44 }}
            onClick={() => onOpen(s.key)}
            title={`${s.name}, ${fmtDate(s.nextChargeAt)}`}
          >
            <span className="tl-amt num">{formatMoney(s.price, s.currency)}</span>
            <ServiceIcon serviceId={s.serviceId} name={s.name} />
            <span className="tl-stem" style={{ height: 14 + (level % 3) * 44 }} />
          </button>
        ))}
      </div>
    </section>
  );
};

const WEEKDAY = new Intl.DateTimeFormat('uk-UA', { weekday: 'short' });
const MONTH = new Intl.DateTimeFormat('uk-UA', { month: 'short' });

/** Mobile: the next two weeks, a dot for each charge. */
export const DayStrip = ({ items, onOpen }: { items: SubscriptionItem[]; onOpen: (key: string) => void }) => {
  const t0 = startOfToday();
  const list = Array.from({ length: 14 }, (_, i) => {
    const start = t0 + i * DAY;
    return { start, subs: items.filter(s => s.nextChargeAt >= start && s.nextChargeAt < start + DAY) };
  });
  const first = new Date(t0 * 1000);
  const last = new Date((t0 + 13 * DAY) * 1000);
  const range = first.getMonth() === last.getMonth() ? MONTH.format(first) : `${MONTH.format(first)} – ${MONTH.format(last)}`;
  return (
    <section className="strip glass">
      <div className="timeline-head">
        <h2>Upcoming</h2>
        <span className="muted small">{range}</span>
      </div>
      <div className="days">
        {list.map(({ start, subs }, i) => {
          const d = new Date(start * 1000);
          return (
            <button
              key={start}
              className={`day ${i === 0 ? 'today' : ''}`}
              disabled={!subs.length}
              onClick={() => subs[0] && onOpen(subs[0].key)}
              aria-label={subs.length ? `${subs.map(s => s.name).join(', ')}, ${fmtDate(start)}` : fmtDate(start)}
            >
              <span className="day-w">{WEEKDAY.format(d)}</span>
              <span className="day-d num">{d.getDate()}</span>
              <span className="day-mk">
                {subs.slice(0, 3).map(s => <i key={s.key}  />)}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
};
