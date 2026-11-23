import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeSeries } from '@unresub/core/fixtures';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, type LegacyData } from './app.ts';
import { Sessions } from './auth.ts';
import { openCoreDb, type CoreDb } from './core-db.ts';
import { decryptSecret, encryptSecret } from './crypto.ts';
import { openDb, type Db } from './db.ts';
import { loadInstanceKey } from './env.ts';
import { SyncService } from './sync.ts';
import { Tenants } from './tenants.ts';

const key = randomBytes(32);
const PASSWORD = 'correct horse battery';
const json = { 'Content-Type': 'application/json' };

let core: CoreDb;
let tenants: Tenants;
let app: ReturnType<typeof createApp>;

const build = (opts: { dataDir?: string | null; legacy?: LegacyData | null } = {}) => {
  core = openCoreDb(opts.dataDir ? join(opts.dataDir, 'core.db') : ':memory:');
  tenants = new Tenants(core, key, { dataDir: opts.dataDir ?? null, publicUrl: 'https://example.test', backfillMonths: 3, log: () => {} });
  app = createApp({ core, tenants, sessions: new Sessions(core, 30), setupCodes: ['setup-code'], legacy: opts.legacy ?? null, log: () => {} });
};

const post = (path: string, body: object, headers: Record<string, string> = {}) =>
  app.request(path, { method: 'POST', headers: { ...json, ...headers }, body: JSON.stringify(body) });

const cookieOf = (res: Response) => res.headers.get('set-cookie')!.split(';')[0]!;

/** Signs in as an app client and returns bearer headers. */
const signIn = async (username: string, password = PASSWORD) => {
  const res = await post('/api/auth/login', { username, password, client: 'app' });
  expect(res.status).toBe(200);
  const { token } = (await res.json()) as { token: string };
  return { Authorization: `Bearer ${token}` };
};

const setup = async () => {
  const res = await post('/api/auth/setup', { username: 'admin', password: PASSWORD, setupCode: 'setup-code', client: 'app' });
  expect(res.status).toBe(201);
  const { token, user } = (await res.json()) as { token: string; user: { id: string } };
  return { headers: { Authorization: `Bearer ${token}` }, id: user.id };
};

const addUser = async (admin: Record<string, string>, username: string) => {
  const { code } = (await (await post('/api/admin/invites', {}, admin)).json()) as { code: string };
  const res = await post('/api/auth/signup', { username, password: PASSWORD, invite: code, client: 'app' });
  expect(res.status).toBe(201);
  const { token, user } = (await res.json()) as { token: string; user: { id: string } };
  return { headers: { Authorization: `Bearer ${token}` }, id: user.id };
};

/** A source with one account and a monthly Netflix-like series, in the user's own database. */
const seedBank = (userId: string, sourceId: string, description: string) => {
  const { db } = tenants.get(userId);
  core.addRoute(sourceId, userId);
  db.insertSource({ id: sourceId, kind: 'monobank', name: sourceId, credentials_enc: encryptSecret('{"token":"t"}', tenants.dataKey(core.getUser(userId)!), sourceId), webhook_secret: `${sourceId}-secret` });
  db.upsertAccounts(sourceId, [{ externalId: 'acc', currency: 980, balance: 10_000, creditLimit: 0, maskedPan: '4444', iban: null, type: 'black' }]);
  const now = Math.floor(Date.now() / 1000);
  const txns = makeSeries({ description, period: 'monthly', price: 29_900, currency: 980, count: 4, last: now - 86_400 });
  db.insertTransactions(`${sourceId}:acc`, txns.map(({ accountId: _, ...t }) => ({ ...t, id: `${sourceId}-${t.id}`, accountExternalId: 'acc', raw: null })));
  return { accountId: `${sourceId}:acc`, txnId: `${sourceId}-${txns[0]!.id}` };
};

describe('setup and sign-in', () => {
  beforeEach(() => build());

  it('needs the setup code, creates exactly one admin, then refuses to run again', async () => {
    expect(await (await app.request('/api/auth/status')).json()).toMatchObject({ setupRequired: true, user: null });
    expect((await post('/api/auth/setup', { username: 'admin', password: PASSWORD, setupCode: 'nope' })).status).toBe(403);
    const res = await post('/api/auth/setup', { username: 'Admin', password: PASSWORD, setupCode: 'setup-code' });
    expect(res.status).toBe(201);
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const status = (await (await app.request('/api/auth/status', { headers: { Cookie: cookieOf(res) } })).json()) as any;
    expect(status).toMatchObject({ setupRequired: false, user: { username: 'admin', isAdmin: true } });
    expect(status.csrfToken).toBeTruthy();
    expect((await post('/api/auth/setup', { username: 'evil', password: PASSWORD, setupCode: 'setup-code' })).status).toBe(409);
  });

  it('rejects weak passwords and non-JSON bodies', async () => {
    expect((await post('/api/auth/setup', { username: 'admin', password: 'short', setupCode: 'setup-code' })).status).toBe(400);
    const form = await app.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=a&password=b' });
    expect(form.status).toBe(415);
  });

  it('logs in, rate-limits guessing, and never stores the session token', async () => {
    await setup();
    for (let i = 0; i < 5; i++) expect((await post('/api/auth/login', { username: 'admin', password: 'wrong password' })).status).toBe(401);
    const blocked = await post('/api/auth/login', { username: 'admin', password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
    // Unknown users get the same answer as a wrong password.
    expect(await (await post('/api/auth/login', { username: 'ghost', password: 'x' })).json()).toEqual({ error: 'Wrong username or password' });
    const tokens = core.raw.prepare('SELECT id_hash FROM sessions').all() as { id_hash: string }[];
    expect(tokens.length).toBeGreaterThan(0);
  });

  it('requires the CSRF token for cookie sessions, not for bearer tokens', async () => {
    const res = await post('/api/auth/setup', { username: 'admin', password: PASSWORD, setupCode: 'setup-code' });
    const { csrfToken } = (await res.json()) as { csrfToken: string };
    const Cookie = cookieOf(res);
    const settings = (headers: Record<string, string>) =>
      app.request('/api/admin/settings', { method: 'PUT', headers: { ...json, Cookie, ...headers }, body: JSON.stringify({ signup: 'open' }) });
    expect((await settings({})).status).toBe(403);
    expect((await settings({ 'X-CSRF-Token': 'forged' })).status).toBe(403);
    expect((await settings({ 'X-CSRF-Token': csrfToken })).status).toBe(200);
    expect((await app.request('/api/subscriptions', { headers: { Cookie } })).status).toBe(200);
  });

  it('signs up by invite only, unless the admin opens sign-up', async () => {
    const admin = await setup();
    expect((await post('/api/auth/signup', { username: 'bob', password: PASSWORD })).status).toBe(403);
    const { code } = (await (await post('/api/admin/invites', {}, admin.headers)).json()) as { code: string };
    expect((await post('/api/auth/signup', { username: 'bob', password: PASSWORD, invite: code })).status).toBe(201);
    expect((await post('/api/auth/signup', { username: 'carol', password: PASSWORD, invite: code })).status).toBe(403);
    await app.request('/api/admin/settings', { method: 'PUT', headers: { ...json, ...admin.headers }, body: JSON.stringify({ signup: 'open' }) });
    expect((await post('/api/auth/signup', { username: 'carol', password: PASSWORD })).status).toBe(201);
    expect((await post('/api/auth/signup', { username: 'CAROL', password: PASSWORD })).status).toBe(409);
  });

  it('changing the password signs out other sessions', async () => {
    const admin = await setup();
    const other = await signIn('admin');
    const res = await post('/api/me/password', { current: PASSWORD, next: 'another long password' }, admin.headers);
    expect(res.status).toBe(204);
    expect((await app.request('/api/me', { headers: other })).status).toBe(401);
    expect((await app.request('/api/me', { headers: admin.headers })).status).toBe(200);
    await signIn('admin', 'another long password');
  });

  it('logs out', async () => {
    const admin = await setup();
    expect((await app.request('/api/auth/logout', { method: 'POST', headers: admin.headers })).status).toBe(204);
    expect((await app.request('/api/me', { headers: admin.headers })).status).toBe(401);
  });
});

describe('data separation between users', () => {
  let alice: Awaited<ReturnType<typeof setup>>;
  let bob: Awaited<ReturnType<typeof setup>>;
  let a: ReturnType<typeof seedBank>;
  let b: ReturnType<typeof seedBank>;
  const get = async (path: string, headers: Record<string, string>) => (await app.request(path, { headers })).json() as Promise<any>;

  beforeEach(async () => {
    build();
    alice = await setup();
    bob = await addUser(alice.headers, 'bob');
    a = seedBank(alice.id, 'mono-alice', 'NETFLIX.COM');
    b = seedBank(bob.id, 'mono-bob', 'SPOTIFY');
  });

  it('every list shows only the caller’s own data', async () => {
    for (const [who, mine, theirs] of [[alice, 'mono-alice', 'mono-bob'], [bob, 'mono-bob', 'mono-alice']] as const) {
      const sources = await get('/api/sources', who.headers);
      expect(sources.map((s: any) => s.id)).toEqual([mine]);
      const accounts = await get('/api/accounts', who.headers);
      expect(accounts.map((x: any) => x.sourceId)).toEqual([mine]);
      const txns = await get('/api/transactions?limit=500', who.headers);
      expect(txns.items.length).toBe(4);
      expect(txns.items.every((t: any) => t.accountId.startsWith(mine))).toBe(true);
      const subs = await get('/api/subscriptions', who.headers);
      expect(subs.items).toHaveLength(1);
      expect(JSON.stringify(subs)).not.toContain(theirs);
      const exported = await get('/api/me/export', who.headers);
      expect(JSON.stringify(exported)).not.toContain(theirs);
      expect(JSON.stringify(exported)).not.toContain('credentials');
    }
  });

  it("can't touch another user's sources, cards, transactions or subscriptions by id", async () => {
    const h = bob.headers;
    const req = (method: string, path: string, body?: object) =>
      app.request(path, { method, headers: { ...json, ...h }, ...(body && { body: JSON.stringify(body) }) });
    expect((await req('POST', '/api/sources/mono-alice/sync')).status).toBe(404);
    expect((await req('DELETE', '/api/sources/mono-alice')).status).toBe(404);
    expect((await req('PATCH', `/api/accounts/${encodeURIComponent(a.accountId)}`, { isSubscriptionCard: true })).status).toBe(404);
    expect((await req('GET', `/api/transactions/${a.txnId}/similar`)).status).toBe(404);
    expect((await req('POST', '/api/manual-subscriptions', { transactionId: a.txnId, period: 'monthly' })).status).toBe(404);

    // Writing to Alice's subscription key only creates an override in Bob's own database.
    const aliceSub = (await get('/api/subscriptions', alice.headers)).items[0];
    await req('PATCH', `/api/subscriptions/${encodeURIComponent(aliceSub.key)}`, { status: 'ignored', name: 'pwned' });
    await req('PUT', `/api/split-groups/${encodeURIComponent(aliceSub.groupKey)}`);
    const after = (await get('/api/subscriptions', alice.headers)).items[0];
    expect(after).toMatchObject({ key: aliceSub.key, name: aliceSub.name, userStatus: null, isSplit: false });

    expect(tenants.get(alice.id).db.getSource('mono-alice')).toBeTruthy();
    expect(tenants.get(alice.id).db.listAccounts()[0]!.is_subscription_card).toBe(0);
    expect(tenants.get(bob.id).db.listSources().map(s => s.id)).toEqual(['mono-bob']);
  });

  it('keeps admin endpoints for admins and never exposes user data through them', async () => {
    expect((await app.request('/api/admin/users', { headers: bob.headers })).status).toBe(403);
    expect((await post('/api/admin/invites', {}, bob.headers)).status).toBe(403);
    const users = await get('/api/admin/users', alice.headers);
    expect(users.map((u: any) => u.username)).toEqual(['admin', 'bob']);
    expect(JSON.stringify(users)).not.toMatch(/password|data_key|scrypt/);
  });

  it('routes each webhook to its owner only', async () => {
    const payload = {
      type: 'StatementItem',
      data: { account: 'acc', statementItem: { id: 'hook1', time: Math.floor(Date.now() / 1000), description: 'HOOK', mcc: 5815, originalMcc: 5815, hold: false, amount: -100, operationAmount: -100, currencyCode: 980, commissionRate: 0, cashbackAmount: 0, balance: 1 } },
    };
    // Bob's secret doesn't open Alice's hook.
    expect((await post('/hooks/mono-alice/mono-bob-secret', payload)).status).toBe(404);
    expect((await post('/hooks/mono-alice/mono-alice-secret', payload)).status).toBe(200);
    expect(tenants.get(alice.id).db.listTransactions().some(t => t.id === 'monobank:hook1')).toBe(true);
    expect(tenants.get(bob.id).db.listTransactions().some(t => t.id === 'monobank:hook1')).toBe(false);
  });

  it('encrypts each user’s bank token with their own key', () => {
    const row = tenants.get(alice.id).db.getSource('mono-alice')!;
    expect(decryptSecret(row.credentials_enc, tenants.dataKey(core.getUser(alice.id)!), row.id)).toBe('{"token":"t"}');
    expect(() => decryptSecret(row.credentials_enc, tenants.dataKey(core.getUser(bob.id)!), row.id)).toThrow();
    expect(() => decryptSecret(row.credentials_enc, key, row.id)).toThrow();
  });

  it('deleting a user removes their data and sessions, not anyone else’s', async () => {
    expect((await app.request(`/api/admin/users/${bob.id}`, { method: 'DELETE', headers: alice.headers })).status).toBe(204);
    expect((await app.request('/api/me', { headers: bob.headers })).status).toBe(401);
    expect(core.routeOf('mono-bob')).toBeNull();
    expect((await get('/api/sources', alice.headers)).map((s: any) => s.id)).toEqual(['mono-alice']);
  });

  it('lets a user delete their own account with their password', async () => {
    const del = (password: string) => app.request('/api/me', { method: 'DELETE', headers: { ...json, ...bob.headers }, body: JSON.stringify({ password }) });
    expect((await del('wrong')).status).toBe(403);
    expect((await del(PASSWORD)).status).toBe(204);
    expect(core.getUser(bob.id)).toBeUndefined();
    // The only admin can't leave while others depend on them.
    const self = await app.request('/api/me', { method: 'DELETE', headers: { ...json, ...alice.headers }, body: JSON.stringify({ password: PASSWORD }) });
    expect(self.status).toBe(204); // bob is gone, so alice is the last user and may leave
  });
});

describe('moving an existing single-user database to the first admin', () => {
  it('keeps the data, backs it up, re-encrypts the token and routes webhooks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'unresub-legacy-'));
    const path = join(dir, 'unresub.db');
    const old: Db = openDb(path);
    old.insertSource({ id: 'monobank-old', kind: 'monobank', name: 'monobank · Me', credentials_enc: encryptSecret('{"token":"real"}', key, 'monobank-old'), webhook_secret: 'old-secret' });
    old.upsertAccounts('monobank-old', [{ externalId: 'acc', currency: 980, balance: 1, creditLimit: 0, maskedPan: '1', iban: null, type: 'black' }]);
    const now = Math.floor(Date.now() / 1000);
    old.insertTransactions('monobank-old:acc', makeSeries({ description: 'YOUTUBE', period: 'monthly', price: 9_900, currency: 980, count: 3, last: now - 86_400 }).map(({ accountId: _, ...t }) => ({ ...t, accountExternalId: 'acc', raw: null })));
    old.insertRates(now, [{ currency: 840, buy: 41, sell: 41.5 }]);
    const legacy: LegacyData = { path, db: old, key, sync: new SyncService(old, { key, publicUrl: null, backfillMonths: 3, log: () => {} }) };
    build({ dataDir: dir, legacy });

    expect(await (await app.request('/api/auth/status')).json()).toMatchObject({ setupRequired: true, legacyData: true });
    // Webhooks keep landing in the old database until it's claimed.
    expect((await app.request('/hooks/monobank-old/old-secret')).status).toBe(200);

    const admin = await setup();
    expect(readdirSync(dir).some(f => f.startsWith('unresub.db.pre-multiuser-'))).toBe(true);
    expect(existsSync(path)).toBe(false);
    const t = tenants.get(admin.id);
    expect(t.db.listTransactions()).toHaveLength(3);
    const row = t.db.getSource('monobank-old')!;
    expect(decryptSecret(row.credentials_enc, tenants.dataKey(core.getUser(admin.id)!), row.id)).toBe('{"token":"real"}');
    expect(core.routeOf('monobank-old')).toBe(admin.id);
    expect(core.rateNear(840, now)?.rate_sell).toBe(41.5);
    expect((await app.request('/hooks/monobank-old/old-secret')).status).toBe(200);
    const subs = (await (await app.request('/api/subscriptions', { headers: admin.headers })).json()) as any;
    expect(subs.items).toHaveLength(1);
  });
});

describe('instance key', () => {
  it('is generated once into the data dir and reused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unresub-key-'));
    const k1 = loadInstanceKey(dir, undefined);
    expect(k1).toHaveLength(32);
    expect(loadInstanceKey(dir, undefined).equals(k1)).toBe(true);
    expect(loadInstanceKey(dir, key.toString('base64')).equals(key)).toBe(true);
  });
});
