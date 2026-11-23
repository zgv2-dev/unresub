import type { CurrencyCode, Period } from './types.ts';

const ALPHA: Record<number, { code: string; minor: number }> = {
  980: { code: 'UAH', minor: 2 },
  840: { code: 'USD', minor: 2 },
  978: { code: 'EUR', minor: 2 },
  826: { code: 'GBP', minor: 2 },
  985: { code: 'PLN', minor: 2 },
  203: { code: 'CZK', minor: 2 },
  756: { code: 'CHF', minor: 2 },
  949: { code: 'TRY', minor: 2 },
  392: { code: 'JPY', minor: 0 },
};

export const currencyAlpha = (code: CurrencyCode) => ALPHA[code]?.code ?? String(code);
const minorDigits = (code: CurrencyCode) => ALPHA[code]?.minor ?? 2;

export const toMajor = (minor: number, code: CurrencyCode) => minor / 10 ** minorDigits(code);

export const formatMoney = (minor: number, code: CurrencyCode, locale = 'uk-UA') => {
  const alpha = ALPHA[code]?.code;
  const value = toMajor(minor, code);
  return alpha
    ? new Intl.NumberFormat(locale, { style: 'currency', currency: alpha }).format(value)
    : `${value.toFixed(2)} (${code})`;
};

export const PERIODS_PER_YEAR: Record<Period, number> = {
  weekly: 52,
  monthly: 12,
  quarterly: 4,
  semiannual: 2,
  annual: 1,
};

export const PERIOD_DAYS: Record<Period, number> = {
  weekly: 7,
  monthly: 30.44,
  quarterly: 91.31,
  semiannual: 182.62,
  annual: 365.25,
};

export const monthlyEquivalent = (price: number, period: Period) =>
  Math.round((price * PERIODS_PER_YEAR[period]) / 12);

export const annualEquivalent = (price: number, period: Period) =>
  Math.round(price * PERIODS_PER_YEAR[period]);

const MONTHS: Partial<Record<Period, number>> = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 };

/** Adds one period using calendar months (keeps the day of month, clamps to month end). */
export const addPeriod = (unixSeconds: number, period: Period, times = 1) => {
  const d = new Date(unixSeconds * 1000);
  if (period === 'weekly') return unixSeconds + times * 7 * 86_400;
  const months = MONTHS[period]! * times;
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return Math.floor(target.getTime() / 1000);
};
