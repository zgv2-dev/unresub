import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeSeries } from '@unresub/core/fixtures';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, type LegacyData } from './app.ts';
import { Sessions } from './auth.ts';
import { openCoreDb, type CoreDb } from './core-db.ts';
import { decryptSecret, encryptSecret, hashPassword } from './crypto.ts';
import { openDb, type Db } from './db.ts';
import { loadInstanceKey } from './env.ts';
import { SyncService } from './sync.ts';
import { Tenants } from './tenants.ts';
import { SoftPasskey } from './soft-authenticator.test-util.ts';
import { androidOrigin, WebAuthn } from './webauthn.ts';

const key = randomBytes(32);
const json = { 'Content-Type': 'application/json' };
const FP = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';

let core: CoreDb;
let tenants: Tenants;
let app: ReturnType<typeof createApp>;

const build = (opts: { dataDir?: string | null; legacy?: LegacyData | null } = {}) => {
  core = openCoreDb(opts.dataDir ? join(opts.dataDir, 'core.db') : ':memory:');
  tenants = new Tenants(core, key, { dataDir: opts.dataDir ?? null, publicUrl: 'https://example.test', backfillMonths: 3, log: () => {} });
  app = createApp({
    core, tenants, sessions: new Sessions(core, 30), setupCodes: ['setup-code'], legacy: opts.legacy ?? null, log: () => {},
    webauthn: new WebAuthn({ publicUrl: null, androidCertFingerprints: [FP] }),
    android: { package: 'dev.unresub.app', fingerprints: [FP] },
  });
};

const post = (path: string, body: object, headers: Record<string, string> = {}) =>
  app.request(path, { method: 'POST', headers: { ...json, ...headers }, body: JSON.stringify(body) });
const data = async (res: Response | Promise<Response>) => (await res).json() as Promise<any>;

const cookieOf = (res: Response) => res.headers.get('set-cookie')!.split(';')[0]!;
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Creates an account with a fresh software passkey (setup when no account exists yet). */
interface Registered {
  status: number;
  res?: Response;
  body: any;
  passkey: SoftPasskey;
  id: string;
  headers: Record<string, string>;
  codes: string[];
}

const register = async (username: string, extra: Record<string, string> = {}, client = 'app'): Promise<Registered> => {
  const passkey = new SoftPasskey();
  const opts = await post('/api/auth/register/options', { username, ...extra });
  if (opts.status !== 200) return { status: opts.status, body: await opts.json(), passkey, id: '', headers: {}, codes: [] };
  const { flowId, options } = (await opts.json()) as any;
  const res = await post('/api/auth/register/verify', { flowId, response: passkey.create(options), client });
  const body = (await res.json()) as any;
  return { status: res.status, res, body, passkey, id: body.user?.id as string, headers: bearer(body.token), codes: body.recoveryCodes as string[] };
};

const setup = async () => {
  const r = await register('admin', { setupCode: 'setup-code' });
  expect(r.status).toBe(201);
  return r;
};

const addUser = async (admin: Record<string, string>, username: string) => {
  const { code } = await data(post('/api/admin/invites', {}, admin));
  const r = await register(username, { invite: code });
  expect(r.status).toBe(201);
  return r;
};

const signIn = async (passkey: SoftPasskey) => {
  const { flowId, options } = await data(post('/api/auth/login/options', {}));
  const res = await post('/api/auth/login/verify', { flowId, response: passkey.get(options), client: 'app' });
  return { status: res.status, body: (await res.json()) as any };
};

/** Adds a passkey to the signed-in account. */
const addPasskey = async (headers: Record<string, string>, origin?: string) => {
  const passkey = new SoftPasskey(origin);
  const { flowId, options } = await data(post('/api/me/passkeys/options', {}, headers));
  const res = await post('/api/me/passkeys/verify', { flowId, response: passkey.create(options), name: 'Second' }, headers);
  return { passkey, status: res.status, body: (await res.json()) as any };
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

describe('passkey accounts', () => {
  beforeEach(() => build());

  it('sets up the first admin with the setup code and a passkey, once', async () => {
    expect(await data(app.request('/api/auth/status'))).toMatchObject({ setupRequired: true, user: null });
    expect((await register('admin', { setupCode: 'nope' })).status).toBe(403);
    const r = await register('Admin', { setupCode: 'setup-code' }, 'web');
    expect(r.status).toBe(201);
    expect(r.codes).toHaveLength(10);
    const cookie = r.res!.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const status = await data(app.request('/api/auth/status', { headers: { Cookie: cookieOf(r.res!) } }));
    expect(status).toMatchObject({ setupRequired: false, mustEnrol: false, user: { username: 'admin', isAdmin: true } });
    // Afterwards the same request is just a sign-up, which needs an invite.
    expect((await register('evil', { setupCode: 'setup-code' })).status).toBe(403);
    expect(core.getUser(r.id)!.password_hash).toBe('');
  });

  it('signs in with the passkey alone, and rejects unknown passkeys and replays', async () => {
    const admin = await setup();
    const ok = await signIn(admin.passkey);
    expect(ok.status).toBe(200);
    expect(ok.body.user.username).toBe('admin');
    expect((await signIn(new SoftPasskey())).status).toBe(401);
    // A captured assertion can't be reused: the challenge is single use.
    const { flowId, options } = await data(post('/api/auth/login/options', {}));
    const response = admin.passkey.get(options);
    expect((await post('/api/auth/login/verify', { flowId, response })).status).toBe(200);
    expect((await post('/api/auth/login/verify', { flowId, response })).status).toBe(400);
  });

  it('rejects bad usernames and non-JSON bodies', async () => {
    expect((await register('a', { setupCode: 'setup-code' })).status).toBe(400);
    const form = await app.request('/api/auth/register/options', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=a' });
    expect(form.status).toBe(415);
  });

  it('requires the CSRF token for cookie sessions, not for bearer tokens', async () => {
    const r = await register('admin', { setupCode: 'setup-code' }, 'web');
    const Cookie = cookieOf(r.res!);
    const settings = (headers: Record<string, string>) =>
      app.request('/api/admin/settings', { method: 'PUT', headers: { ...json, Cookie, ...headers }, body: JSON.stringify({ signup: 'open' }) });
    expect((await settings({})).status).toBe(403);
    expect((await settings({ 'X-CSRF-Token': 'forged' })).status).toBe(403);
    expect((await settings({ 'X-CSRF-Token': r.body.csrfToken })).status).toBe(200);
    expect((await app.request('/api/subscriptions', { headers: { Cookie } })).status).toBe(200);
  });

  it('signs up by invite only, unless the admin opens sign-up', async () => {
    const admin = await setup();
    expect((await register('bob')).status).toBe(403);
    const { code } = await data(post('/api/admin/invites', {}, admin.headers));
    expect((await register('bob', { invite: code })).status).toBe(201);
    expect((await register('carol', { invite: code })).status).toBe(403);
    await app.request('/api/admin/settings', { method: 'PUT', headers: { ...json, ...admin.headers }, body: JSON.stringify({ signup: 'open' }) });
    expect((await register('carol')).status).toBe(201);
    expect((await register('CAROL')).status).toBe(409);
  });

  it('adds, renames and removes passkeys, but never the last one', async () => {
    const admin = await setup();
    const second = await addPasskey(admin.headers);
    expect(second.status).toBe(201);
    expect(second.body.recoveryCodes).toBeNull(); // existing codes stay valid
    let list = await data(app.request('/api/me/passkeys', { headers: admin.headers }));
    expect(list.map((p: any) => p.name)).toEqual(['Passkey', 'Second']);
    const patch = await app.request(`/api/me/passkeys/${list[1].id}`, { method: 'PATCH', headers: { ...json, ...admin.headers }, body: JSON.stringify({ name: 'Phone' }) });
    expect(patch.status).toBe(204);
    expect((await app.request(`/api/me/passkeys/${list[0].id}`, { method: 'DELETE', headers: admin.headers })).status).toBe(204);
    list = await data(app.request('/api/me/passkeys', { headers: admin.headers }));
    expect(list.map((p: any) => p.name)).toEqual(['Phone']);
    expect((await app.request(`/api/me/passkeys/${list[0].id}`, { method: 'DELETE', headers: admin.headers })).status).toBe(409);
    expect((await signIn(admin.passkey)).status).toBe(401);
    expect((await signIn(second.passkey)).status).toBe(200);
  });

  it('recovers with a one-time code: only adding a passkey works until one is added', async () => {
    const admin = await setup();
    const code = admin.codes[0]!.toUpperCase(); // case and dashes don't matter
    const rec = await post('/api/auth/recover', { username: 'admin', code, client: 'app' });
    expect(rec.status).toBe(200);
    const h = bearer(((await rec.json()) as any).token);
    expect(await data(app.request('/api/auth/status', { headers: h }))).toMatchObject({ mustEnrol: true });
    expect((await app.request('/api/subscriptions', { headers: h })).status).toBe(403);
    expect((await addPasskey(h)).status).toBe(201);
    expect((await app.request('/api/subscriptions', { headers: h })).status).toBe(200);
    expect((await post('/api/auth/recover', { username: 'admin', code })).status).toBe(401);
    expect((await post('/api/auth/recover', { username: 'admin', code: 'nope-nope-nope' })).status).toBe(401);
  });

  it('lets the admin issue a single-use re-enrol link', async () => {
    const admin = await setup();
    const bob = await addUser(admin.headers, 'bob');
    expect((await post(`/api/admin/users/${admin.id}/reenrol`, {}, bob.headers)).status).toBe(403);
    const { token } = await data(post(`/api/admin/users/${bob.id}/reenrol`, {}, admin.headers));
    const res = await post('/api/auth/reenrol', { token, client: 'app' });
    expect(res.status).toBe(200);
    const h = bearer(((await res.json()) as any).token);
    expect((await app.request('/api/sources', { headers: h })).status).toBe(403);
    const added = await addPasskey(h);
    expect(added.status).toBe(201);
    expect((await signIn(added.passkey)).body.user.username).toBe('bob');
    expect((await post('/api/auth/reenrol', { token })).status).toBe(401);
  });

  it('moves a password account to a passkey and deletes the password', async () => {
    await setup();
    const old = tenants.createUser('olduser', await hashPassword('the old password'), false);
    const res = await post('/api/auth/login', { username: 'olduser', password: 'the old password', client: 'app' });
    expect(res.status).toBe(200);
    const h = bearer(((await res.json()) as any).token);
    expect((await app.request('/api/subscriptions', { headers: h })).status).toBe(403);
    const added = await addPasskey(h);
    expect(added.status).toBe(201);
    expect(added.body.recoveryCodes).toHaveLength(10);
    expect(core.getUser(old.id)!.password_hash).toBe('');
    expect((await app.request('/api/subscriptions', { headers: h })).status).toBe(200);
    expect((await post('/api/auth/login', { username: 'olduser', password: 'the old password' })).status).toBe(401);
  });

  it('accepts passkeys from the Android app and publishes assetlinks.json', async () => {
    const links = await data(app.request('/.well-known/assetlinks.json'));
    expect(links[0].target).toEqual({ namespace: 'android_app', package_name: 'dev.unresub.app', sha256_cert_fingerprints: [FP] });
    expect(links[0].relation).toContain('delegate_permission/common.get_login_creds');
    const admin = await setup();
    const phone = await addPasskey(admin.headers, androidOrigin(FP));
    expect(phone.status).toBe(201);
    expect((await signIn(phone.passkey)).status).toBe(200);
    // Another app's signature isn't accepted.
    const other = await addPasskey(admin.headers, androidOrigin(FP.replace('AA', '00')));
    expect(other.status).toBe(400);
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
    expect(users.map((u: any) => u.passkeys)).toEqual([1, 1]);
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

  it('deletes your own account only after a fresh passkey check', async () => {
    const del = async (who: typeof bob, passkey: SoftPasskey) => {
      const { flowId, options } = await data(post('/api/me/confirm', {}, who.headers));
      return app.request('/api/me', { method: 'DELETE', headers: { ...json, ...who.headers }, body: JSON.stringify({ flowId, response: passkey.get(options) }) });
    };
    expect((await del(bob, alice.passkey)).status).toBe(401); // someone else's passkey doesn't count
    expect((await del(alice, alice.passkey)).status).toBe(409); // the only admin can't leave others behind
    expect((await del(bob, bob.passkey)).status).toBe(204);
    expect(core.getUser(bob.id)).toBeUndefined();
    expect((await del(alice, alice.passkey)).status).toBe(204);
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
