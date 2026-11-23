import { DatabaseSync } from 'node:sqlite';
import type { Period, Transaction } from '@unresub/core';
import type { SourceAccount, SourceKind, SourceTransaction } from './sources/types.ts';

const SCHEMA = /* sql */ `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sources (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  name            TEXT NOT NULL,
  credentials_enc TEXT NOT NULL,          -- AES-256-GCM, see crypto.ts
  webhook_secret  TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id                   TEXT PRIMARY KEY,
  source_id            TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  external_id          TEXT NOT NULL,
  currency             INTEGER NOT NULL,
  balance              INTEGER NOT NULL,
  credit_limit         INTEGER NOT NULL DEFAULT 0,
  masked_pan           TEXT,
  iban                 TEXT,
  type                 TEXT,
  is_subscription_card INTEGER NOT NULL DEFAULT 0, -- for "subs still on main card" + low-balance warnings
  backfilled_from      INTEGER,                   -- oldest time fetched so far
  synced_to            INTEGER,                   -- newest time fetched so far
  updated_at           INTEGER NOT NULL,
  UNIQUE (source_id, external_id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id                 TEXT PRIMARY KEY,
  account_id         TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  time               INTEGER NOT NULL,
  description        TEXT NOT NULL,
  mcc                INTEGER,
  amount             INTEGER NOT NULL,
  account_currency   INTEGER NOT NULL,
  operation_amount   INTEGER NOT NULL,
  operation_currency INTEGER NOT NULL,
  counter_name       TEXT,
  hold               INTEGER NOT NULL DEFAULT 0,
  raw                TEXT
);
CREATE INDEX IF NOT EXISTS transactions_time ON transactions(time);

-- monobank /bank/currency snapshots, so foreign-card charges get the rate closest to when they happened.
CREATE TABLE IF NOT EXISTS rate_snapshots (
  fetched_at INTEGER NOT NULL,
  currency   INTEGER NOT NULL,
  rate_buy   REAL,
  rate_sell  REAL,
  rate_cross REAL,
  PRIMARY KEY (fetched_at, currency)
);

-- Merchant groups the user split into separate subscriptions by price.
CREATE TABLE IF NOT EXISTS split_groups (
  group_key  TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- User edits on top of detection, keyed by the detection key so re-detection keeps them.
CREATE TABLE IF NOT EXISTS subscription_overrides (
  key         TEXT PRIMARY KEY,
  name        TEXT,
  service_id  TEXT,
  period      TEXT,
  status      TEXT,             -- 'confirmed' | 'ignored' | NULL
  cancel_url  TEXT,
  notes       TEXT,
  remind_days INTEGER,          -- reminder lead time, for later notifications
  merged_into TEXT,             -- fold this series into another key
  updated_at  INTEGER NOT NULL
);
`;

export interface AccountRow {
  id: string;
  source_id: string;
  external_id: string;
  currency: number;
  balance: number;
  credit_limit: number;
  masked_pan: string | null;
  iban: string | null;
  type: string | null;
  is_subscription_card: number;
  backfilled_from: number | null;
  synced_to: number | null;
  updated_at: number;
}

export interface SourceRow {
  id: string;
  kind: SourceKind;
  name: string;
  credentials_enc: string;
  webhook_secret: string;
  created_at: number;
}

export interface OverrideRow {
  key: string;
  name: string | null;
  service_id: string | null;
  period: Period | null;
  status: 'confirmed' | 'ignored' | null;
  cancel_url: string | null;
  notes: string | null;
  remind_days: number | null;
  merged_into: string | null;
  updated_at: number;
}

const now = () => Math.floor(Date.now() / 1000);

export const openDb = (path: string) => {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  // Migrations for databases created before a column existed.
  const cols = (table: string) => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name));
  if (!cols('subscription_overrides').has('merged_into')) db.exec('ALTER TABLE subscription_overrides ADD COLUMN merged_into TEXT');

  const q = {
    insertSource: db.prepare(
      'INSERT INTO sources (id, kind, name, credentials_enc, webhook_secret, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    sources: db.prepare('SELECT * FROM sources ORDER BY created_at'),
    source: db.prepare('SELECT * FROM sources WHERE id = ?'),
    deleteSource: db.prepare('DELETE FROM sources WHERE id = ?'),
    upsertAccount: db.prepare(`
      INSERT INTO accounts (id, source_id, external_id, currency, balance, credit_limit, masked_pan, iban, type, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (source_id, external_id) DO UPDATE SET
        balance = excluded.balance, credit_limit = excluded.credit_limit, masked_pan = excluded.masked_pan,
        iban = excluded.iban, type = excluded.type, currency = excluded.currency, updated_at = excluded.updated_at`),
    accounts: db.prepare('SELECT * FROM accounts ORDER BY source_id, currency'),
    accountsBySource: db.prepare('SELECT * FROM accounts WHERE source_id = ?'),
    accountByExternal: db.prepare('SELECT * FROM accounts WHERE source_id = ? AND external_id = ?'),
    setSubCard: db.prepare('UPDATE accounts SET is_subscription_card = ? WHERE id = ?'),
    setBalance: db.prepare('UPDATE accounts SET balance = ?, updated_at = ? WHERE id = ?'),
    setProgress: db.prepare(
      'UPDATE accounts SET backfilled_from = MIN(COALESCE(backfilled_from, ?), ?), synced_to = MAX(COALESCE(synced_to, ?), ?) WHERE id = ?',
    ),
    upsertTxn: db.prepare(`
      INSERT INTO transactions (id, account_id, time, description, mcc, amount, account_currency, operation_amount, operation_currency, counter_name, hold, raw)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        hold = excluded.hold, amount = excluded.amount, operation_amount = excluded.operation_amount, raw = excluded.raw`),
    txns: db.prepare('SELECT * FROM transactions WHERE time >= ? ORDER BY time'),
    insertRate: db.prepare('INSERT OR REPLACE INTO rate_snapshots (fetched_at, currency, rate_buy, rate_sell, rate_cross) VALUES (?, ?, ?, ?, ?)'),
    rateNear: db.prepare('SELECT * FROM rate_snapshots WHERE currency = ? ORDER BY ABS(fetched_at - ?) LIMIT 1'),
    overrides: db.prepare('SELECT * FROM subscription_overrides'),
    upsertOverride: db.prepare(`
      INSERT INTO subscription_overrides (key, name, service_id, period, status, cancel_url, notes, remind_days, merged_into, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET
        name = excluded.name, service_id = excluded.service_id, period = excluded.period, status = excluded.status,
        cancel_url = excluded.cancel_url, notes = excluded.notes, remind_days = excluded.remind_days, merged_into = excluded.merged_into, updated_at = excluded.updated_at`),
    splitGroups: db.prepare('SELECT group_key FROM split_groups'),
    addSplit: db.prepare('INSERT OR IGNORE INTO split_groups (group_key, created_at) VALUES (?, ?)'),
    removeSplit: db.prepare('DELETE FROM split_groups WHERE group_key = ?'),
  };

  return {
    raw: db,
    close: () => db.close(),

    insertSource: (s: Omit<SourceRow, 'created_at'>) =>
      void q.insertSource.run(s.id, s.kind, s.name, s.credentials_enc, s.webhook_secret, now()),
    listSources: () => q.sources.all() as unknown as SourceRow[],
    getSource: (id: string) => q.source.get(id) as unknown as SourceRow | undefined,
    deleteSource: (id: string) => void q.deleteSource.run(id),

    upsertAccounts: (sourceId: string, accounts: SourceAccount[]) => {
      for (const a of accounts) {
        q.upsertAccount.run(
          `${sourceId}:${a.externalId}`, sourceId, a.externalId, a.currency, a.balance, a.creditLimit,
          a.maskedPan, a.iban, a.type, now(),
        );
      }
    },
    listAccounts: () => q.accounts.all() as unknown as AccountRow[],
    accountsBySource: (sourceId: string) => q.accountsBySource.all(sourceId) as unknown as AccountRow[],
    accountByExternal: (sourceId: string, externalId: string) =>
      q.accountByExternal.get(sourceId, externalId) as unknown as AccountRow | undefined,
    setSubscriptionCard: (accountId: string, value: boolean) => void q.setSubCard.run(value ? 1 : 0, accountId),
    setBalance: (accountId: string, balance: number) => void q.setBalance.run(balance, now(), accountId),
    markProgress: (accountId: string, from: number, to: number) => void q.setProgress.run(from, from, to, to, accountId),

    insertTransactions: (accountId: string, txns: SourceTransaction[]) => {
      db.exec('BEGIN');
      try {
        for (const t of txns) {
          q.upsertTxn.run(
            t.id, accountId, t.time, t.description, t.mcc, t.amount, t.accountCurrency, t.operationAmount,
            t.operationCurrency, t.counterName ?? null, t.hold ? 1 : 0, JSON.stringify(t.raw),
          );
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    listTransactions: (since = 0): Transaction[] =>
      (q.txns.all(since) as Record<string, any>[]).map(r => ({
        id: r.id,
        accountId: r.account_id,
        time: r.time,
        description: r.description,
        mcc: r.mcc,
        amount: r.amount,
        accountCurrency: r.account_currency,
        operationAmount: r.operation_amount,
        operationCurrency: r.operation_currency,
        counterName: r.counter_name,
        hold: !!r.hold,
      })),

    insertRates: (at: number, rates: { currency: number; buy?: number; sell?: number; cross?: number }[]) => {
      for (const r of rates) q.insertRate.run(at, r.currency, r.buy ?? null, r.sell ?? null, r.cross ?? null);
    },
    rateNear: (currency: number, time: number) =>
      q.rateNear.get(currency, time) as unknown as
        | { fetched_at: number; currency: number; rate_buy: number | null; rate_sell: number | null; rate_cross: number | null }
        | undefined,

    listOverrides: () => q.overrides.all() as unknown as OverrideRow[],
    upsertOverride: (o: Omit<OverrideRow, 'updated_at'>) =>
      void q.upsertOverride.run(o.key, o.name, o.service_id, o.period, o.status, o.cancel_url, o.notes, o.remind_days, o.merged_into, now()),
    splitGroups: () => new Set((q.splitGroups.all() as { group_key: string }[]).map(r => r.group_key)),
    setSplit: (groupKey: string, split: boolean) => void (split ? q.addSplit.run(groupKey, now()) : q.removeSplit.run(groupKey)),
  };
};

export type Db = ReturnType<typeof openDb>;
