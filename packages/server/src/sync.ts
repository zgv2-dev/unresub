import { LOCAL_CURRENCY, toMajor, type CurrencyCode } from '@unresub/core';
import { decryptSecret, encryptSecret, randomToken, safeEqual } from './crypto.ts';
import type { Db, SourceRow } from './db.ts';
import { MonobankSource, type MonoRate, type MonoStatementItem } from './sources/monobank.ts';
import type { BankSource } from './sources/types.ts';

export interface SyncOptions {
  key: Buffer;
  publicUrl: string | null;
  backfillMonths: number;
  log?: (msg: string) => void;
  /** Where exchange rates live; shared across users in multi-user mode. Defaults to this database. */
  rates?: RateStore;
}

export type RateStore = Pick<Db, 'insertRates' | 'rateNear'>;

/** Rates are public and monobank limits /bank/currency per IP, so all users share one refresher. */
const ratesFetchedAt = new WeakMap<RateStore, number>();

export type SyncState = 'idle' | 'fetching' | 'waiting_rate_limit' | 'retrying';

export interface SyncStatus {
  running: boolean;
  phase: 'idle' | 'incremental' | 'backfill';
  /** Derived at read time: waiting while the next request slot is in the future. */
  state: SyncState;
  currentAccountId: string | null;
  /** Epoch ms of the next allowed request. */
  nextRequestAt: number | null;
  /** Requests done / planned in the current run. */
  done: number;
  total: number;
  etaSeconds: number | null;
  /** Requests still planned per account in the current run. */
  remainingByAccount: Record<string, number>;
  lastError: string | null;
  lastFinishedAt: number | null;
}

interface RunState extends Omit<SyncStatus, 'state' | 'etaSeconds'> {
  retrying: boolean;
  gapMs: number;
}

const nowS = () => Math.floor(Date.now() / 1000);

export class SyncService {
  #status = new Map<string, RunState>();
  /** One adapter per source, so its per-token rate limiter is shared by sync and webhooks. */
  #adapters = new Map<string, BankSource>();
  #rates: RateStore;

  constructor(private db: Db, private opts: SyncOptions) {
    this.#rates = opts.rates ?? db;
  }

  #log(msg: string) {
    (this.opts.log ?? console.log)(`[sync] ${msg}`);
  }

  adapterFor(row: SourceRow): BankSource {
    const cached = this.#adapters.get(row.id);
    if (cached) return cached;
    const creds = JSON.parse(decryptSecret(row.credentials_enc, this.opts.key, row.id)) as { token: string };
    switch (row.kind) {
      case 'monobank': {
        const src = new MonobankSource(creds.token);
        for (const a of this.db.accountsBySource(row.id)) src.setAccountCurrency(a.external_id, a.currency);
        this.#adapters.set(row.id, src);
        return src;
      }
      default:
        throw new Error(`Source kind ${row.kind} is not implemented yet`);
    }
  }

  webhookUrl(row: Pick<SourceRow, 'id' | 'webhook_secret'>) {
    return this.opts.publicUrl ? `${this.opts.publicUrl}/hooks/${row.id}/${row.webhook_secret}` : null;
  }

  status(sourceId: string): SyncStatus {
    const r = this.#status.get(sourceId);
    if (!r) {
      return {
        running: false, phase: 'idle', state: 'idle', currentAccountId: null, nextRequestAt: null,
        done: 0, total: 0, etaSeconds: null, remainingByAccount: {}, lastError: null, lastFinishedAt: null,
      };
    }
    const { retrying, gapMs, ...rest } = r;
    const now = Date.now();
    const waitMs = r.nextRequestAt && r.nextRequestAt > now ? r.nextRequestAt - now : 0;
    const state: SyncState = !r.running ? 'idle' : retrying ? 'retrying' : waitMs > 0 ? 'waiting_rate_limit' : 'fetching';
    const remaining = r.total - r.done;
    return {
      ...rest,
      state,
      etaSeconds: r.running ? Math.round((waitMs + Math.max(0, remaining - 1) * gapMs + (remaining > 0 ? 2_000 : 0)) / 1000) : null,
    };
  }

  /** Validates the token, stores it encrypted, registers the webhook, and starts the backfill in the background. */
  async connectMonobank(token: string) {
    const src = new MonobankSource(token);
    const info = await src.clientInfo(); // throws on a bad token
    const id = `monobank-${randomToken(6)}`;
    const row = {
      id,
      kind: 'monobank' as const,
      name: `monobank · ${info.name}`,
      credentials_enc: encryptSecret(JSON.stringify({ token }), this.opts.key, id),
      webhook_secret: randomToken(),
    };
    this.db.insertSource(row);
    this.#adapters.set(id, src);
    this.db.upsertAccounts(id, info.accounts.map(a => ({
      externalId: a.id, currency: a.currencyCode, balance: a.balance, creditLimit: a.creditLimit,
      maskedPan: a.maskedPan?.[0] ?? null, iban: a.iban ?? null, type: a.type,
    })));

    const hook = this.webhookUrl(row);
    let webhook: 'registered' | 'skipped' | 'failed' = 'skipped';
    if (hook) {
      try {
        await src.registerWebhook(hook);
        webhook = 'registered';
      } catch (e) {
        webhook = 'failed';
        this.#log(`webhook registration failed for ${id}: ${(e as Error).message}`);
      }
    }

    void this.syncSource(id, src);
    return { id, name: row.name, accounts: this.db.accountsBySource(id).length, webhook };
  }

  /**
   * Incremental first (from the last synced point to now), then backfill older
   * history in 31-day chunks, newest first, so recent subscriptions show up early.
   */
  async syncSource(sourceId: string, adapter?: BankSource) {
    const row = this.db.getSource(sourceId);
    if (!row) throw new Error(`Unknown source ${sourceId}`);
    if (this.#status.get(sourceId)?.running) return;
    const src = adapter ?? this.adapterFor(row);
    const status: RunState = {
      running: true, phase: 'incremental', currentAccountId: null, nextRequestAt: src.nextRequestAt?.() ?? null,
      done: 0, total: 0, remainingByAccount: {}, lastError: null,
      lastFinishedAt: this.#status.get(sourceId)?.lastFinishedAt ?? null, retrying: false, gapMs: src.minRequestGapMs ?? 0,
    };
    this.#status.set(sourceId, status);
    void this.refreshRates();

    try {
      if (!adapter) this.db.upsertAccounts(sourceId, await src.listAccounts());
      const accounts = this.db.accountsBySource(sourceId);
      const end = nowS();
      const horizon = this.horizon(end);
      const step = src.maxRangeSeconds - 60;

      type Chunk = { accountId: string; externalId: string; from: number; to: number; phase: SyncStatus['phase'] };
      const incremental: Chunk[] = [];
      const backfill: Chunk[] = [];
      for (const a of accounts) {
        const syncedTo = a.synced_to ?? end - step;
        const chunks: Chunk[] = [];
        for (let to = end; to > syncedTo; to -= step) {
          chunks.push({ accountId: a.id, externalId: a.external_id, from: Math.max(to - step, syncedTo - 3_600), to, phase: 'incremental' });
        }
        // Oldest first, so synced_to only advances past windows that were actually fetched.
        incremental.push(...chunks.reverse());
        for (let to = a.backfilled_from ?? end - step; to > horizon; to -= step) {
          backfill.push({ accountId: a.id, externalId: a.external_id, from: Math.max(to - step, horizon), to, phase: 'backfill' });
        }
      }
      // Backfill: newest windows of every account first, so recent subscriptions appear early.
      // Progress is saved per window, so a restart resumes from accounts.backfilled_from.
      const plan = [...incremental, ...backfill.sort((x, y) => y.to - x.to)];
      status.total = plan.length;
      for (const p of plan) status.remainingByAccount[p.accountId] = (status.remainingByAccount[p.accountId] ?? 0) + 1;

      // Accounts whose history monobank says has run out: their older windows are skipped.
      const ended = new Set<string>();
      const advance = (p: Chunk) => (status.done++, status.remainingByAccount[p.accountId]!--);
      for (const p of plan) {
        if (ended.has(p.accountId)) {
          advance(p);
          continue;
        }
        Object.assign(status, { phase: p.phase, currentAccountId: p.accountId, nextRequestAt: src.nextRequestAt?.() ?? null });
        const range = `${new Date(p.from * 1000).toISOString().slice(0, 10)}..${new Date(p.to * 1000).toISOString().slice(0, 10)}`;
        let txns: Awaited<ReturnType<BankSource['fetchTransactions']>>;
        try {
          txns = await this.#fetchWithRetry(src, p, status);
        } catch (e) {
          if (p.phase !== 'backfill' || !isOutOfRange(e)) throw e;
          // monobank keeps a limited history (and none before the card was opened): this is the start.
          this.db.markProgress(p.accountId, horizon, p.to);
          ended.add(p.accountId);
          advance(p);
          this.#log(`${sourceId} backfill ${range}: no older history, done for this card`);
          continue;
        }
        this.db.insertTransactions(p.accountId, txns);
        this.db.markProgress(p.accountId, p.from, p.to);
        advance(p);
        this.#log(`${sourceId} ${p.phase} ${range}: ${txns.length} txns (${status.done}/${status.total})`);
      }
    } catch (e) {
      this.#log(`${sourceId} failed: ${(e as Error).message}`);
      status.lastError = friendlyError(e);
    } finally {
      Object.assign(status, { running: false, phase: 'idle', currentAccountId: null, retrying: false, lastFinishedAt: nowS() });
    }
  }

  /** monobank answers 429 when the 1/min limit is hit anyway (e.g. another client uses the token): wait and retry. */
  async #fetchWithRetry(src: BankSource, p: { externalId: string; from: number; to: number }, status: RunState) {
    for (let attempt = 0; ; attempt++) {
      try {
        const txns = await src.fetchTransactions(p.externalId, p.from, p.to);
        status.retrying = false;
        return txns;
      } catch (e) {
        if ((e as { status?: number }).status !== 429 || attempt >= 3) throw e;
        status.retrying = true;
        // A throttled adapter already spaces the retry by its own gap; otherwise wait a minute.
        if (src.nextRequestAt) status.nextRequestAt = src.nextRequestAt();
        else {
          status.nextRequestAt = Date.now() + 60_000;
          await new Promise(r => setTimeout(r, 60_000));
        }
      }
    }
  }

  horizon(end = nowS()) {
    return end - Math.round(this.opts.backfillMonths * 30.44 * 86_400);
  }

  get backfillMonths() {
    return this.opts.backfillMonths;
  }

  syncAll() {
    return Promise.all(this.db.listSources().filter(s => s.id !== 'demo').map(s => this.syncSource(s.id)));
  }

  /** Returns false when the secret doesn't match or the payload isn't a transaction. */
  handleWebhook(sourceId: string, secret: string, body: unknown) {
    const row = this.db.getSource(sourceId);
    if (!row || !safeEqual(secret, row.webhook_secret)) return false;
    const event = this.adapterFor(row).parseWebhook?.(body);
    if (!event) return false;
    const account = this.db.accountByExternal(sourceId, event.accountExternalId);
    if (!account) return false;
    this.db.insertTransactions(account.id, [{ ...event.transaction, accountCurrency: account.currency }]);
    const balance = (event.transaction.raw as MonoStatementItem | undefined)?.balance;
    if (typeof balance === 'number') this.db.setBalance(account.id, balance);
    this.#log(`${sourceId} webhook: 1 transaction`);
    void this.refreshRates();
    return true;
  }

  async refreshRates() {
    if (nowS() - (ratesFetchedAt.get(this.#rates) ?? 0) < 3_600) return;
    ratesFetchedAt.set(this.#rates, nowS());
    try {
      const list: MonoRate[] = await MonobankSource.fetchRates();
      this.#rates.insertRates(
        nowS(),
        list.filter(r => r.currencyCodeB === LOCAL_CURRENCY).map(r => ({ currency: r.currencyCodeA, buy: r.rateBuy, sell: r.rateSell, cross: r.rateCross })),
      );
    } catch (e) {
      this.#log(`rates fetch failed: ${(e as Error).message}`);
    }
  }

  #rate(currency: CurrencyCode, side: 'buy' | 'sell', time: number) {
    const r = this.#rates.rateNear(currency, time);
    return (side === 'sell' ? r?.rate_sell : r?.rate_buy) ?? r?.rate_cross ?? null;
  }

  /**
   * Used only when neither side of a transaction is in UAH (e.g. a USD charge on the USD card).
   * Picks the stored monobank rate snapshot closest to the charge time.
   */
  toLocal = (minor: number, currency: CurrencyCode, time: number) => {
    const rate = this.#rate(currency, 'sell', time);
    return rate ? Math.round(toMajor(minor, currency) * rate * 100) : null;
  };

  /**
   * Estimates what a charge costs in another currency at today's monobank rates.
   * Leans pessimistic (bank sells foreign currency to you, buys it back cheaper), which suits balance warnings.
   */
  convert = (minor: number, from: CurrencyCode, to: CurrencyCode): number | null => {
    if (from === to) return minor;
    const sell = from === LOCAL_CURRENCY ? 1 : this.#rate(from, 'sell', nowS());
    const buy = to === LOCAL_CURRENCY ? 1 : this.#rate(to, 'buy', nowS());
    if (!sell || !buy) return null;
    return Math.round((toMajor(minor, from) * sell) / buy / toMajor(1, to));
  };

  /** Forget a deleted source's adapter and status. */
  forget(sourceId: string) {
    this.#adapters.delete(sourceId);
    this.#status.delete(sourceId);
  }

  /** Re-registers webhooks, e.g. after the data moved to a new user database. */
  async registerWebhooks() {
    for (const row of this.db.listSources()) {
      const hook = this.webhookUrl(row);
      const src = this.adapterFor(row);
      if (!hook || !src.registerWebhook) continue;
      await src.registerWebhook(hook).catch(e => this.#log(`${row.id} webhook registration failed: ${(e as Error).message}`));
    }
  }

  startScheduler(hours: number) {
    const timer = setInterval(() => void this.syncAll(), hours * 3_600_000);
    timer.unref();
    return () => clearInterval(timer);
  }
}

/** monobank's 400 for a statement window outside the history it keeps ("Value field 'to' out of bounds"). */
const isOutOfRange = (e: unknown) => (e as { status?: number }).status === 400 && /out of bounds/i.test((e as Error).message);

/** What the Cards tab shows: plain words instead of the raw bank response. */
export const friendlyError = (e: unknown) => {
  const status = (e as { status?: number }).status;
  if (status === 401 || status === 403) return 'monobank rejected the token. Add a new one from api.monobank.ua.';
  if (status === 429) return 'monobank is rate limiting requests. Sync will try again later.';
  if (isOutOfRange(e)) return 'monobank refused the requested dates. Sync will try again later.';
  if (status && status >= 500) return 'monobank is not responding right now. Sync will try again later.';
  return (e as Error).message;
};
