import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { addPeriod } from '@unresub/core';
import { describe, expect, it, beforeEach } from 'vitest';
import { makeSeries } from '@unresub/core/fixtures';
import { createApp } from './app.ts';
import { Sessions } from './auth.ts';
import { openCoreDb, type CoreDb } from './core-db.ts';
import { decryptSecret, encryptSecret, randomToken, sha256 } from './crypto.ts';
import { openDb, type Db } from './db.ts';
import { SyncService } from './sync.ts';
import { Tenants } from './tenants.ts';
import { WebAuthn } from './webauthn.ts';
import type { BankSource, SourceTransaction } from './sources/types.ts';

const key = randomBytes(32);
const auth: Record<string, string> = {};
let core: CoreDb;
let tenants: Tenants;

/** A user with a ready bearer session, skipping the (deliberately slow) password hash. */
const makeUser = (username: string, isAdmin = false) => {
  const user = tenants.createUser(username, '', isAdmin);
  core.insertPasskey({ id: `pk-${username}`, user_id: user.id, public_key: 'x', counter: 0, transports: null, device_type: null, backed_up: 0, name: 'test' });
  const token = randomToken();
  core.insertSession({ id_hash: sha256(token), user_id: user.id, csrf: 'csrf', user_agent: null, expires_at: Math.floor(Date.now() / 1000) + 3_600 });
  return { user, headers: { Authorization: `Bearer ${token}` }, ...tenants.get(user.id) };
};

const seedSource = (db: Db, id = 'mono-1') => {
  const owner = core.listUsers().find(u => tenants.get(u.id).db === db)!;
  core.addRoute(id, owner.id);
  db.insertSource({ id, kind: 'monobank', name: 'test', credentials_enc: encryptSecret('{"token":"t"}', tenants.dataKey(owner), id), webhook_secret: 'hook-secret' });
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
    core = openCoreDb(':memory:');
    tenants = new Tenants(core, key, { dataDir: null, publicUrl: 'https://example.test', backfillMonths: 3, log: () => {} });
    app = createApp({ core, tenants, sessions: new Sessions(core, 30), setupCodes: ['setup-code'], legacy: null, log: () => {}, webauthn: new WebAuthn({ publicUrl: null, androidCertFingerprints: [] }) });
    const me = makeUser('alice', true);
    ({ db, sync } = me);
    auth.Authorization = me.headers.Authorization;
  });

  it('rejects API calls without a session', async () => {
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

  it('reports reminders, low balance on the subs card and subs left on the main card', async () => {
    const id = seedSource(db);
    db.upsertAccounts(id, [{ externalId: 'usd', currency: 840, balance: 1_500, creditLimit: 0, maskedPan: '4444****2222', iban: null, type: 'black' }]);
    db.setSubscriptionCard(`${id}:usd`, true);
    const now = Math.floor(Date.now() / 1000);
    const toSrc = (ext: string) => ({ accountId: _, ...t }: ReturnType<typeof makeSeries>[number]) => ({ ...t, accountExternalId: ext, raw: null });
    // Due tomorrow on the USD subs card, more than its balance.
    const claude = makeSeries({ description: 'ANTHROPIC', period: 'monthly', price: 2_000, currency: 840, count: 3, last: addPeriod(now + 20 * 3_600, 'monthly', -1) }, `${id}:usd`)
      .map(t => ({ ...t, accountCurrency: 840, amount: t.operationAmount }));
    db.insertTransactions(`${id}:usd`, claude.map(toSrc('usd')));
    // Still billed from the UAH main card.
    db.insertTransactions(`${id}:acc`, makeSeries({ description: 'NETFLIX.COM', period: 'monthly', price: 999, currency: 840, rate: 41, count: 3, last: now - 10 * 86_400 }).map(toSrc('acc')));

    core.insertRates(now - 40 * 86_400, [{ currency: 840, buy: 40, sell: 40.5 }]);
    core.insertRates(now - 2 * 86_400, [{ currency: 840, buy: 41, sell: 41.5 }]);

    const body = (await (await app.request('/api/subscriptions', { headers: auth })).json()) as any;
    // USD charge on the USD card: UAH value from the snapshot closest to the charge (~29 days ago → 40.5).
    expect(body.items.find((i: any) => i.serviceId === 'anthropic')).toMatchObject({ localPrice: 81_000, rate: 40.5 });
    const byType = (t: string) => body.alerts.filter((a: any) => a.type === t).map((a: any) => a.name);
    expect(byType('upcoming_charge')).toEqual(['Anthropic (Claude)']);
    expect(body.alerts).toContainEqual(expect.objectContaining({ type: 'low_balance', name: 'Anthropic (Claude)', shortfall: 500, currency: 840 }));
    expect(byType('on_main_card')).toEqual(['Netflix']);
  });

  it('reports per-card progress and resumes an interrupted backfill', async () => {
    const id = seedSource(db);
    const calls: [number, number][] = [];
    let failAfter = 2;
    const flaky: BankSource = {
      kind: 'monobank',
      maxRangeSeconds: 31 * 86_400,
      minRequestGapMs: 61_000,
      listAccounts: async () => [],
      fetchTransactions: async (_ext, from, to) => {
        if (failAfter-- <= 0) throw new Error('process killed');
        calls.push([from, to]);
        return [];
      },
    };
    await sync.syncSource(id, flaky);
    expect(sync.status(id)).toMatchObject({ running: false, lastError: 'process killed', done: 2 });

    let sources = (await (await app.request('/api/sources', { headers: auth })).json()) as any;
    const partial = sources[0].progress[0];
    expect(partial).toMatchObject({ state: 'error', monthsTotal: 3 });
    expect(partial.monthsDone).toBeGreaterThan(1.5);
    expect(partial.monthsDone).toBeLessThan(3);

    // "Restart": a fresh run picks up from the saved point instead of starting over.
    const before = calls.length;
    failAfter = Infinity;
    await sync.syncSource(id, flaky);
    const resumed = calls.slice(before);
    expect(Math.max(...resumed.map(c => c[1]))).toBeLessThanOrEqual(Math.min(...calls.slice(0, before).map(c => c[0])) + 3_600 * 24 * 2);
    sources = (await (await app.request('/api/sources', { headers: auth })).json()) as any;
    expect(sources[0].progress[0]).toMatchObject({ state: 'done', monthsDone: 3 });
  });

  it('shows the rate-limit wait and an ETA while running', async () => {
    const id = seedSource(db);
    let release!: () => void;
    const slow: BankSource = {
      kind: 'monobank',
      maxRangeSeconds: 31 * 86_400,
      minRequestGapMs: 61_000,
      nextRequestAt: () => Date.now() + 30_000,
      listAccounts: async () => [],
      fetchTransactions: () => new Promise(r => (release = () => r([]))),
    };
    const run = sync.syncSource(id, slow);
    await new Promise(r => setTimeout(r, 0));
    const st = sync.status(id);
    expect(st).toMatchObject({ running: true, state: 'waiting_rate_limit', currentAccountId: `${id}:acc`, done: 0 });
    expect(st.total).toBeGreaterThanOrEqual(3);
    expect(st.etaSeconds).toBeGreaterThanOrEqual(30 + (st.total - 1) * 61);
    const sources = (await (await app.request('/api/sources', { headers: auth })).json()) as any;
    expect(sources[0].progress[0].state).toBe('syncing');
    for (let i = 0; i < st.total; i++) {
      release();
      await new Promise(r => setTimeout(r, 0));
    }
    await run;
  });

  describe('corrections', () => {
    const subsOf = async () => ((await (await app.request('/api/subscriptions', { headers: auth })).json()) as any);
    const patch = (key: string, body: object) =>
      app.request(`/api/subscriptions/${encodeURIComponent(key)}`, { method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const insert = (id: string, series: ReturnType<typeof makeSeries>) =>
      db.insertTransactions(`${id}:acc`, series.map(({ accountId: _, ...t }) => ({ ...t, accountExternalId: 'acc', raw: null })));
    const now = Math.floor(Date.now() / 1000);

    it('keeps a hidden subscription hidden when new charges arrive', async () => {
      const id = seedSource(db);
      insert(id, makeSeries({ description: 'Gym Sport Life', period: 'monthly', price: 90_000, currency: 980, count: 3, last: addPeriod(now - 3 * 86_400, 'monthly', -1) }));
      const [gym] = (await subsOf()).items;
      expect((await patch(gym.key, { status: 'ignored' })).status).toBe(204);
      insert(id, makeSeries({ description: 'Gym Sport Life', period: 'monthly', price: 90_000, currency: 980, count: 1, last: now - 3 * 86_400 }));
      const body = await subsOf();
      expect(body.items).toMatchObject([{ key: gym.key, userStatus: 'ignored', chargeCount: 4 }]);
      expect(body.totals.count).toBe(0);
      expect(body.alerts).toEqual([]);
    });

    it('merges and unmerges two series', async () => {
      const id = seedSource(db);
      insert(id, makeSeries({ description: 'SERVICE OLD NAME', period: 'monthly', price: 500, currency: 840, rate: 41, count: 3, last: now - 70 * 86_400 }));
      insert(id, makeSeries({ description: 'SERVICE NEW', period: 'monthly', price: 600, currency: 840, rate: 41, count: 2, last: now - 10 * 86_400 }));
      const items = (await subsOf()).items as any[];
      expect(items).toHaveLength(2);
      const oldOne = items.find(i => i.price === 500);
      const newOne = items.find(i => i.price === 600);
      expect((await patch(oldOne.key, { mergedInto: oldOne.key })).status).toBe(400);
      await patch(oldOne.key, { mergedInto: newOne.key });
      let body = await subsOf();
      expect(body.items).toMatchObject([{ key: newOne.key, chargeCount: 5, merged: [{ key: oldOne.key }] }]);
      await patch(oldOne.key, { mergedInto: null });
      body = await subsOf();
      expect(body.items).toHaveLength(2);
    });

    it('splits a merchant by price and undoes it', async () => {
      const id = seedSource(db);
      insert(id, makeSeries({ description: 'PADDLE.NET', period: 'monthly', price: 500, currency: 840, rate: 41, count: 3, last: now - 5 * 86_400 }));
      insert(id, makeSeries({ description: 'PADDLE.NET', period: 'monthly', price: 550, currency: 840, rate: 41, count: 3, last: now - 5 * 86_400 }));
      let items = (await subsOf()).items as any[];
      expect(items).toMatchObject([{ canSplit: true, isSplit: false }]);
      const put = await app.request(`/api/split-groups/${encodeURIComponent(items[0].groupKey)}`, { method: 'PUT', headers: auth });
      expect(put.status).toBe(204);
      items = (await subsOf()).items;
      expect(items.map(i => i.price).sort()).toEqual([500, 550]);
      expect(items.every(i => i.isSplit && !i.canSplit)).toBe(true);
      await app.request(`/api/split-groups/${encodeURIComponent(items[0].groupKey)}`, { method: 'DELETE', headers: auth });
      expect((await subsOf()).items).toHaveLength(1);
    });

    it('corrects the period and recomputes the next charge', async () => {
      const id = seedSource(db);
      insert(id, makeSeries({ description: 'ANTHROPIC', period: 'monthly', price: 2_000, currency: 840, rate: 41, count: 3, last: now - 5 * 86_400 }));
      const [s] = (await subsOf()).items;
      await patch(s.key, { period: 'annual' });
      const [after] = (await subsOf()).items;
      expect(after).toMatchObject({ period: 'annual', periodCorrected: true, nextChargeAt: addPeriod(s.lastChargeAt, 'annual'), annual: 2_000 });
    });

    it('migrates an old database without the merged_into column', () => {
      const path = `${process.env.TMPDIR ?? '/tmp'}/unresub-migrate-${Date.now()}.db`;
      const old = new DatabaseSync(path);
      old.exec('CREATE TABLE subscription_overrides (key TEXT PRIMARY KEY, name TEXT, service_id TEXT, period TEXT, status TEXT, cancel_url TEXT, notes TEXT, remind_days INTEGER, updated_at INTEGER NOT NULL)');
      old.exec("INSERT INTO subscription_overrides (key, status, updated_at) VALUES ('k', 'ignored', 1)");
      old.close();
      const migrated = openDb(path);
      expect(migrated.listOverrides()).toMatchObject([{ key: 'k', status: 'ignored', merged_into: null }]);
      migrated.close();
    });
  });

  describe('transactions and manual subscriptions', () => {
    const now = Math.floor(Date.now() / 1000);
    const get = async (path: string) => (await (await app.request(path, { headers: auth })).json()) as any;
    const post = (path: string, body: object) =>
      app.request(path, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const insert = (id: string, series: ReturnType<typeof makeSeries>) =>
      db.insertTransactions(`${id}:acc`, series.map(({ accountId: _, ...t }) => ({ ...t, accountExternalId: 'acc', raw: null })));

    it('lists with filters and marks which subscription a charge belongs to', async () => {
      const id = seedSource(db);
      insert(id, makeSeries({ description: 'ANTHROPIC', period: 'monthly', price: 2_000, currency: 840, rate: 41, count: 3, last: now - 5 * 86_400 }));
      insert(id, makeSeries({ description: 'Silpo', period: 'weekly', price: 50_000, currency: 980, count: 1, last: now - 86_400, mcc: 5411 }));
      let body = await get('/api/transactions?debit=1');
      expect(body.total).toBe(4);
      expect(body.items[0]).toMatchObject({ description: 'Silpo', subscriptionKey: null });
      expect(body.items[1]).toMatchObject({ description: 'ANTHROPIC', subscriptionName: 'Anthropic (Claude)', hidden: false });
      body = await get('/api/transactions?q=silp');
      expect(body.items.map((t: any) => t.description)).toEqual(['Silpo']);
      body = await get('/api/transactions?unassigned=1&min=40000');
      expect(body.items.map((t: any) => t.description)).toEqual(['Silpo']);
    });

    it('creates a subscription from one transaction that picks up future charges', async () => {
      const id = seedSource(db);
      const first = makeSeries({ description: 'SPORTLIFE 0042', period: 'monthly', price: 90_000, currency: 980, count: 1, last: now - 10 * 86_400, mcc: 7997 });
      const older = makeSeries({ description: 'SPORTLIFE 0042', period: 'monthly', price: 90_000, currency: 980, count: 1, last: now - 80 * 86_400, mcc: 7997 }); // skipped month: too irregular to detect
      insert(id, [...first, ...older]);
      expect((await get('/api/subscriptions')).items).toHaveLength(0);

      const similar = await get(`/api/transactions/${encodeURIComponent(first[0]!.id)}/similar`);
      expect(similar.items).toMatchObject([{ id: older[0]!.id, sameAmount: true }]);
      expect(similar.suggested.name).toBe('SPORTLIFE');

      const res = await post('/api/manual-subscriptions', { transactionId: first[0]!.id, name: 'Gym', period: 'monthly', attachIds: [older[0]!.id] });
      expect(res.status).toBe(201);
      const { key } = (await res.json()) as any;
      let subs = (await get('/api/subscriptions')).items;
      expect(subs).toMatchObject([{ key, name: 'Gym', manual: true, chargeCount: 2, price: 90_000 }]);

      // A new charge from the same gym lands in it automatically.
      insert(id, makeSeries({ description: 'SPORTLIFE 0077', period: 'monthly', price: 90_000, currency: 980, count: 1, last: now - 86_400, mcc: 7997 }));
      subs = (await get('/api/subscriptions')).items;
      expect(subs).toMatchObject([{ key, chargeCount: 3 }]);
      const txns = await get('/api/transactions');
      expect(txns.items.every((t: any) => t.subscriptionKey === key)).toBe(true);

      await app.request(`/api/manual-subscriptions/${encodeURIComponent(key)}`, { method: 'DELETE', headers: auth });
      expect((await get('/api/subscriptions')).items.some((i: any) => i.key === key)).toBe(false);
    });
  });

  describe('card switch', () => {
    const now = Math.floor(Date.now() / 1000);
    const get = async (path: string) => (await (await app.request(path, { headers: auth })).json()) as any;
    const patch = (key: string, body: object) =>
      app.request(`/api/subscriptions/${encodeURIComponent(key)}`, { method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const setup = () => {
      const id = seedSource(db);
      db.upsertAccounts(id, [{ externalId: 'usd', currency: 840, balance: 100_000, creditLimit: 0, maskedPan: '4444****2222', iban: null, type: 'black' }]);
      db.setSubscriptionCard(`${id}:usd`, true);
      core.insertRates(now - 400 * 86_400, [{ currency: 840, buy: 41, sell: 41.5 }]); // rates are shared across users
      return id;
    };
    const put = (id: string, ext: string, series: ReturnType<typeof makeSeries>, usdCard = false) =>
      db.insertTransactions(`${id}:${ext}`, series.map(({ accountId: _, ...t }) => ({
        ...t, accountExternalId: ext, raw: null, ...(usdCard && { accountCurrency: 840, amount: t.operationAmount }),
      })));

    it('keeps Anthropic as one subscription after it moves to the USD card', async () => {
      const id = setup();
      const switchAt = now - 6 * 86_400;
      put(id, 'acc', makeSeries({ description: 'ANTHROPIC', period: 'monthly', price: 2_000, currency: 840, rate: 41, count: 4, last: addPeriod(switchAt, 'monthly', -1) }));
      const [before] = (await get('/api/subscriptions')).items;
      expect(before).toMatchObject({ onMainCard: true });
      await patch(before.key, { notes: 'team plan' });

      put(id, 'usd', makeSeries({ description: 'ANTHROPIC', period: 'monthly', price: 2_000, currency: 840, count: 1, last: switchAt }), true);
      const body = await get('/api/subscriptions');
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({
        key: before.key, chargeCount: 5, status: 'active', onMainCard: false, notes: 'team plan',
        account: { id: `${id}:usd` }, movedFrom: { id: `${id}:acc` },
      });
      expect(body.alerts.filter((a: any) => a.type === 'on_main_card')).toEqual([]);
    });

    it('links a merchant that changed charge currency with the card and keeps corrections', async () => {
      const id = setup();
      const switchAt = now - 70 * 86_400;
      put(id, 'acc', makeSeries({ description: 'ACME CLOUD', period: 'monthly', price: 83_000, currency: 980, count: 4, last: addPeriod(switchAt, 'monthly', -1), mcc: 7372 }));
      const [old] = (await get('/api/subscriptions')).items;
      await patch(old.key, { name: 'Acme hosting' });

      // First charge on the USD card: the old series continues.
      put(id, 'usd', makeSeries({ description: 'ACME CLOUD', period: 'monthly', price: 2_000, currency: 840, count: 1, last: switchAt, mcc: 7372 }), true);
      let items = (await get('/api/subscriptions')).items;
      expect(items).toMatchObject([{ key: old.key, name: 'Acme hosting', currency: 840, chargeCount: 5 }]);

      // Two more: the USD card has its own series now; the old one is folded in and the name carries over.
      put(id, 'usd', makeSeries({ description: 'ACME CLOUD', period: 'monthly', price: 2_000, currency: 840, count: 2, last: addPeriod(switchAt, 'monthly', 2), mcc: 7372 }), true);
      items = (await get('/api/subscriptions')).items;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ name: 'Acme hosting', currency: 840, chargeCount: 7, autoLinked: [old.key], movedFrom: { id: `${id}:acc` } });

      // "Separate" sticks: no automatic re-linking.
      await patch(old.key, { mergedInto: null });
      expect((await get('/api/subscriptions')).items).toHaveLength(2);
    });
  });

  describe('subscription history', () => {
    const now = Math.floor(Date.now() / 1000);
    const get = async (path: string) => (await (await app.request(path, { headers: auth })).json()) as any;
    const post = (path: string, body: object) =>
      app.request(path, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    it('lists charges newest first with UAH, price changes, card moves and a total; unlink sends one back', async () => {
      const id = seedSource(db);
      db.upsertAccounts(id, [{ externalId: 'usd', currency: 840, balance: 0, creditLimit: 0, maskedPan: '4444****2222', iban: null, type: 'black' }]);
      core.insertRates(now - 400 * 86_400, [{ currency: 840, buy: 41, sell: 42 }]);
      const old = makeSeries({ description: 'ANTHROPIC', period: 'monthly', price: 2_000, currency: 840, rate: 41, count: 3, last: addPeriod(now - 5 * 86_400, 'monthly', -1) });
      const latest = makeSeries({ description: 'ANTHROPIC', period: 'monthly', price: 2_200, currency: 840, count: 1, last: now - 5 * 86_400 });
      db.insertTransactions(`${id}:acc`, old.map(({ accountId: _, ...t }) => ({ ...t, accountExternalId: 'acc', raw: null })));
      db.insertTransactions(`${id}:usd`, latest.map(({ accountId: _, ...t }) => ({ ...t, accountExternalId: 'usd', accountCurrency: 840, amount: t.operationAmount, raw: null })));
      const [sub] = (await get('/api/subscriptions')).items;

      const h = await get(`/api/subscriptions/${encodeURIComponent(sub.key)}/transactions`);
      expect(h.count).toBe(4);
      expect(h.items[0]).toMatchObject({ price: 2_200, local: 92_400, rate: 42, movedFrom: { id: `${id}:acc` }, priceChange: { from: 2_000, delta: 200, pct: 10 }, card: { id: `${id}:usd` } });
      expect(h.items[1]).toMatchObject({ price: 2_000, local: 82_000, movedFrom: null, priceChange: null });
      expect(h.totalLocal).toBe(92_400 + 3 * 82_000);
      expect(h.totalByCurrency).toEqual({ 840: 8_200 });

      const wrong = h.items[1].id; // a charge in the middle: the series must survive the gap
      expect((await post(`/api/subscriptions/${encodeURIComponent(sub.key)}/unlink`, { transactionId: 'nope' })).status).toBe(404);
      expect((await post(`/api/subscriptions/${encodeURIComponent(sub.key)}/unlink`, { transactionId: wrong })).status).toBe(204);
      expect((await get(`/api/subscriptions/${encodeURIComponent(sub.key)}/transactions`)).count).toBe(3);
      const row = (await get('/api/transactions')).items.find((t: any) => t.id === wrong);
      expect(row).toMatchObject({ subscriptionKey: null, excluded: true });

      await app.request(`/api/excluded-transactions/${encodeURIComponent(wrong)}`, { method: 'DELETE', headers: auth });
      expect((await get(`/api/subscriptions/${encodeURIComponent(sub.key)}/transactions`)).count).toBe(4);
    });
  });
});
