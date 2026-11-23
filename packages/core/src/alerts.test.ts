import { describe, expect, it } from 'vitest';
import { computeAlerts, type AlertAccount, type AlertSubscription } from './alerts.ts';

const now = Date.UTC(2026, 10, 23, 12) / 1000;
const day = 86_400;

const sub = (o: Partial<AlertSubscription>): AlertSubscription => ({
  key: o.name ?? 'k', name: 'Sub', nextChargeAt: now + 10 * day, price: 1_000, currency: 840,
  accountId: 'usd', status: 'active', ignored: false, ...o,
});
const main: AlertAccount = { id: 'main', currency: 980, balance: 1_000_000, isSubscriptionCard: false };
const usd: AlertAccount = { id: 'usd', currency: 840, balance: 2_500, isSubscriptionCard: true };

describe('computeAlerts', () => {
  it('reminds from the day before until the charge is detected', () => {
    const alerts = computeAlerts([
      sub({ name: 'tomorrow', nextChargeAt: now + 20 * 3_600 }),
      sub({ name: 'late', nextChargeAt: now - 2 * day, status: 'overdue' }),
      sub({ name: 'later', nextChargeAt: now + 3 * day }),
      sub({ name: 'ignored', nextChargeAt: now + 3_600, ignored: true }),
      sub({ name: 'gone', nextChargeAt: now - 40 * day, status: 'possibly_cancelled' }),
      sub({ name: 'early', nextChargeAt: now + 3 * day, remindDays: 5 }),
    ], [], { now });
    expect(alerts.filter(a => a.type === 'upcoming_charge').map(a => [a.name, 'overdue' in a && a.overdue])).toEqual([
      ['late', true], ['tomorrow', false], ['early', false],
    ]);
  });

  it('warns when upcoming charges on the subs card exceed its balance', () => {
    const alerts = computeAlerts([
      sub({ name: 'a', price: 2_000, nextChargeAt: now + day }),
      sub({ name: 'b', price: 1_000, nextChargeAt: now + 2 * day }),
      sub({ name: 'outside window', price: 9_000, nextChargeAt: now + 10 * day }),
    ], [main, usd], { now });
    expect(alerts.filter(a => a.type === 'low_balance')).toEqual([
      expect.objectContaining({ name: 'b', required: 3_000, balance: 2_500, shortfall: 500, currency: 840 }),
    ]);
  });

  it('converts charges in another currency to the card currency', () => {
    const alerts = computeAlerts(
      [sub({ name: 'uah sub', price: 200_000, currency: 980, nextChargeAt: now + day })],
      [usd],
      { now, convert: (m, from, to) => (from === 980 && to === 840 ? Math.round(m / 40) : null) },
    );
    expect(alerts).toContainEqual(expect.objectContaining({ type: 'low_balance', required: 5_000 }));
  });

  it('flags subscriptions still on the main card only once a subs card exists', () => {
    const subs = [sub({ name: 'on main', accountId: 'main' }), sub({ name: 'on subs' })];
    expect(computeAlerts(subs, [main], { now }).some(a => a.type === 'on_main_card')).toBe(false);
    expect(computeAlerts(subs, [main, usd], { now }).filter(a => a.type === 'on_main_card').map(a => a.name)).toEqual(['on main']);
  });
});
