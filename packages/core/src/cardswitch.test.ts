import { describe, expect, it } from 'vitest';
import { detectSubscriptions } from './detect.ts';
import { makeSeries } from './fixtures.ts';
import { addPeriod } from './money.ts';
import type { Transaction } from './types.ts';

const now = Date.UTC(2026, 10, 23) / 1000;
const day = 86_400;

/** Same charges, but billed to the USD card: account currency and amount become USD. */
const onUsdCard = (txns: Transaction[]) => txns.map(t => ({ ...t, accountId: 'acc-usd', accountCurrency: 840, amount: t.operationAmount }));

describe('card switch', () => {
  it('keeps one subscription when a USD service moves from the UAH card to the USD card', () => {
    const switchAt = now - 10 * day;
    const before = makeSeries({ description: 'ANTHROPIC', period: 'monthly', price: 2_000, currency: 840, rate: 41, count: 4, last: addPeriod(switchAt, 'monthly', -1) }, 'acc-main');
    const after = onUsdCard(makeSeries({ description: 'CLAUDE.AI SUBSCRIPTION', period: 'monthly', price: 2_000, currency: 840, count: 1, last: switchAt }));
    const subs = detectSubscriptions([...before, ...after], { now });
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ serviceId: 'anthropic', chargeCount: 5, accountId: 'acc-usd', status: 'active' });
  });
});

describe('card switch with a currency change', () => {
  // A merchant that bills in the card's currency: 830 UAH on the main card, then 20 USD on the USD card.
  const switchAt = now - 10 * day;
  const uah = makeSeries({ description: 'ACME CLOUD', period: 'monthly', price: 83_000, currency: 980, count: 4, last: addPeriod(switchAt, 'monthly', -1), mcc: 7372 }, 'acc-main');
  const usd = (count: number, last: number) =>
    onUsdCard(makeSeries({ description: 'ACME CLOUD', period: 'monthly', price: 2_000, currency: 840, count, last, mcc: 7372 }));
  const toLocal = (minor: number, currency: number) => (currency === 840 ? Math.round(minor * 41.5) : null);

  it('continues the old series with the first charge on the new card', async () => {
    const { extendWithSwitchedCharges } = await import('./cardswitch.ts');
    const txns = [...uah, ...usd(1, switchAt)];
    const detected = detectSubscriptions(txns, { now, toLocal });
    expect(detected).toHaveLength(1);
    const [s] = extendWithSwitchedCharges(detected, txns, { now, toLocal });
    expect(s).toMatchObject({ key: detected[0]!.key, chargeCount: 5, currency: 840, price: 2_000, accountId: 'acc-usd', status: 'active' });
  });

  it('links the old series into the new one once the new card has its own history', async () => {
    const { linkCardSwitches, applyCorrections } = await import('./corrections.ts');
    const txns = [...uah, ...usd(3, addPeriod(switchAt, 'monthly', 2))];
    const detected = detectSubscriptions(txns, { now: addPeriod(switchAt, 'monthly', 2) + day, toLocal });
    expect(detected).toHaveLength(2);
    const links = linkCardSwitches(detected);
    const oldKey = detected.find(d => d.currency === 980)!.key;
    const newKey = detected.find(d => d.currency === 840)!.key;
    expect([...links]).toEqual([[oldKey, newKey]]);
    const [merged] = applyCorrections(detected, new Map([...links].map(([k, v]) => [k, { mergedInto: v }])));
    expect(merged).toMatchObject({ key: newKey, chargeCount: 7, accountId: 'acc-usd', mergedKeys: [oldKey] });
  });

  it('does not link unrelated amounts or overlapping series', async () => {
    const { linkCardSwitches } = await import('./corrections.ts');
    const pricier = onUsdCard(makeSeries({ description: 'ACME CLOUD', period: 'monthly', price: 9_000, currency: 840, count: 3, last: addPeriod(switchAt, 'monthly', 2) }));
    expect(linkCardSwitches(detectSubscriptions([...uah, ...pricier], { now, toLocal })).size).toBe(0);
    const overlapping = onUsdCard(makeSeries({ description: 'ACME CLOUD', period: 'monthly', price: 2_000, currency: 840, count: 4, last: addPeriod(switchAt, 'monthly', -1) }));
    expect(linkCardSwitches(detectSubscriptions([...uah, ...overlapping], { now, toLocal })).size).toBe(0);
  });
});
