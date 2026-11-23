import { addPeriod, PERIOD_DAYS } from './money.ts';
import { statusFor } from './detect.ts';
import type { DetectedSubscription, Period } from './types.ts';

export interface Correction {
  /** Billing period the user says is right; next date and status are recomputed from it. */
  period?: Period | null;
  /** Fold this series into another one (same subscription seen under two keys, e.g. after a price change). */
  mergedInto?: string | null;
}

export type CorrectedSubscription = DetectedSubscription & {
  /** Keys folded into this one, for "unmerge". */
  mergedKeys: string[];
};

/**
 * Applies user fixes on top of a fresh detection run. Corrections are keyed by
 * detection key, which is stable for a merchant/amount pattern, so they keep
 * applying as new charges arrive.
 */
export const applyCorrections = (
  detected: DetectedSubscription[],
  corrections: ReadonlyMap<string, Correction>,
  now = Math.floor(Date.now() / 1000),
): CorrectedSubscription[] => {
  const byKey = new Map(detected.map(d => [d.key, { ...d, mergedKeys: [] as string[] }]));

  // Follow merge chains (a → b → c) to a target that still exists; ignore cycles.
  const resolve = (key: string) => {
    const seen = new Set([key]);
    let cur = key;
    for (let next = corrections.get(cur)?.mergedInto; next && !seen.has(next); next = corrections.get(cur)?.mergedInto) {
      seen.add(next);
      cur = next;
    }
    return cur !== key && byKey.has(cur) ? cur : null;
  };

  for (const d of detected) {
    const targetKey = resolve(d.key);
    if (!targetKey) continue;
    const src = byKey.get(d.key)!;
    const target = byKey.get(targetKey)!;
    const newer = src.lastChargeAt > target.lastChargeAt;
    Object.assign(target, {
      transactionIds: [...target.transactionIds, ...src.transactionIds],
      chargeCount: target.chargeCount + src.chargeCount,
      firstChargeAt: Math.min(target.firstChargeAt, src.firstChargeAt),
      confidence: Math.max(target.confidence, src.confidence),
      mergedKeys: [...target.mergedKeys, src.key, ...src.mergedKeys],
      ...(newer && {
        price: src.price, currency: src.currency, localPrice: src.localPrice, rate: src.rate,
        lastChargeAt: src.lastChargeAt, nextChargeAt: src.nextChargeAt, accountId: src.accountId, status: src.status,
      }),
    });
    byKey.delete(d.key);
  }

  for (const s of byKey.values()) {
    const period = corrections.get(s.key)?.period;
    if (period && period !== s.period) {
      s.period = period;
      s.nextChargeAt = addPeriod(s.lastChargeAt, period);
      s.status = statusFor(s.nextChargeAt, period, now);
    } else if (s.mergedKeys.length) {
      s.nextChargeAt = addPeriod(s.lastChargeAt, s.period);
      s.status = statusFor(s.nextChargeAt, s.period, now);
    }
  }

  return [...byKey.values()].toSorted((a, b) => a.nextChargeAt - b.nextChargeAt);
};

/** `svc:anthropic|840|2000` → `svc:anthropic` (service or merchant, without currency and amount). */
export const baseGroup = (groupKey: string) => groupKey.split('|')[0]!;

/**
 * Finds series that are one subscription moved to another card with a different
 * charge currency (e.g. billed in UAH to the main card, then in USD to the USD card).
 * Same-currency moves need nothing: detection already groups by merchant across cards.
 *
 * Links an older series into a newer one when they share the service/merchant and period,
 * the old one stopped before the new one started (within ~1.6 periods), and their UAH values
 * at the time of the charges are within 30%. Returns `oldKey → newKey`.
 */
export const linkCardSwitches = (subs: DetectedSubscription[], skip: ReadonlySet<string> = new Set()) => {
  const links = new Map<string, string>();
  const byBase = Map.groupBy(subs.filter(s => !skip.has(s.key)), s => baseGroup(s.groupKey));
  for (const list of byBase.values()) {
    if (list.length < 2) continue;
    const sorted = list.toSorted((a, b) => a.firstChargeAt - b.firstChargeAt);
    for (const older of sorted) {
      const newer = sorted.find(n =>
        n !== older &&
        !links.has(n.key) &&
        n.currency !== older.currency &&
        n.period === older.period &&
        n.firstChargeAt > older.lastChargeAt &&
        n.firstChargeAt - older.lastChargeAt <= PERIOD_DAYS[older.period] * 1.6 * 86_400 &&
        older.localPrice > 0 && n.localPrice > 0 &&
        Math.abs(n.localPrice - older.localPrice) <= Math.max(n.localPrice, older.localPrice) * 0.3,
      );
      if (newer) links.set(older.key, newer.key);
    }
  }
  return links;
};
