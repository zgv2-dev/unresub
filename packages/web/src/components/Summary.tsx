import { formatMoney, LOCAL_CURRENCY } from '@unresub/core';
import type { SubscriptionItem, SubscriptionsResponse } from '../api.ts';
import { splitMoney } from '../format.ts';

const CATEGORY: Record<string, { label: string; color: string }> = {
  ai: { label: 'AI', color: '#ffffff' },
  video: { label: 'Video', color: '#ffb3c7' },
  music: { label: 'Music', color: '#8ef0c6' },
  cloud: { label: 'Cloud', color: '#9fd4ff' },
  software: { label: 'Software', color: '#ffd98a' },
  social: { label: 'Social', color: '#c9b8ff' },
  telecom: { label: 'Mobile', color: '#7de3f0' },
  gaming: { label: 'Games', color: '#ffa98a' },
  store: { label: 'App stores', color: '#e3e3ff' },
  other: { label: 'Other', color: 'rgba(255,255,255,0.45)' },
};

const OTHER = { label: 'Other', color: 'rgba(255,255,255,0.45)' };
const cat = (c: string) => CATEGORY[c] ?? OTHER;

export const Summary = ({ totals, items }: { totals: SubscriptionsResponse['totals']; items: SubscriptionItem[] }) => {
  const { whole, cents } = splitMoney(totals.monthlyLocal, LOCAL_CURRENCY);
  const byCat = new Map<string, number>();
  for (const i of items) byCat.set(i.category ?? 'other', (byCat.get(i.category ?? 'other') ?? 0) + i.monthlyLocal);
  const parts = [...byCat].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const sum = parts.reduce((s, [, v]) => s + v, 0);
  return (
    <section className="hero">
      <div className="hero-label">Spending per month</div>
      <div className="hero-amount num">
        {whole}
        <span className="cents">{cents}</span>
      </div>
      <div className="hero-stats">
        <div>
          <span>Per year</span>
          <strong className="num">{formatMoney(totals.annualLocal, LOCAL_CURRENCY)}</strong>
        </div>
        <div>
          <span>Active</span>
          <strong className="num">{totals.count}</strong>
        </div>
      </div>
      {sum > 0 && (
        <>
          <div className="spend-bar" aria-hidden>
            {parts.map(([c, v]) => <i key={c} style={{ width: `${(v / sum) * 100}%`, background: cat(c).color }} />)}
          </div>
          <div className="legend">
            {parts.slice(0, 5).map(([c, v]) => (
              <span key={c}>
                <b style={{ background: cat(c).color }} />
                {cat(c).label} {Math.round((v / sum) * 100)}%
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  );
};
