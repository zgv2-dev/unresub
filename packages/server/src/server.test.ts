import { randomBytes } from 'node:crypto';
import { describe, expect, it, beforeEach } from 'vitest';
import { makeSeries } from '@unresub/core/fixtures';
import { createApp } from './app.ts';
import { decryptSecret, encryptSecret } from './crypto.ts';
import { openDb, type Db } from './db.ts';
import { SyncService } from './sync.ts';
import type { BankSource, SourceTransaction } from './sources/types.ts';

const key = randomBytes(32);
const API = 'test-api-token';
const auth = { Authorization: `Bearer ${API}` };

const seedSource = (db: Db, id = 'mono-1') => {
  db.insertSource({ id, kind: 'monobank', name: 'test', credentials_enc: encryptSecret('{"token":"t"}', key, id), webhook_secret: 'hook-secret' });
  db.upsertAccounts(id, [{ externalId: 'acc', currency: 980, balance: 10_000, creditLimit: 0, maskedPan: '4444****1111', iban: null, type: 'black' }]);
  return id;
};

describe('crypto', () => {
  it('round-trips and binds ciphertext to its row id', () => {
    const enc = encryptSecret('secret-token', key, 'row-1');
    expect(enc).not.toContain('secret-token');
    expect(decryptSecret(enc, key, 'row-1')).toBe('secret-token');
    expect(() => decryptSecret(enc, key, 'row-2')).toThrow();
  });
});

describe('server', () => {
  let db: Db;
  let sync: SyncService;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = openDb(':memory:');
    sync = new SyncService(db, { key, publicUrl: 'https://example.test', backfillMonths: 3, log: () => {} });
    app = createApp(db, sync, API);
  });

  it('rejects API calls without the bearer token', async () => {
    expect((await app.request('/api/subscriptions')).status).toBe(401);
  });

  it('backfills in windows no larger than the source limit and detects subscriptions', async () => {
    const id = seedSource(db);
    const now = Math.floor(Date.now() / 1000);
    const all = makeSeries({ description: 'ANTHROPIC', period: 'monthly', price: 2_000, currency: 840, rate: 41.5, count: 3, last: now - 5 * 86_400 });
    const calls: [number, number][] = [];
    const fake: BankSource = {
      kind: 'monobank',
      maxRangeSeconds: 31 * 86_400,
      listAccounts: async () => [],
      fetchTransactions: async (ext, from, to) => {
        calls.push([from, to]);
        return all.filter(t => t.time >= from && t.time <= to).map(({ accountId: _, ...t }): SourceTransaction => ({ ...t, accountExternalId: ext, raw: null }));
      },
    };
    await sync.syncSource(id, fake);

    expect(calls.every(([f, t]) => t - f <= fake.maxRangeSeconds)).toBe(true);
    expect(Math.min(...calls.map(c => c[0]))).toBeLessThanOrEqual(now - 90 * 86_400);
    expect(sync.status(id)).toMatchObject({ running: false, lastError: null });

    const res = await app.request('/api/subscriptions', { headers: auth });
    const body = (await res.json()) as any;
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ serviceId: 'anthropic', price: 2_000, localPrice: 83_000, annual: 24_000, annualLocal: 996_000 });
  });

  it('accepts monobank webhooks only with the right secret', async () => {
    const id = seedSource(db);
    const payload = {
      type: 'StatementItem',
      data: { account: 'acc', statementItem: { id: 'tx1', time: 1_790_000_000, description: 'DISCORD* NITRO', mcc: 5815, originalMcc: 5815, hold: true, amount: -41_000, operationAmount: -999, currencyCode: 840, commissionRate: 0, cashbackAmount: 0, balance: 5_000 } },
    };
    const post = (secret: string) => app.request(`/hooks/${id}/${secret}`, { method: 'POST', body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json' } });

    expect((await post('wrong')).status).toBe(404);
    expect(db.listTransactions()).toHaveLength(0);

    expect((await app.request(`/hooks/${id}/hook-secret`)).status).toBe(200); // monobank's GET check
    expect((await post('hook-secret')).status).toBe(200);
    expect(db.listTransactions()).toMatchObject([{ id: 'monobank:tx1', operationAmount: -999, operationCurrency: 840 }]);
    expect(db.listAccounts()[0]!.balance).toBe(5_000);
  });

  it('keeps user overrides across re-detection', async () => {
    const id = seedSource(db);
    const now = Math.floor(Date.now() / 1000);
    const series = makeSeries({ description: 'Hetzner Online 77812', period: 'monthly', price: 450, currency: 978, rate: 48, count: 4, last: now - 86_400 });
    db.insertTransactions(`${id}:acc`, series.map(({ accountId: _, ...t }) => ({ ...t, accountExternalId: 'acc', raw: null })));

    let body = (await (await app.request('/api/subscriptions', { headers: auth })).json()) as any;
    expect(body.items[0].needsDetails).toBe(true);

    const res = await app.request(`/api/subscriptions/${encodeURIComponent(body.items[0].key)}`, {
      method: 'PATCH',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Hetzner VPS', cancelUrl: 'https://console.hetzner.cloud' }),
    });
    expect(res.status).toBe(204);

    body = (await (await app.request('/api/subscriptions', { headers: auth })).json()) as any;
    expect(body.items[0]).toMatchObject({ name: 'Hetzner VPS', needsDetails: false, cancelUrl: 'https://console.hetzner.cloud' });
  });
});
