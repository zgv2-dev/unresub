import { groupKeyOf, matchService, SERVICE_CATALOG } from './catalog.ts';
import { localAmountOf, statusFor, type DetectOptions } from './detect.ts';
import { addPeriod, toMajor } from './money.ts';
import { LOCAL_CURRENCY, type DetectedSubscription, type Period, type Transaction } from './types.ts';

/** A subscription the user created from a transaction detection missed. */
export interface ManualSubscription {
  key: string;
  /** Merchant group (see groupKeyOf); future debits in this group are picked up. */
  groupKey: string;
  /** Only charges within 3% of this amount (merchant currency, positive minor units) match; null = any amount. */
  matchAmount: number | null;
  period: Period;
  name: string;
  serviceId: string | null;
  /** Transactions the user attached by hand, matched or not. */
  transactionIds: string[];
}

export const matchesManual = (m: Pick<ManualSubscription, 'groupKey' | 'matchAmount'>, t: Transaction, catalog = SERVICE_CATALOG) =>
  t.operationAmount < 0 &&
  groupKeyOf(t, catalog) === m.groupKey &&
  (m.matchAmount == null || Math.abs(Math.abs(t.operationAmount) - m.matchAmount) <= m.matchAmount * 0.03);

/**
 * Builds manual subscriptions from their rules and returns the transactions they claim,
 * so detection can run on the rest without double counting.
 */
export const buildManualSubscriptions = (
  manuals: ManualSubscription[],
  transactions: Transaction[],
  opts: Pick<DetectOptions, 'now' | 'toLocal' | 'catalog'> = {},
) => {
  const { now = Math.floor(Date.now() / 1000), toLocal, catalog = SERVICE_CATALOG } = opts;
  const claimed = new Set<string>();
  const subscriptions: DetectedSubscription[] = [];

  for (const m of manuals) {
    const attached = new Set(m.transactionIds);
    const base = m.groupKey.split('|')[0];
    const same = transactions.filter(t => !claimed.has(t.id) && (attached.has(t.id) || matchesManual(m, t, catalog)));
    // Moved to a card in another currency: same merchant, other currency, similar UAH value.
    const refTxn = same.toSorted((a, b) => b.time - a.time)[0];
    const ref = refTxn ? localAmountOf(refTxn, toLocal) : null;
    const switched = transactions.filter(t => {
      if (claimed.has(t.id) || attached.has(t.id) || t.operationAmount >= 0) return false;
      const g = groupKeyOf(t, catalog);
      if (g === m.groupKey || g.split('|')[0] !== base) return false;
      if (m.matchAmount == null) return true;
      const local = localAmountOf(t, toLocal);
      return !!ref && local != null && Math.abs(local - ref) <= Math.max(local, ref) * 0.3;
    });
    const series = [...same, ...switched].toSorted((a, b) => a.time - b.time);
    for (const t of series) claimed.add(t.id);
    const last = series.at(-1);
    if (!last) continue;
    const price = Math.abs(last.operationAmount);
    const localPrice = localAmountOf(last, toLocal) ?? 0;
    const nextChargeAt = addPeriod(last.time, m.period);
    subscriptions.push({
      key: m.key,
      groupKey: m.groupKey,
      serviceId: m.serviceId ?? matchService(last.description, catalog)?.id ?? null,
      name: m.name,
      period: m.period,
      price,
      currency: last.operationCurrency,
      localPrice,
      rate: localPrice ? Math.round((toMajor(localPrice, LOCAL_CURRENCY) / toMajor(price, last.operationCurrency)) * 10_000) / 10_000 : 0,
      firstChargeAt: series[0]!.time,
      lastChargeAt: last.time,
      nextChargeAt,
      chargeCount: series.length,
      accountId: last.accountId,
      confidence: 1,
      status: statusFor(nextChargeAt, m.period, now),
      transactionIds: series.map(t => t.id),
    });
  }

  return { subscriptions, claimed };
};

