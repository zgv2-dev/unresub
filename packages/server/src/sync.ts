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
}

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
  #ratesAt = 0;

  constructor(private db: Db, private opts: SyncOptions) {}

  #log(msg: string) {
    (this.opts.log ?? console.log)(`[sync] ${msg}`);
  }

  adapterFor(row: SourceRow): BankSource {
    const creds = JSON.parse(decryptSecret(row.credentials_enc, this.opts.key, row.id)) as { token: string };
    switch (row.kind) {
      case 'monobank': {
        const src = new MonobankSource(creds.token);
        for (const a of this.db.accountsBySource(row.id)) src.setAccountCurrency(a.external_id, a.currency);
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

      for (const p of plan) {
        Object.assign(status, { phase: p.phase, currentAccountId: p.accountId, nextRequestAt: src.nextRequestAt?.() ?? null });
        const txns = await this.#fetchWithRetry(src, p, status);
        this.db.insertTransactions(p.accountId, txns);
        this.db.markProgress(p.accountId, p.from, p.to);
        status.done++;
        status.remainingByAccount[p.accountId]!--;
        this.#log(`${sourceId} ${p.phase} ${new Date(p.from * 1000).toISOString().slice(0, 10)}..${new Date(p.to * 1000).toISOString().slice(0, 10)}: ${txns.length} txns (${status.done}/${status.total})`);
      }
    } catch (e) {
      status.lastError = (e as Error).message;
      this.#log(`${sourceId} failed: ${status.lastError}`);
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
    this.#log(`${sourceId} webhook: ${event.transaction.description}`);
    void this.refreshRates();
    return true;
  }

  async refreshRates() {
    if (nowS() - this.#ratesAt < 3_600) return;
    this.#ratesAt = nowS();
    try {
      const list: MonoRate[] = await MonobankSource.fetchRates();
      this.db.insertRates(
        nowS(),
        list.filter(r => r.currencyCodeB === LOCAL_CURRENCY).map(r => ({ currency: r.currencyCodeA, buy: r.rateBuy, sell: r.rateSell, cross: r.rateCross })),
      );
    } catch (e) {
      this.#log(`rates fetch failed: ${(e as Error).message}`);
    }
  }

  #rate(currency: CurrencyCode, side: 'buy' | 'sell', time: number) {
    const r = this.db.rateNear(currency, time);
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

  startScheduler(hours: number) {
    const timer = setInterval(() => void this.syncAll(), hours * 3_600_000);
    timer.unref();
    return () => clearInterval(timer);
  }
}
