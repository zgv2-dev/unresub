import { createHash } from 'node:crypto';
import type { BankSource, SourceAccount, SourceTransaction, WebhookEvent } from './types.ts';

const BASE_URL = 'https://api.monobank.ua';
/** monobank: 31 days + 1 hour per statement call. */
const MAX_RANGE = 31 * 86_400 + 3_600;
/** monobank: personal endpoints allow 1 request / 60s per token. */
const PERSONAL_GAP_MS = 61_000;
const PAGE_SIZE = 500;

interface MonoAccount {
  id: string;
  balance: number;
  creditLimit: number;
  type: string;
  currencyCode: number;
  maskedPan?: string[];
  iban?: string;
}

interface MonoClientInfo {
  clientId: string;
  name: string;
  webHookUrl?: string;
  accounts: MonoAccount[];
}

export interface MonoStatementItem {
  id: string;
  time: number;
  description: string;
  mcc: number;
  originalMcc: number;
  hold: boolean;
  amount: number;
  operationAmount: number;
  currencyCode: number;
  commissionRate: number;
  cashbackAmount: number;
  balance: number;
  comment?: string;
  counterName?: string;
  counterEdrpou?: string;
  counterIban?: string;
}

export interface MonoRate {
  currencyCodeA: number;
  currencyCodeB: number;
  date: number;
  rateBuy?: number;
  rateSell?: number;
  rateCross?: number;
}

export class MonobankError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Serialises personal-API calls per token so we never exceed 1 req/min. */
const queues = new Map<string, { last: number; chain: Promise<unknown> }>();

const throttled = <T>(token: string, fn: () => Promise<T>): Promise<T> => {
  const id = createHash('sha256').update(token).digest('hex');
  const q = queues.get(id) ?? { last: 0, chain: Promise.resolve() };
  queues.set(id, q);
  const run = q.chain.then(async () => {
    const wait = q.last + PERSONAL_GAP_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    q.last = Date.now();
    return fn();
  });
  q.chain = run.catch(() => {});
  return run;
};

const request = async <T>(path: string, init: RequestInit = {}, token?: string): Promise<T> => {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { ...(token ? { 'X-Token': token } : {}), 'Content-Type': 'application/json', ...init.headers },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Never include the token in errors.
    throw new MonobankError(res.status, `monobank ${path.split('/').slice(0, 3).join('/')} → ${res.status} ${body.slice(0, 200)}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
};

export const toSourceTransaction = (accountExternalId: string, item: MonoStatementItem, accountCurrency: number): SourceTransaction => ({
  id: `monobank:${item.id}`,
  accountExternalId,
  time: item.time,
  description: item.description,
  mcc: item.mcc ?? null,
  amount: item.amount,
  accountCurrency,
  operationAmount: item.operationAmount,
  operationCurrency: item.currencyCode,
  counterName: item.counterName ?? null,
  hold: item.hold,
  raw: item,
});

export class MonobankSource implements BankSource {
  readonly kind = 'monobank' as const;
  readonly maxRangeSeconds = MAX_RANGE;
  #token: string;
  #accountCurrency = new Map<string, number>();

  constructor(token: string) {
    this.#token = token;
  }

  async clientInfo() {
    const info = await throttled(this.#token, () => request<MonoClientInfo>('/personal/client-info', {}, this.#token));
    for (const a of info.accounts) this.#accountCurrency.set(a.id, a.currencyCode);
    return info;
  }

  async listAccounts(): Promise<SourceAccount[]> {
    const info = await this.clientInfo();
    return info.accounts.map(a => ({
      externalId: a.id,
      currency: a.currencyCode,
      balance: a.balance,
      creditLimit: a.creditLimit,
      maskedPan: a.maskedPan?.[0] ?? null,
      iban: a.iban ?? null,
      type: a.type,
    }));
  }

  /** Call `listAccounts` first (or pass currency via `setAccountCurrency`) so amounts get the right currency. */
  setAccountCurrency(accountExternalId: string, currency: number) {
    this.#accountCurrency.set(accountExternalId, currency);
  }

  async fetchTransactions(accountExternalId: string, from: number, to: number): Promise<SourceTransaction[]> {
    if (to - from > MAX_RANGE) throw new Error('Range exceeds monobank limit of 31 days + 1 hour');
    const currency = this.#accountCurrency.get(accountExternalId) ?? 980;
    const out: SourceTransaction[] = [];
    let upper = to;
    // monobank returns at most 500 items, newest first; page backwards when full.
    while (true) {
      const items = await throttled(this.#token, () =>
        request<MonoStatementItem[]>(`/personal/statement/${accountExternalId}/${from}/${upper}`, {}, this.#token),
      );
      out.push(...items.map(i => toSourceTransaction(accountExternalId, i, currency)));
      if (items.length < PAGE_SIZE) break;
      upper = Math.min(...items.map(i => i.time)) - 1;
      if (upper <= from) break;
    }
    return out;
  }

  async registerWebhook(url: string) {
    await throttled(this.#token, () =>
      request('/personal/webhook', { method: 'POST', body: JSON.stringify({ webHookUrl: url }) }, this.#token),
    );
  }

  parseWebhook(body: unknown): WebhookEvent | null {
    const b = body as { type?: string; data?: { account?: string; statementItem?: MonoStatementItem } };
    if (b?.type !== 'StatementItem' || !b.data?.account || !b.data.statementItem) return null;
    const currency = this.#accountCurrency.get(b.data.account) ?? 980;
    return {
      accountExternalId: b.data.account,
      transaction: toSourceTransaction(b.data.account, b.data.statementItem, currency),
    };
  }

  /** Public endpoint, cached by monobank for ~5 minutes. */
  static fetchRates() {
    return request<MonoRate[]>('/bank/currency');
  }
}
