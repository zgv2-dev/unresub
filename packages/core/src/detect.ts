import { matchService, merchantKey, SUBSCRIPTION_MCCS, SERVICE_CATALOG } from './catalog.ts';
import { addPeriod, PERIOD_DAYS, toMajor } from './money.ts';
import {
  LOCAL_CURRENCY,
  type CurrencyCode,
  type DetectedSubscription,
  type DetectionStatus,
  type Period,
  type ServiceDefinition,
  type Transaction,
} from './types.ts';

export interface DetectOptions {
  now?: number;
  catalog?: ServiceDefinition[];
  /** Drop series under this confidence. */
  minConfidence?: number;
  /** Converts a foreign-currency amount to local minor units at (or near) `time`, for accounts not in UAH. */
  toLocal?: (minor: number, currency: CurrencyCode, time: number) => number | null;
}

const DAY = 86_400;

/** [period, minDays, maxDays] for the median interval. */
const PERIOD_RANGES: [Period, number, number][] = [
  ['weekly', 6, 8],
  ['monthly', 26, 35],
  ['quarterly', 84, 98],
  ['semiannual', 172, 192],
  ['annual', 350, 380],
];

const GRACE_DAYS: Record<Period, number> = { weekly: 2, monthly: 4, quarterly: 7, semiannual: 10, annual: 14 };

const median = (xs: number[]) => {
  const s = xs.toSorted((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

const classifyPeriod = (days: number): Period | null =>
  PERIOD_RANGES.find(([, min, max]) => days >= min && days <= max)?.[0] ?? null;

/** Share of intervals that fit the period (or a skipped cycle, 2x period). */
const regularity = (intervals: number[], period: Period) => {
  const p = PERIOD_DAYS[period];
  const tol = Math.max(3, p * 0.12);
  const fits = intervals.filter(d => Math.abs(d - p) <= tol || Math.abs(d - 2 * p) <= tol * 1.5);
  return fits.length / intervals.length;
};

const amountStability = (amounts: number[]) => {
  const m = median(amounts);
  return amounts.filter(a => Math.abs(a - m) <= m * 0.25).length / amounts.length;
};

/** Groups amounts within `tolerance` of each other. Input must be sorted by time. */
const clusterByAmount = (txns: Transaction[], tolerance: number) => {
  const clusters: Transaction[][] = [];
  for (const t of txns) {
    const a = Math.abs(t.operationAmount);
    const hit = clusters.find(c => Math.abs(Math.abs(c[0]!.operationAmount) - a) <= a * tolerance);
    hit ? hit.push(t) : clusters.push([t]);
  }
  return clusters;
};

const localAmountOf = (t: Transaction, toLocal: DetectOptions['toLocal']) =>
  t.accountCurrency === LOCAL_CURRENCY
    ? Math.abs(t.amount)
    : t.operationCurrency === LOCAL_CURRENCY
      ? Math.abs(t.operationAmount)
      : toLocal?.(Math.abs(t.operationAmount), t.operationCurrency, t.time) ?? null;

interface SeriesEval {
  period: Period;
  regularity: number;
  stability: number;
}

const evaluate = (series: Transaction[], requireMinWeekly: boolean): SeriesEval | null => {
  if (series.length < 2) return null;
  const intervals = series.slice(1).map((t, i) => (t.time - series[i]!.time) / DAY);
  // Two charges on the same day are noise (retries, split payments); ignore those gaps.
  const real = intervals.filter(d => d >= 1);
  if (!real.length) return null;
  const period = classifyPeriod(median(real));
  if (!period) return null;
  if (period === 'weekly' && requireMinWeekly && series.length < 4) return null;
  const reg = regularity(real, period);
  const stability = amountStability(series.map(t => Math.abs(t.operationAmount)));
  if (reg < 0.6 || stability < 0.7) return null;
  return { period, regularity: reg, stability };
};

const statusFor = (next: number, period: Period, now: number): DetectionStatus => {
  if (now <= next + GRACE_DAYS[period] * DAY) return 'active';
  if (now <= next + PERIOD_DAYS[period] * DAY) return 'overdue';
  return 'possibly_cancelled';
};

export const detectSubscriptions = (transactions: Transaction[], opts: DetectOptions = {}) => {
  const { now = Math.floor(Date.now() / 1000), catalog = SERVICE_CATALOG, minConfidence = 0.45, toLocal } = opts;

  const debits = transactions.filter(t => t.operationAmount < 0).toSorted((a, b) => a.time - b.time);

  const groups = new Map<string, { service: ServiceDefinition | null; txns: Transaction[] }>();
  for (const t of debits) {
    const service = matchService(t.description, catalog);
    const base = service ? `svc:${service.id}` : `m:${merchantKey(t.description)}`;
    if (base === 'm:') continue;
    const key = `${base}|${t.operationCurrency}`;
    const g = groups.get(key) ?? { service, txns: [] };
    g.txns.push(t);
    groups.set(key, g);
  }

  const results: DetectedSubscription[] = [];

  for (const [groupKey, { service, txns }] of groups) {
    const candidates: { key: string; series: Transaction[] }[] = [];
    const whole = !service?.aggregator ? evaluate(txns, !service) : null;
    if (whole) {
      candidates.push({ key: groupKey, series: txns });
    } else if (service?.aggregator || txns.length >= 4) {
      // Aggregators (Apple, Google Play) bill several subscriptions; unknown merchants only count
      // when the exact same amount repeats at least 3 times, so groceries don't look recurring.
      const aggregator = service?.aggregator ?? false;
      for (const c of clusterByAmount(txns, aggregator ? 0.02 : 0)) {
        if (!aggregator && c.length < 3) continue;
        candidates.push({ key: `${groupKey}|${Math.abs(c[0]!.operationAmount)}`, series: c });
      }
    }

    for (const { key, series } of candidates) {
      const ev = series === txns && whole ? whole : evaluate(series, !service);
      if (!ev) continue;

      const last = series.at(-1)!;
      const hasSubMcc = series.some(t => t.mcc != null && SUBSCRIPTION_MCCS.has(t.mcc));
      const confidence = Math.min(
        1,
        0.3 +
          (service ? 0.3 : 0) +
          (hasSubMcc ? 0.1 : 0) +
          ev.regularity * 0.15 +
          ev.stability * 0.1 +
          (Math.min(series.length, 6) / 6) * 0.15,
      );
      if (confidence < minConfidence) continue;

      const price = Math.abs(last.operationAmount);
      const localPrice = localAmountOf(last, toLocal) ?? 0;
      const rate = localPrice ? toMajor(localPrice, LOCAL_CURRENCY) / toMajor(price, last.operationCurrency) : 0;
      const nextChargeAt = addPeriod(last.time, ev.period);

      results.push({
        key,
        serviceId: service?.id ?? null,
        name: service?.name ?? last.counterName ?? (last.description.replace(/\s*[#№]?\d{3,}\S*/g, '').trim() || last.description),
        period: ev.period,
        price,
        currency: last.operationCurrency,
        localPrice,
        rate: Math.round(rate * 10_000) / 10_000,
        firstChargeAt: series[0]!.time,
        lastChargeAt: last.time,
        nextChargeAt,
        chargeCount: series.length,
        accountId: last.accountId,
        confidence: Math.round(confidence * 100) / 100,
        status: statusFor(nextChargeAt, ev.period, now),
        transactionIds: series.map(t => t.id),
      });
    }
  }

  return results.toSorted((a, b) => a.nextChargeAt - b.nextChargeAt);
};
