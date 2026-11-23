import { describe, expect, it } from 'vitest';
import { applyCorrections } from './corrections.ts';
import { detectSubscriptions } from './detect.ts';
import { makeSeries } from './fixtures.ts';
import { addPeriod } from './money.ts';

const now = Date.UTC(2026, 10, 23) / 1000;
const day = 86_400;

describe('corrections', () => {
  it('splits one merchant into separate subscriptions by price', () => {
    // Two similar plans billed the same day by one reseller look like a single monthly series.
    const txns = [
      ...makeSeries({ description: 'PADDLE.NET', period: 'monthly', price: 500, currency: 840, count: 4, last: now - 5 * day }),
      ...makeSeries({ description: 'PADDLE.NET', period: 'monthly', price: 550, currency: 840, count: 4, last: now - 5 * day }),
    ];
    const merged = detectSubscriptions(txns, { now });
    expect(merged).toHaveLength(1);
    const groupKey = 'm:paddle.net|840';
    const split = detectSubscriptions(txns, { now, splitGroups: new Set([groupKey]) });
    expect(split.map(s => s.price).sort((a, b) => a - b)).toEqual([500, 550]);
    expect(split.every(s => s.groupKey === groupKey && s.key !== groupKey)).toBe(true);
  });

  it('merges two series into one, keeping the newest price', () => {
    const old = makeSeries({ description: 'NETFLIX OLD', period: 'monthly', price: 899, currency: 840, count: 4, last: addPeriod(now - 10 * day, 'monthly', -4) });
    const cur = makeSeries({ description: 'NETFLIX NEW', period: 'monthly', price: 999, currency: 840, count: 4, last: now - 10 * day });
    const detected = detectSubscriptions([...old, ...cur], { now, catalog: [] });
    expect(detected).toHaveLength(2);
    const [a, b] = detected.toSorted((x, y) => x.lastChargeAt - y.lastChargeAt);
    const out = applyCorrections(detected, new Map([[a!.key, { mergedInto: b!.key }]]), now);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ key: b!.key, price: 999, chargeCount: 8, mergedKeys: [a!.key], status: 'active' });
  });

  it('merges into the newer series even when the older one is the target', () => {
    const old = makeSeries({ description: 'OLD NAME', period: 'monthly', price: 100, currency: 840, count: 3, last: now - 100 * day });
    const cur = makeSeries({ description: 'NEW NAME', period: 'monthly', price: 120, currency: 840, count: 3, last: now - 5 * day });
    const detected = detectSubscriptions([...old, ...cur], { now, catalog: [] });
    const [a, b] = detected.toSorted((x, y) => x.lastChargeAt - y.lastChargeAt);
    const [out] = applyCorrections(detected, new Map([[b!.key, { mergedInto: a!.key }]]), now);
    expect(out).toMatchObject({ key: a!.key, price: 120, lastChargeAt: b!.lastChargeAt, status: 'active' });
  });

  it('recomputes the next date when the period is corrected', () => {
    const detected = detectSubscriptions(
      makeSeries({ description: 'ANTHROPIC', period: 'monthly', price: 2_000, currency: 840, count: 3, last: now - 5 * day }),
      { now },
    );
    const [s] = applyCorrections(detected, new Map([[detected[0]!.key, { period: 'quarterly' }]]), now);
    expect(s).toMatchObject({ period: 'quarterly', nextChargeAt: addPeriod(detected[0]!.lastChargeAt, 'quarterly') });
  });

  it('ignores merge cycles and missing targets', () => {
    const detected = detectSubscriptions(
      makeSeries({ description: 'ANTHROPIC', period: 'monthly', price: 2_000, currency: 840, count: 3, last: now - 5 * day }),
      { now },
    );
    const k = detected[0]!.key;
    expect(applyCorrections(detected, new Map([[k, { mergedInto: 'gone' }]]), now)).toHaveLength(1);
    expect(applyCorrections(detected, new Map([[k, { mergedInto: k }]]), now)).toHaveLength(1);
  });
});
