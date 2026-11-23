import { addPeriod } from './money.ts';
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
