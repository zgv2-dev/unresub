import { describe, expect, it } from 'vitest';
import { detectSubscriptions } from './detect.ts';
import { demoTransactions, makeNoise, makeSeries } from './fixtures.ts';
import { addPeriod, annualEquivalent, monthlyEquivalent } from './money.ts';
import { matchService, merchantKey } from './catalog.ts';

const now = Date.UTC(2026, 10, 23) / 1000;
const day = 86_400;

describe('catalog', () => {
  it.each([
    ['APPLE.COM/BILL', 'apple'],
    ['GOOGLE *YouTubePremium', 'youtube'],
    ['GOOGLE *Duolingo', 'google-play'],
    ['ANTHROPIC, PBC', 'anthropic'],
    ['Telegram Premium', 'telegram'],
    ['DISCORD* NITRO', 'discord'],
  ])('%s → %s', (desc, id) => expect(matchService(desc)?.id).toBe(id));

  it('strips reference numbers from merchant keys', () => {
    expect(merchantKey('Hetzner Online 7781234')).toBe(merchantKey('Hetzner Online 7790001'));
  });
});

describe('money', () => {
  it('converts between monthly and annual', () => {
    expect(annualEquivalent(2_000, 'monthly')).toBe(24_000);
    expect(monthlyEquivalent(12_000, 'annual')).toBe(1_000);
  });

  it('adds calendar months and clamps to month end', () => {
    const jan31 = Date.UTC(2026, 0, 31) / 1000;
    expect(new Date(addPeriod(jan31, 'monthly') * 1000).toISOString().slice(0, 10)).toBe('2026-02-28');
  });
});

describe('detectSubscriptions', () => {
  it('finds the demo subscriptions and ignores grocery noise', () => {
    const subs = detectSubscriptions(demoTransactions(now), { now });
    const ids = subs.map(s => s.serviceId ?? s.name);
    expect(ids).toEqual(expect.arrayContaining(['anthropic', 'telegram', 'discord', 'youtube', 'megogo', 'kyivstar', 'Hetzner Online']));
    expect(subs.filter(s => s.serviceId === 'apple')).toHaveLength(2);
    expect(subs.some(s => /silpo|atb|uklon/i.test(s.name))).toBe(false);
  });

  it('computes price, local price at transaction rate and next date', () => {
    const last = now - 10 * day;
    const subs = detectSubscriptions(
      makeSeries({ description: 'ANTHROPIC', period: 'monthly', price: 2_000, currency: 840, rate: 41.5, count: 4, last }),
      { now },
    );
    expect(subs).toHaveLength(1);
    const [s] = subs;
    expect(s).toMatchObject({ serviceId: 'anthropic', period: 'monthly', price: 2_000, currency: 840, localPrice: 83_000, rate: 41.5, status: 'active' });
    expect(Math.abs(s!.nextChargeAt - addPeriod(last, 'monthly'))).toBeLessThan(2 * 3_600 + 1);
  });

  it('detects annual subscriptions from two charges', () => {
    const subs = detectSubscriptions(
      makeSeries({ description: 'Telegram Premium', period: 'annual', price: 3_599, currency: 840, rate: 41, count: 2, last: now - 30 * day }),
      { now },
    );
    expect(subs[0]?.period).toBe('annual');
  });

  it('marks a series as possibly cancelled after a missed cycle', () => {
    const subs = detectSubscriptions(
      makeSeries({ description: 'NETFLIX.COM', period: 'monthly', price: 999, currency: 840, rate: 41, count: 5, last: now - 75 * day }),
      { now },
    );
    expect(subs[0]?.status).toBe('possibly_cancelled');
  });

  it('does not flag irregular same-merchant spending', () => {
    expect(detectSubscriptions(makeNoise(now - 365 * day, now), { now })).toEqual([]);
  });
});
