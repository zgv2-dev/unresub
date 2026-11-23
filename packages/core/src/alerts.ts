import type { CurrencyCode, DetectionStatus } from './types.ts';

const DAY = 86_400;

export interface AlertAccount {
  id: string;
  currency: CurrencyCode;
  /** Own funds, minor units. Credit limit is ignored on purpose: the point of a subs card is not to go negative. */
  balance: number;
  isSubscriptionCard: boolean;
}

export interface AlertSubscription {
  key: string;
  name: string;
  nextChargeAt: number;
  price: number;
  currency: CurrencyCode;
  accountId: string;
  status: DetectionStatus;
  ignored: boolean;
  /** Days before the charge the reminder starts. Default 1. */
  remindDays?: number | null;
}

/** Converts minor units between currencies; null when no rate is known. */
export type Convert = (minor: number, from: CurrencyCode, to: CurrencyCode) => number | null;

export type Alert =
  | { type: 'upcoming_charge'; key: string; name: string; chargeAt: number; price: number; currency: CurrencyCode; overdue: boolean }
  | {
      type: 'low_balance';
      key: string;
      name: string;
      chargeAt: number;
      accountId: string;
      /** All charges on this card up to and including this one, in the card's currency. */
      required: number;
      balance: number;
      shortfall: number;
      currency: CurrencyCode;
    }
  | { type: 'on_main_card'; key: string; name: string; accountId: string };

export interface AlertOptions {
  now?: number;
  convert?: Convert;
  /** How far ahead the subs-card balance is checked. */
  lowBalanceWindowDays?: number;
}

const live = (s: AlertSubscription) => !s.ignored && s.status !== 'possibly_cancelled';

/**
 * - upcoming_charge: from `remindDays` before the charge until the charge is detected
 *   (detection moves `nextChargeAt` forward, which clears it). Not dismissable by design.
 * - low_balance: charges due on a subscriptions card within the window, summed in date order,
 *   that the card's balance won't cover.
 * - on_main_card: once a subscriptions card exists, every live subscription billed elsewhere.
 */
export const computeAlerts = (subs: AlertSubscription[], accounts: AlertAccount[], opts: AlertOptions = {}): Alert[] => {
  const { now = Math.floor(Date.now() / 1000), convert, lowBalanceWindowDays = 3 } = opts;
  const active = subs.filter(live).toSorted((a, b) => a.nextChargeAt - b.nextChargeAt);
  const subsCards = accounts.filter(a => a.isSubscriptionCard);
  const alerts: Alert[] = [];

  for (const s of active) {
    if (now >= s.nextChargeAt - (s.remindDays ?? 1) * DAY) {
      alerts.push({ type: 'upcoming_charge', key: s.key, name: s.name, chargeAt: s.nextChargeAt, price: s.price, currency: s.currency, overdue: now > s.nextChargeAt });
    }
  }

  for (const card of subsCards) {
    let required = 0;
    for (const s of active) {
      if (s.accountId !== card.id || s.nextChargeAt > now + lowBalanceWindowDays * DAY) continue;
      const amount = s.currency === card.currency ? s.price : convert?.(s.price, s.currency, card.currency) ?? null;
      if (amount == null) continue;
      required += amount;
      if (required > card.balance) {
        alerts.push({
          type: 'low_balance', key: s.key, name: s.name, chargeAt: s.nextChargeAt, accountId: card.id,
          required, balance: card.balance, shortfall: required - card.balance, currency: card.currency,
        });
      }
    }
  }

  if (subsCards.length) {
    const ids = new Set(subsCards.map(a => a.id));
    for (const s of active) {
      if (!ids.has(s.accountId)) alerts.push({ type: 'on_main_card', key: s.key, name: s.name, accountId: s.accountId });
    }
  }

  return alerts;
};
