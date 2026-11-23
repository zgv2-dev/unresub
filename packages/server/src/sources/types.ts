import type { CurrencyCode, Transaction } from '@unresub/core';

export type SourceKind = 'monobank' | 'pumb' | 'sense';

export interface SourceAccount {
  externalId: string;
  currency: CurrencyCode;
  /** Minor units */
  balance: number;
  creditLimit: number;
  maskedPan: string | null;
  iban: string | null;
  /** Bank-specific card type, e.g. monobank 'black', 'white', 'iron', 'fop' */
  type: string | null;
}

/** Transaction as fetched, before the server assigns its internal account id. */
export type SourceTransaction = Omit<Transaction, 'accountId'> & { accountExternalId: string; raw: unknown };

export interface WebhookEvent {
  accountExternalId: string;
  transaction: SourceTransaction;
}

/**
 * Every bank integration implements this. Detection, storage and UI only
 * see the bank-agnostic shapes, so PUMB / Sense plug in as new adapters.
 */
export interface BankSource {
  readonly kind: SourceKind;
  /** Longest window one `fetchTransactions` call may cover. */
  readonly maxRangeSeconds: number;
  /** Minimum spacing between requests imposed by the bank, if any. */
  readonly minRequestGapMs?: number;
  /** Epoch ms when the next request may go out, for progress display. */
  nextRequestAt?(): number;
  listAccounts(): Promise<SourceAccount[]>;
  fetchTransactions(accountExternalId: string, from: number, to: number): Promise<SourceTransaction[]>;
  registerWebhook?(url: string): Promise<void>;
  parseWebhook?(body: unknown): WebhookEvent | null;
}
