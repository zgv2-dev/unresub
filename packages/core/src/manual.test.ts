import { describe, expect, it } from 'vitest';
import { groupKeyOf } from './catalog.ts';
import { buildManualSubscriptions } from './manual.ts';
import { makeSeries } from './fixtures.ts';
import { addPeriod } from './money.ts';

const now = Date.UTC(2026, 10, 23) / 1000;
const day = 86_400;

describe('manual subscriptions', () => {
  const gym = makeSeries({ description: 'SPORTLIFE KYIV 0042', period: 'monthly', price: 90_000, currency: 980, count: 1, last: now - 40 * day }, 'acc');
  const coffee = makeSeries({ description: 'SPORTLIFE KYIV 0042', period: 'monthly', price: 6_500, currency: 980, count: 1, last: now - 20 * day }, 'acc');

  it('builds from one transaction and picks up later matching charges only', () => {
    const t = gym[0]!;
    const manual = { key: 'manual:1', groupKey: groupKeyOf(t), matchAmount: 90_000, period: 'monthly' as const, name: 'Gym', serviceId: null, transactionIds: [t.id] };
    let { subscriptions, claimed } = buildManualSubscriptions([manual], [...gym, ...coffee], { now });
    expect(subscriptions).toMatchObject([{ key: 'manual:1', chargeCount: 1, nextChargeAt: addPeriod(t.time, 'monthly'), status: 'overdue' }]);
    expect(claimed.has(coffee[0]!.id)).toBe(false);

    const next = makeSeries({ description: 'SPORTLIFE KYIV 0099', period: 'monthly', price: 91_000, currency: 980, count: 1, last: now - 5 * day }, 'acc');
    ({ subscriptions } = buildManualSubscriptions([manual], [...gym, ...coffee, ...next], { now }));
    expect(subscriptions[0]).toMatchObject({ chargeCount: 2, price: 91_000, status: 'active' });
  });

  it('matches any amount when asked', () => {
    const manual = { key: 'manual:2', groupKey: groupKeyOf(gym[0]!), matchAmount: null, period: 'monthly' as const, name: 'Gym', serviceId: null, transactionIds: [] };
    expect(buildManualSubscriptions([manual], [...gym, ...coffee], { now }).subscriptions[0]?.chargeCount).toBe(2);
  });

  it('follows the merchant to a card in another currency', () => {
    const t = gym[0]!;
    const manual = { key: 'manual:3', groupKey: groupKeyOf(t), matchAmount: 90_000, period: 'monthly' as const, name: 'Gym', serviceId: null, transactionIds: [t.id] };
    const usd = makeSeries({ description: 'SPORTLIFE KYIV 0042', period: 'monthly', price: 2_200, currency: 840, count: 1, last: now - 8 * day }, 'acc-usd')
      .map(x => ({ ...x, accountCurrency: 840, amount: x.operationAmount }));
    const toLocal = (minor: number, c: number) => (c === 840 ? Math.round(minor * 41.5) : null);
    const { subscriptions } = buildManualSubscriptions([manual], [...gym, ...coffee, ...usd], { now, toLocal });
    expect(subscriptions[0]).toMatchObject({ chargeCount: 2, currency: 840, accountId: 'acc-usd', status: 'active' });
  });
});
