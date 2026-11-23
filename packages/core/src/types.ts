/** ISO 4217 numeric currency code, e.g. 980 = UAH, 840 = USD. */
export type CurrencyCode = number;

export const LOCAL_CURRENCY: CurrencyCode = 980;

export type Period = 'weekly' | 'monthly' | 'quarterly' | 'semiannual' | 'annual';

/** Bank-agnostic transaction. Amounts are integers in minor units (kopiyky, cents). */
export interface Transaction {
  /** Globally unique: `${sourceKind}:${externalId}` */
  id: string;
  accountId: string;
  /** Unix seconds */
  time: number;
  description: string;
  mcc: number | null;
  /** In account currency. Negative = debit. */
  amount: number;
  accountCurrency: CurrencyCode;
  /** In the currency the merchant charged. Negative = debit. */
  operationAmount: number;
  operationCurrency: CurrencyCode;
  counterName?: string | null;
  hold?: boolean;
}

export interface ServiceDefinition {
  id: string;
  name: string;
  /** Matched against the normalised description (lowercase). */
  patterns: RegExp[];
  /** Merchant bills many different subscriptions (Apple, Google Play): split series by price. */
  aggregator?: boolean;
  cancelUrl?: string;
  category: 'ai' | 'video' | 'music' | 'cloud' | 'software' | 'social' | 'telecom' | 'news' | 'gaming' | 'store' | 'other';
}

export type DetectionStatus = 'active' | 'overdue' | 'possibly_cancelled';

export interface DetectedSubscription {
  /** Stable key, used to attach user overrides across re-detections. */
  key: string;
  /** Merchant/service + currency group this series came from; `key === groupKey` when it wasn't split by price. */
  groupKey: string;
  serviceId: string | null;
  name: string;
  period: Period;
  /** Latest charge in the merchant's currency, positive minor units. */
  price: number;
  currency: CurrencyCode;
  /** Latest charge in local currency (UAH) at the transaction-time rate, positive minor units. */
  localPrice: number;
  /** Local per 1 unit of `currency` at the time of the latest charge. */
  rate: number;
  lastChargeAt: number;
  nextChargeAt: number;
  firstChargeAt: number;
  chargeCount: number;
  accountId: string;
  confidence: number;
  status: DetectionStatus;
  transactionIds: string[];
}
