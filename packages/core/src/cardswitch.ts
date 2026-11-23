import { baseGroup } from './corrections.ts';
import { groupKeyOf, SERVICE_CATALOG } from './catalog.ts';
import { localAmountOf, statusFor, type DetectOptions } from './detect.ts';
import { addPeriod, PERIOD_DAYS, toMajor } from './money.ts';
import { LOCAL_CURRENCY, type DetectedSubscription, type Transaction } from './types.ts';

const DAY = 86_400;

/**
 * A subscription that just moved to a card in another currency has only one charge there,
 * too few for detection. This continues the old series with such charges: same service or
 * merchant, different charge currency, the next charge after the old series' last one
 * (within ~1.6 periods), and a UAH value within 30%. Keys stay the same, so the subscription
 * keeps its corrections and stops looking cancelled. Once the new card has enough charges to
 * be detected on its own, `linkCardSwitches` folds the old series into it.
 */
export const extendWithSwitchedCharges = (
  subs: DetectedSubscription[],
  transactions: Transaction[],
  opts: Pick<DetectOptions, 'now' | 'toLocal' | 'catalog'> = {},
): DetectedSubscription[] => {
  const { now = Math.floor(Date.now() / 1000), toLocal, catalog = SERVICE_CATALOG } = opts;
  const used = new Set(subs.flatMap(s => s.transactionIds));
  const free = transactions.filter(t => t.operationAmount < 0 && !used.has(t.id)).toSorted((a, b) => a.time - b.time);

  return subs.map(s => {
    const base = baseGroup(s.groupKey);
    const ref = s.localPrice;
    if (!ref) return s;
    let cur = s;
    for (;;) {
      const maxGap = PERIOD_DAYS[cur.period] * 1.6 * DAY;
      const next = free.find(t => {
        if (used.has(t.id) || t.time <= cur.lastChargeAt || t.time - cur.lastChargeAt > maxGap) return false;
        if (t.operationCurrency === s.currency) return false; // same currency: detection already handles it
        if (baseGroup(groupKeyOf(t, catalog)) !== base) return false;
        const local = localAmountOf(t, toLocal);
        return local != null && Math.abs(local - ref) <= Math.max(local, ref) * 0.3;
      });
      if (!next) return cur;
      used.add(next.id);
      const price = Math.abs(next.operationAmount);
      const localPrice = localAmountOf(next, toLocal) ?? 0;
      const nextChargeAt = addPeriod(next.time, cur.period);
      cur = {
        ...cur,
        price,
        currency: next.operationCurrency,
        localPrice,
        rate: localPrice ? Math.round((toMajor(localPrice, LOCAL_CURRENCY) / toMajor(price, next.operationCurrency)) * 10_000) / 10_000 : 0,
        lastChargeAt: next.time,
        nextChargeAt,
        accountId: next.accountId,
        chargeCount: cur.chargeCount + 1,
        status: statusFor(nextChargeAt, cur.period, now),
        transactionIds: [...cur.transactionIds, next.id],
      };
    }
  });
};
