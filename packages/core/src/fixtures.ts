import { addPeriod } from './money.ts';
import type { Period, Transaction } from './types.ts';

interface SeriesSpec {
  description: string;
  mcc?: number;
  period: Period;
  /** Positive minor units in `currency`. */
  price: number;
  currency: number;
  /** UAH per unit, used to build the account (UAH) amount. */
  rate?: number;
  count: number;
  /** Unix seconds of the last charge. */
  last: number;
  counterName?: string;
}

let seq = 0;

export const makeSeries = (spec: SeriesSpec, accountId = 'acc-main'): Transaction[] => {
  const { description, mcc = 5815, period, price, currency, rate = 1, count, last, counterName } = spec;
  return Array.from({ length: count }, (_, i) => {
    const time = addPeriod(last, period, -(count - 1 - i)) + ((i * 3_607) % 7_200);
    return {
      id: `fixture:${++seq}`,
      accountId,
      time,
      description,
      mcc,
      amount: -Math.round(price * rate),
      accountCurrency: 980,
      operationAmount: -price,
      operationCurrency: currency,
      counterName: counterName ?? null,
    };
  });
};

/** A realistic-looking year of noise: groceries, transport, cafes. */
export const makeNoise = (from: number, to: number, accountId = 'acc-main'): Transaction[] => {
  const merchants = ['Silpo', 'ATB', 'Uklon', 'Lviv Croissants', 'Nova Poshta', 'Rozetka', 'WOG'];
  const out: Transaction[] = [];
  let r = 42;
  const rand = () => ((r = (r * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
  for (let t = from; t < to; t += Math.floor(rand() * 86_400 * 1.5) + 3_600) {
    const description = merchants[Math.floor(rand() * merchants.length)]!;
    const amount = -Math.floor(rand() * 150_000 + 3_000);
    out.push({
      id: `fixture:${++seq}`,
      accountId,
      time: t,
      description,
      mcc: 5411,
      amount,
      accountCurrency: 980,
      operationAmount: amount,
      operationCurrency: 980,
    });
  }
  return out;
};

export const demoTransactions = (now = Math.floor(Date.now() / 1000)) => {
  const day = 86_400;
  const usd = 840;
  return [
    ...makeNoise(now - 365 * day, now),
    ...makeSeries({ description: 'CLAUDE.AI SUBSCRIPTION', period: 'monthly', price: 2_000, currency: usd, rate: 41.5, count: 8, last: now - 12 * day }),
    ...makeSeries({ description: 'APPLE.COM/BILL', period: 'monthly', price: 299, currency: usd, rate: 41.4, count: 12, last: now - 3 * day }),
    ...makeSeries({ description: 'APPLE.COM/BILL', period: 'monthly', price: 999, currency: usd, rate: 41.4, count: 6, last: now - 20 * day }),
    ...makeSeries({ description: 'Telegram Premium', period: 'annual', price: 3_599, currency: usd, rate: 41.2, count: 2, last: now - 40 * day }),
    ...makeSeries({ description: 'DISCORD* NITRO', period: 'monthly', price: 999, currency: usd, rate: 41.3, count: 5, last: now - 25 * day }),
    ...makeSeries({ description: 'GOOGLE *YouTubePremium', period: 'monthly', price: 9_900, currency: 980, count: 10, last: now - 7 * day }),
    ...makeSeries({ description: 'MEGOGO.NET', period: 'monthly', price: 19_900, currency: 980, count: 4, last: now - 80 * day, mcc: 4899 }),
    ...makeSeries({ description: 'Hetzner Online 7781234', period: 'monthly', price: 450, currency: 978, rate: 48.1, count: 6, last: now - 9 * day, mcc: 7372 }),
    ...makeSeries({ description: 'Kyivstar mobile', period: 'monthly', price: 25_000, currency: 980, count: 12, last: now - 1 * day, mcc: 4814 }),
  ];
};
