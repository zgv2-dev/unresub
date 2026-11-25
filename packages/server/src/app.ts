import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import {
  annualEquivalent,
  applyCorrections,
  buildManualSubscriptions,
  extendWithSwitchedCharges,
  LOCAL_CURRENCY,
  localAmountOf,
  toMajor,
  linkCardSwitches,
  groupKeyOf,
  matchService,
  merchantKey,
  computeAlerts,
  detectSubscriptions,
  monthlyEquivalent,
  PERIOD_DAYS,
  SERVICE_CATALOG,
  serviceById,
  type Period,
} from '@unresub/core';
import {
  checkUsername,
  guard,
  mustEnrol,
  limits as makeLimits,
  publicUser,
  recordFailure,
  requireAdmin,
  requireUser,
  type AuthEnv,
  type Limits,
  type Sessions,
} from './auth.ts';
import type { CoreDb, PasskeyRow, SessionScope, UserRow } from './core-db.ts';
import { burnPasswordCheck, randomToken, safeEqual, sha256, verifyPassword } from './crypto.ts';
import type { Db, OverrideRow } from './db.ts';
import { MonobankError } from './sources/monobank.ts';
import type { SyncService } from './sync.ts';
import type { Tenants } from './tenants.ts';
import type { WebAuthn } from './webauthn.ts';

const PERIODS: Period[] = ['weekly', 'monthly', 'quarterly', 'semiannual', 'annual'];

/** Silence long enough to archive on its own: two missed periods, and at least 90 days. */
const AUTO_ARCHIVE_DAYS = (period: Period) => Math.max(2 * PERIOD_DAYS[period], 90);

export type Lifecycle = 'active' | 'inactive' | 'archived';

/**
 * active: charging as expected (late charges included). inactive: the expected charge never came.
 * archived: the user archived it, or it has been silent for long; a newer charge brings it back.
 */
const lifecycleOf = (
  d: { status: string; lastChargeAt: number },
  period: Period,
  o: Partial<Pick<OverrideRow, 'archived_at'>>,
  now: number,
): { lifecycle: Lifecycle; archivedBy: 'user' | 'auto' | null; archivedAt: number | null } => {
  // archived_at > 0: archived by the user at that time. < 0: restored by the user at -archived_at.
  const at = o.archived_at ?? 0;
  if (at > 0 && d.lastChargeAt <= at) return { lifecycle: 'archived', archivedBy: 'user', archivedAt: at };
  if (d.status === 'possibly_cancelled') {
    // Archived, then charged again: the archive is void, and silence counts from that charge or the restore.
    const silentDays = (now - Math.max(d.lastChargeAt, Math.abs(at))) / 86_400;
    if (silentDays > AUTO_ARCHIVE_DAYS(period)) return { lifecycle: 'archived', archivedBy: 'auto', archivedAt: null };
    return { lifecycle: 'inactive', archivedBy: null, archivedAt: null };
  }
  return { lifecycle: 'active', archivedBy: null, archivedAt: null };
};

/** A key from an older view can belong to a series that has since been merged into another one. */
const findSubscription = <T extends { key: string; mergedKeys: string[] }>(items: T[], key: string) =>
  items.find(i => i.key === key) ?? items.find(i => i.mergedKeys.includes(key));
const GONE = 'This subscription has changed since the list was loaded. Refresh and try again.';

export const buildSubscriptionsView = (db: Db, sync: Pick<SyncService, 'toLocal' | 'convert'>, now = Math.floor(Date.now() / 1000)) => {
  const accounts = new Map(db.listAccounts().map(a => [a.id, a]));
  const hasSubCard = [...accounts.values()].some(a => a.is_subscription_card);
  const overrides = new Map(db.listOverrides().map(o => [o.key, o]));
  const splitGroups = db.splitGroups();
  // Charges the user unlinked stay out of every subscription.
  const excluded = db.excludedIds();
  // "Not a subscription": those series are never proposed again; their charges stay plain transactions.
  const suppressed = db.suppressedKeys();
  const transactions = db.listTransactions().filter(t => !excluded.has(t.id));
  // Manual subscriptions claim their transactions first, so detection doesn't count them twice.
  const manual = buildManualSubscriptions(db.listManual(), transactions, { now, toLocal: sync.toLocal });
  // A subscription moved to a card with another charge currency: continue the old series with the
  // first new charges, and once the new card has its own series, fold the old one into it.
  const raw = extendWithSwitchedCharges(
    [
      ...manual.subscriptions,
      ...detectSubscriptions(transactions.filter(t => !manual.claimed.has(t.id)), { now, toLocal: sync.toLocal, splitGroups })
        .filter(d => !suppressed.has(d.key)),
    ],
    transactions,
    { now, toLocal: sync.toLocal },
  ).filter(d => !suppressed.has(d.key));
  // The user's own merge decisions win; merged_into = '' means "keep separate".
  const userMerge = new Set([...overrides].filter(([, o]) => o.merged_into != null).map(([k]) => k));
  const autoLinks = linkCardSwitches(raw, userMerge);
  const nameOf = new Map(raw.map(r => [r.key, overrides.get(r.key)?.name ?? serviceById(r.serviceId)?.name ?? r.name]));
  const detected = applyCorrections(
    raw,
    new Map([...new Set([...overrides.keys(), ...autoLinks.keys()])].map(k => {
      const o = overrides.get(k);
      return [k, { period: o?.period, mergedInto: o?.merged_into ?? autoLinks.get(k) ?? null }];
    })),
    now,
  );
  const txnById = new Map(transactions.map(t => [t.id, t]));

  const items = detected.map(d => {
    const isManual = d.key.startsWith('manual:');
    // A merged or moved series keeps the user's edits from its earlier key when the new key has none.
    const o: Partial<OverrideRow> = overrides.get(d.key) ?? d.mergedKeys.map(k => overrides.get(k)).find(Boolean) ?? {};
    // Card the subscription was on before its current one, if it moved.
    const cardIds = d.transactionIds
      .flatMap(id => txnById.get(id) ?? [])
      .toSorted((a, b) => a.time - b.time)
      .map(t => t.accountId);
    const prevCard = cardIds.findLast(id => id !== d.accountId);
    const movedFrom = prevCard && cardIds.lastIndexOf(prevCard) < cardIds.lastIndexOf(d.accountId) ? accounts.get(prevCard) : undefined;
    const serviceId = o.service_id ?? d.serviceId;
    const service = serviceById(serviceId);
    const period = d.period;
    const account = accounts.get(d.accountId);
    return {
      ...d,
      serviceId,
      name: o.name ?? (isManual ? d.name : service?.name ?? d.name),
      manual: isManual,
      /** The card it was charged to before the current one, when it moved. */
      movedFrom: movedFrom ? { id: movedFrom.id, maskedPan: movedFrom.masked_pan } : null,
      /** Keys folded in automatically because the subscription moved to another card. */
      autoLinked: d.mergedKeys.filter(k => autoLinks.has(k)),
      detectedName: d.name,
      period,
      category: service?.category ?? null,
      monthly: monthlyEquivalent(d.price, period),
      annual: annualEquivalent(d.price, period),
      monthlyLocal: monthlyEquivalent(d.localPrice, period),
      annualLocal: annualEquivalent(d.localPrice, period),
      cancelUrl: o.cancel_url ?? service?.cancelUrl ?? null,
      notes: o.notes ?? null,
      remindDays: o.remind_days ?? null,
      userStatus: o.status ?? null,
      ...lifecycleOf(d, period, o, now),
      /** The detected period was overridden by the user. */
      periodCorrected: !!o.period,
      /** Series folded into this one; PATCH their key with mergedInto: null to undo. */
      merged: d.mergedKeys.map(k => ({ key: k, name: nameOf.get(k) ?? k })),
      /** This merchant could be split into separate subscriptions by price. */
      canSplit: !isManual && d.key === d.groupKey,
      /** This row came from a split; "undo split" goes through groupKey. */
      isSplit: !isManual && splitGroups.has(d.groupKey),
      needsDetails: !serviceId && !o.name,
      account: account
        ? { id: account.id, maskedPan: account.masked_pan, type: account.type, isSubscriptionCard: !!account.is_subscription_card }
        : null,
      /** Ready for the "move it to your subscriptions card" hint. */
      onMainCard: hasSubCard && !!account && !account.is_subscription_card && lifecycleOf(d, period, o, now).lifecycle !== 'archived',
    };
  });

  const alerts = computeAlerts(
    items.map(i => ({
      key: i.key, name: i.name, nextChargeAt: i.nextChargeAt, price: i.price, currency: i.currency,
      accountId: i.accountId, status: i.status, ignored: i.lifecycle === 'archived', remindDays: i.remindDays,
    })),
    [...accounts.values()].map(a => ({ id: a.id, currency: a.currency, balance: a.balance, isSubscriptionCard: !!a.is_subscription_card })),
    { now, convert: sync.convert },
  );

  const counted = items.filter(i => i.lifecycle === 'active');
  return {
    items,
    alerts,
    totals: {
      monthlyLocal: counted.reduce((s, i) => s + i.monthlyLocal, 0),
      annualLocal: counted.reduce((s, i) => s + i.annualLocal, 0),
      count: counted.length,
    },
    hasSubscriptionCard: hasSubCard,
  };
};

const MONTH = 30.44 * 86_400;

/** Per-card history coverage, derived from what is stored, so it survives restarts. */
export const syncProgress = (db: Db, sync: Pick<SyncService, 'status' | 'horizon' | 'backfillMonths'>, sourceId: string) => {
  const status = sync.status(sourceId);
  const horizon = sync.horizon();
  return db.accountsBySource(sourceId).map(a => {
    const complete = a.backfilled_from != null && a.backfilled_from <= horizon;
    const covered = a.backfilled_from != null && a.synced_to != null ? a.synced_to - Math.max(a.backfilled_from, horizon) : 0;
    const remaining = status.remainingByAccount[a.id] ?? 0;
    return {
      accountId: a.id,
      maskedPan: a.masked_pan,
      currency: a.currency,
      type: a.type,
      monthsDone: Math.min(sync.backfillMonths, Math.max(0, Math.round((covered / MONTH) * 10) / 10)),
      monthsTotal: sync.backfillMonths,
      historyFrom: a.backfilled_from,
      syncedTo: a.synced_to,
      state:
        status.running && status.currentAccountId === a.id ? 'syncing'
        : status.running && remaining > 0 ? 'queued'
        : complete ? 'done'
        : status.lastError ? 'error'
        : 'pending',
    } as const;
  });
};

export interface LegacyData {
  path: string;
  db: Db;
  sync: SyncService;
  key: Buffer;
}

export interface AppDeps {
  core: CoreDb;
  tenants: Tenants;
  sessions: Sessions;
  /** Codes that unlock the first-run setup (generated and logged at boot, or from env). */
  setupCodes: string[];
  /** A pre-multi-user database waiting for the first admin; set to null once adopted. */
  legacy: LegacyData | null;
  webauthn: WebAuthn;
  /** The Android app allowed to use passkeys here (for assetlinks.json). */
  android?: { package: string; fingerprints: string[] };
  limits?: Limits;
  log?: (msg: string) => void;
}

/** Recovery codes are compared case- and dash-insensitively. */
const normalizedCodeHash = (code: string) => sha256(code.toLowerCase().replace(/[^a-z0-9]/g, ''));

/** A default passkey name from the device, e.g. "Android" or "Mac". */
const passkeyName = (name: unknown, c: Context) => {
  if (typeof name === 'string' && name.trim()) return name.trim().slice(0, 60);
  const ua = c.req.header('user-agent') ?? '';
  const os = [['Android', 'Android'], ['iPhone', 'iPhone'], ['iPad', 'iPad'], ['Mac OS', 'Mac'], ['Windows', 'Windows'], ['Linux', 'Linux']].find(([k]) => ua.includes(k!))?.[1];
  return os ? `${os} passkey` : 'Passkey';
};


/** Unauthenticated JSON endpoints insist on a JSON content type: a cross-site form can't send one without CORS. */
const readJson = async (c: Context) => {
  if (!c.req.header('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new HTTPException(415, { message: 'Send JSON' });
  }
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== 'object') throw new HTTPException(400, { message: 'Bad JSON' });
  return body;
};

export const createApp = (deps: AppDeps) => {
  const { core, tenants, sessions } = deps;
  const limits = deps.limits ?? makeLimits();
  const log = deps.log ?? console.log;
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.res ?? c.json({ error: err.message || 'Error' }, err.status);
    if (err instanceof MonobankError) {
      const error =
        err.status === 401 || err.status === 403 ? 'monobank rejected the token. Create a new one at api.monobank.ua.'
        : err.status === 429 ? 'monobank allows one request a minute. Try again in a minute.'
        : err.status >= 500 ? "monobank isn't responding. Try again later."
        : err.message;
      return c.json({ error }, err.status === 429 ? 429 : 502);
    }
    console.error(err);
    return c.json({ error: 'The server hit an error. Try again.' }, 500);
  });

  app.get('/healthz', c => c.text('ok'));

  // Lets the Android app use passkeys for this domain (Credential Manager checks this file).
  app.get('/.well-known/assetlinks.json', c => {
    const fps = deps.android?.fingerprints ?? [];
    if (!fps.length) return c.json([], 404);
    return c.json([{
      relation: ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds'],
      target: { namespace: 'android_app', package_name: deps.android!.package, sha256_cert_fingerprints: fps },
    }]);
  });

  // --- Webhooks (public, authenticated by the secret in the path). Each source id routes to one user. ---
  const hookTarget = (sourceId: string) => {
    const userId = core.routeOf(sourceId);
    if (userId) return tenants.get(userId);
    return deps.legacy?.db.getSource(sourceId) ? deps.legacy : null;
  };
  // monobank verifies the URL with a GET before enabling it.
  app.get('/hooks/:sourceId/:secret', c => {
    const row = hookTarget(c.req.param('sourceId'))?.db.getSource(c.req.param('sourceId'));
    return row && safeEqual(c.req.param('secret'), row.webhook_secret) ? c.body(null, 200) : c.body(null, 404);
  });
  app.post('/hooks/:sourceId/:secret', async c => {
    const body = await c.req.json().catch(() => null);
    const target = hookTarget(c.req.param('sourceId'));
    const row = target?.db.getSource(c.req.param('sourceId'));
    if (!target || !row || !safeEqual(c.req.param('secret'), row.webhook_secret)) return c.body(null, 404);
    // Always answer 200 quickly: monobank disables webhooks after repeated failures.
    try {
      target.sync.handleWebhook(row.id, c.req.param('secret'), body);
    } catch (e) {
      console.error('[webhook]', row.id, (e as Error).name);
    }
    return c.body(null, 200);
  });

  // The Android app (Capacitor WebView) calls the API from https://localhost with a bearer token.
  app.use('/api/*', cors({ origin: ['https://localhost', 'capacitor://localhost'], allowHeaders: ['Authorization', 'Content-Type', 'X-CSRF-Token'] }));

  // --- Auth (public). Passkeys only: no passwords. ---
  const webauthn = deps.webauthn;
  const session = (c: Context, user: UserRow, client: unknown, scope: SessionScope = 'full') => {
    const app = client === 'app';
    const { token, csrf } = sessions.create(c, user.id, { cookie: !app, scope });
    return { user: publicUser(user), mustEnrol: scope === 'enrol', csrfToken: app ? null : csrf, ...(app && { token }) };
  };

  /** Ten one-time codes, shown once. Returns the plain codes; only hashes are stored. */
  const newRecoveryCodes = (userId: string) => {
    const codes = Array.from({ length: 10 }, () => randomToken(10).replace(/[-_]/g, 'x').slice(0, 12).replace(/(.{4})(.{4})(.{4})/, '$1-$2-$3').toLowerCase());
    core.setRecoveryCodes(userId, codes.map(normalizedCodeHash));
    return codes;
  };

  app.get('/api/auth/status', c => {
    const found = sessions.read(c);
    const user = found && core.getUser(found.session.user_id);
    return c.json({
      setupRequired: core.userCount() === 0,
      /** An older single-user database is waiting: the first admin gets it. */
      legacyData: !!deps.legacy,
      signup: core.signupMode(),
      user: user ? publicUser(user) : null,
      mustEnrol: user ? mustEnrol(core, found.session) : false,
      csrfToken: user && found.viaCookie ? found.session.csrf : null,
    });
  });

  /**
   * Step 1 of creating an account: setup (first admin, needs the setup code) or sign-up
   * (open, or with an invite). Nothing is stored until the passkey is verified.
   */
  app.post('/api/auth/register/options', async c => {
    guard(c, limits);
    const body = await readJson(c);
    const username = checkUsername(body.username);
    const setup = core.userCount() === 0;
    if (setup) {
      const code = typeof body.setupCode === 'string' ? body.setupCode.trim() : '';
      if (!deps.setupCodes.some(s => safeEqual(code, s))) {
        recordFailure(c, limits);
        throw new HTTPException(403, { message: 'Wrong setup code. Find it in the server log.' });
      }
    } else if (core.signupMode() !== 'open') {
      const invite = typeof body.invite === 'string' ? sha256(body.invite.trim()) : '';
      if (!core.validInvite(invite)) {
        recordFailure(c, limits);
        throw new HTTPException(403, { message: 'Ask the admin for an invite link to sign up.' });
      }
    }
    if (core.userByName(username)) throw new HTTPException(409, { message: 'That username is taken' });
    const pendingId = `u_${randomToken(12)}`;
    return c.json(await webauthn.registrationOptions(c, { id: pendingId, username }, [], { setup, invite: body.invite ?? null }));
  });

  /** Step 2: the passkey is verified, then the account, passkey and recovery codes are created together. */
  app.post('/api/auth/register/verify', async c => {
    const body = await readJson(c);
    const reg = await webauthn.verifyRegistration(c, body.flowId, body.response);
    const setup = reg.meta.setup === true;
    const invite = typeof reg.meta.invite === 'string' ? sha256(reg.meta.invite.trim()) : null;
    const { user, codes } = core.tx(() => {
      if (setup !== (core.userCount() === 0)) throw new HTTPException(409, { message: setup ? 'Already set up, sign in instead' : 'Finish setup first' });
      if (core.userByName(reg.username)) throw new HTTPException(409, { message: 'That username is taken' });
      const u = tenants.createUser(reg.username, '', setup, reg.userId);
      if (!setup && core.signupMode() !== 'open' && !(invite && core.useInvite(invite, u.id))) {
        throw new HTTPException(403, { message: 'That invite was already used. Ask the admin for a new one.' });
      }
      core.insertPasskey({ ...reg.passkey, user_id: u.id, name: passkeyName(body.name, c) });
      return { user: u, codes: newRecoveryCodes(u.id) };
    });
    log(setup ? '[auth] setup complete, admin account created' : '[auth] new account created');
    if (setup && deps.legacy) {
      const t = tenants.adoptLegacy(user.id, deps.legacy);
      deps.legacy = null;
      log('[auth] existing data moved to the admin account');
      void t.sync.registerWebhooks().then(() => t.sync.syncAll());
    }
    return c.json({ ...session(c, user, body.client), recoveryCodes: codes }, 201);
  });

  app.post('/api/auth/login/options', async c => {
    guard(c, limits);
    return c.json(await webauthn.authenticationOptions(c));
  });

  app.post('/api/auth/login/verify', async c => {
    guard(c, limits);
    const body = await readJson(c);
    try {
      const { passkey, newCounter } = await webauthn.verifyAuthentication(c, body.flowId, body.response, id => core.getPasskey(id));
      core.usePasskey(passkey.id, newCounter);
      const user = core.getUser(passkey.user_id)!;
      // A passkey proves the account; an old password, if any, is no longer needed.
      if (user.password_hash) core.setPassword(user.id, '');
      return c.json(session(c, user, body.client));
    } catch (e) {
      recordFailure(c, limits);
      throw e;
    }
  });

  /** Lost every passkey: a one-time recovery code gives a session that can only add a new one. */
  app.post('/api/auth/recover', async c => {
    const body = await readJson(c);
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
    guard(c, limits, username);
    const user = username ? core.userByName(username) : undefined;
    const code = typeof body.code === 'string' ? normalizedCodeHash(body.code) : '';
    if (!user || !core.useRecoveryCode(user.id, code)) {
      recordFailure(c, limits, username);
      throw new HTTPException(401, { message: 'Wrong username or recovery code.' });
    }
    log('[auth] recovery code used');
    return c.json(session(c, user, body.client, 'enrol'));
  });

  /** An admin's single-use link: lets that person add a passkey to their account. */
  app.post('/api/auth/reenrol', async c => {
    guard(c, limits);
    const body = await readJson(c);
    const userId = typeof body.token === 'string' ? core.useReenrol(sha256(body.token.trim())) : null;
    const user = userId && core.getUser(userId);
    if (!user) {
      recordFailure(c, limits);
      throw new HTTPException(401, { message: 'This link expired or was already used. Ask the admin for a new one.' });
    }
    return c.json(session(c, user, body.client, 'enrol'));
  });

  /** Accounts made before passkeys: the password works once more, only to add a passkey. Then it's deleted. */
  app.post('/api/auth/login', async c => {
    const body = await readJson(c);
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    guard(c, limits, username);
    const user = username ? core.userByName(username) : undefined;
    const usable = !!user?.password_hash && core.passkeyCount(user.id) === 0;
    const ok = usable ? await verifyPassword(password, user!.password_hash) : (await burnPasswordCheck(password), false);
    if (!user || !ok) {
      recordFailure(c, limits, username);
      throw new HTTPException(401, { message: 'Wrong username or password. If this account has a passkey, sign in with it.' });
    }
    limits.user.reset(username);
    return c.json(session(c, user, body.client, 'enrol'));
  });

  // --- Everything below needs a signed-in user, and only ever sees that user's database. ---
  const api = new Hono<AuthEnv>();
  api.use('*', requireUser(core, sessions, tenants));

  api.post('/auth/logout', c => {
    sessions.end(c, c.var.session);
    return c.body(null, 204);
  });

  api.get('/me', c => c.json({ ...publicUser(c.var.user), mustEnrol: c.var.mustEnrol, recoveryCodesLeft: core.recoveryCodesLeft(c.var.user.id) }));

  // Passkeys: list, add, rename, remove (never the last one).
  const passkeyView = (p: PasskeyRow, current?: string) => ({
    id: p.id, name: p.name, createdAt: p.created_at, lastUsedAt: p.last_used_at, synced: !!p.backed_up, current: p.id === current,
  });
  api.get('/me/passkeys', c => c.json(core.listPasskeys(c.var.user.id).map(p => passkeyView(p))));
  api.post('/me/passkeys/options', async c => c.json(await webauthn.registrationOptions(c, c.var.user, core.listPasskeys(c.var.user.id))));
  api.post('/me/passkeys/verify', async c => {
    const body = await readJson(c);
    const reg = await webauthn.verifyRegistration(c, body.flowId, body.response);
    if (reg.userId !== c.var.user.id) throw new HTTPException(400, { message: 'Passkey request belongs to another session' });
    const me = c.var.user;
    const first = core.passkeyCount(me.id) === 0;
    const codes = core.tx(() => {
      core.insertPasskey({ ...reg.passkey, user_id: me.id, name: passkeyName(body.name, c) });
      // The account now has a passkey: drop the password, lift the session's restriction.
      core.setPassword(me.id, '');
      core.setSessionScope(c.var.session.id_hash, 'full');
      return first || core.recoveryCodesLeft(me.id) === 0 ? newRecoveryCodes(me.id) : null;
    });
    return c.json({ ok: true, recoveryCodes: codes }, 201);
  });
  api.patch('/me/passkeys/:id', async c => {
    const body = await readJson(c);
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : '';
    if (!name) throw new HTTPException(400, { message: 'Enter a name.' });
    if (!core.renamePasskey(c.var.user.id, c.req.param('id'), name)) throw new HTTPException(404);
    return c.body(null, 204);
  });
  api.delete('/me/passkeys/:id', c => {
    if (core.passkeyCount(c.var.user.id) <= 1) throw new HTTPException(409, { message: 'Add another passkey before removing this one.' });
    if (!core.deletePasskey(c.var.user.id, c.req.param('id'))) throw new HTTPException(404);
    return c.body(null, 204);
  });

  /** New set of recovery codes; the old ones stop working. */
  api.post('/me/recovery-codes', c => c.json({ recoveryCodes: newRecoveryCodes(c.var.user.id) }, 201));

  /** Everything UnReSub stores for this user, minus secrets. */
  api.get('/me/export', c => {
    const { db } = c.var.tenant;
    const all = (sql: string) => db.raw.prepare(sql).all();
    const data = {
      exportedAt: new Date().toISOString(),
      user: publicUser(c.var.user),
      sources: all('SELECT id, kind, name, created_at FROM sources'),
      accounts: all('SELECT * FROM accounts'),
      transactions: all('SELECT id, account_id, time, description, mcc, amount, account_currency, operation_amount, operation_currency, counter_name, hold FROM transactions ORDER BY time'),
      subscriptionOverrides: all('SELECT * FROM subscription_overrides'),
      manualSubscriptions: all('SELECT * FROM manual_subscriptions'),
      splitGroups: all('SELECT * FROM split_groups'),
    };
    c.header('Content-Disposition', `attachment; filename="unresub-${c.var.user.username}-${data.exportedAt.slice(0, 10)}.json"`);
    return c.json(data);
  });

  const deleteUser = (userId: string) => {
    tenants.remove(userId);
    core.deleteUser(userId); // cascades to sessions, passkeys, webhook routes and invites
  };

  /** Deleting the account needs a fresh passkey check (get options from /me/confirm). */
  api.post('/me/confirm', async c => c.json(await webauthn.authenticationOptions(c, c.var.user.id, core.listPasskeys(c.var.user.id))));
  api.delete('/me', async c => {
    const body = await readJson(c);
    const me = c.var.user;
    await webauthn.verifyAuthentication(c, body.flowId, body.response, id => core.getPasskey(id));
    if (me.is_admin && core.adminCount() === 1 && core.userCount() > 1) {
      throw new HTTPException(409, { message: 'Make someone else an admin first.' });
    }
    deleteUser(me.id);
    sessions.end(c, c.var.session);
    return c.body(null, 204);
  });

  // --- Admin: accounts and sign-up only. Admins can't read other users' data. ---
  const admin = new Hono<AuthEnv>();
  admin.use('*', requireAdmin);
  admin.get('/users', c => c.json(core.listUsers().map(u => ({ ...publicUser(u), passkeys: core.passkeyCount(u.id) }))));
  admin.patch('/users/:id', async c => {
    const body = await readJson(c);
    const target = core.getUser(c.req.param('id'));
    if (!target) throw new HTTPException(404);
    if (typeof body.isAdmin === 'boolean') {
      if (!body.isAdmin && target.is_admin && core.adminCount() === 1) throw new HTTPException(409, { message: 'Make someone else an admin first.' });
      core.setAdmin(target.id, body.isAdmin);
    }
    return c.json(publicUser(core.getUser(target.id)!));
  });
  admin.delete('/users/:id', c => {
    const target = core.getUser(c.req.param('id'));
    if (!target) throw new HTTPException(404);
    if (target.id === c.var.user.id) throw new HTTPException(409, { message: 'Delete your own account under Your data.' });
    deleteUser(target.id);
    return c.body(null, 204);
  });
  /** A single-use link, valid 24 hours, that lets someone who lost their passkeys add a new one. */
  admin.post('/users/:id/reenrol', c => {
    const target = core.getUser(c.req.param('id'));
    if (!target) throw new HTTPException(404);
    const token = randomToken(24);
    const expiresAt = Math.floor(Date.now() / 1000) + 86_400;
    core.insertReenrol(sha256(token), target.id, c.var.user.id, expiresAt);
    return c.json({ token, expiresAt }, 201);
  });
  admin.get('/invites', c => c.json(core.listInvites().map(i => ({ id: i.id, createdAt: i.created_at, expiresAt: i.expires_at, usedAt: i.used_at, usedBy: i.used_by }))));
  admin.post('/invites', c => {
    const code = randomToken(18);
    const expiresAt = Math.floor(Date.now() / 1000) + 7 * 86_400;
    core.insertInvite(sha256(code), c.var.user.id, expiresAt);
    return c.json({ code, expiresAt }, 201);
  });
  admin.delete('/invites/:id', c => (core.deleteInvite(Number(c.req.param('id'))), c.body(null, 204)));
  admin.get('/settings', c => c.json({ signup: core.signupMode() }));
  admin.put('/settings', async c => {
    const body = await readJson(c);
    if (body.signup !== 'open' && body.signup !== 'invite') throw new HTTPException(400, { message: 'signup is open or invite' });
    core.setSignupMode(body.signup);
    return c.json({ signup: core.signupMode() });
  });
  api.route('/admin', admin);

  // --- Bank data ---
  api.get('/catalog', c =>
    c.json(SERVICE_CATALOG.map(({ id, name, category, cancelUrl }) => ({ id, name, category, cancelUrl: cancelUrl ?? null }))),
  );

  api.get('/sources', c => {
    const { db, sync } = c.var.tenant;
    return c.json(db.listSources().map(s => ({
      id: s.id,
      kind: s.kind,
      name: s.name,
      createdAt: s.created_at,
      webhookUrl: sync.webhookUrl(s) ? 'configured' : null,
      sync: sync.status(s.id),
      progress: syncProgress(db, sync, s.id),
    })));
  });

  api.post('/sources/monobank', async c => {
    const { db, sync } = c.var.tenant;
    const { token } = await c.req.json<{ token?: string }>();
    if (!token || !/^[\w-]{20,}$/.test(token.trim())) throw new HTTPException(400, { message: 'Paste the personal token from api.monobank.ua.' });
    const r = await sync.connectMonobank(token.trim());
    deps.core.addRoute(r.id, c.var.user.id);
    return c.json(r, 201);
  });

  api.delete('/sources/:id', c => {
    const { db, sync } = c.var.tenant;
    const id = c.req.param('id');
    if (!db.getSource(id)) throw new HTTPException(404);
    db.deleteSource(id);
    sync.forget(id);
    deps.core.removeRoute(id, c.var.user.id);
    return c.body(null, 204);
  });

  api.post('/sources/:id/sync', c => {
    const { db, sync } = c.var.tenant;
    if (!db.getSource(c.req.param('id'))) throw new HTTPException(404);
    void sync.syncSource(c.req.param('id'));
    return c.json({ started: true }, 202);
  });

  api.get('/accounts', c => {
    const { db } = c.var.tenant;
    return c.json(db.listAccounts().map(a => ({
      id: a.id,
      sourceId: a.source_id,
      currency: a.currency,
      balance: a.balance,
      creditLimit: a.credit_limit,
      maskedPan: a.masked_pan,
      iban: a.iban,
      type: a.type,
      isSubscriptionCard: !!a.is_subscription_card,
      backfilledFrom: a.backfilled_from,
      syncedTo: a.synced_to,
    })));
  });

  api.patch('/accounts/:id', async c => {
    const { db } = c.var.tenant;
    if (!db.listAccounts().some(a => a.id === c.req.param('id'))) throw new HTTPException(404);
    const { isSubscriptionCard } = await c.req.json<{ isSubscriptionCard: boolean }>();
    db.setSubscriptionCard(c.req.param('id'), !!isSubscriptionCard);
    return c.body(null, 204);
  });

  api.get('/subscriptions', async c => {
    const { db, sync } = c.var.tenant;
    await sync.refreshRates();
    return c.json(buildSubscriptionsView(db, sync));
  });

  api.patch('/subscriptions/:key', async c => {
    const { db, sync } = c.var.tenant;
    const key = c.req.param('key');
    const body = await c.req.json<Partial<{ name: string | null; serviceId: string | null; period: Period | null; status: 'confirmed' | null; cancelUrl: string | null; notes: string | null; remindDays: number | null; mergedInto: string | null; archived: boolean }>>();
    if (body.mergedInto === key) throw new HTTPException(400, { message: "Can't merge a subscription into itself" });
    if (body.status === ('ignored' as never)) throw new HTTPException(400, { message: 'Use POST /api/subscriptions/:key/dismiss' });
    if (body.period && !PERIODS.includes(body.period)) throw new HTTPException(400, { message: 'Bad period' });
    if (body.serviceId && !serviceById(body.serviceId)) throw new HTTPException(400, { message: 'Unknown service' });
    if (body.remindDays != null && !(Number.isInteger(body.remindDays) && body.remindDays >= 0 && body.remindDays <= 30)) {
      throw new HTTPException(400, { message: 'remindDays must be 0..30' });
    }
    if (body.cancelUrl && !/^https:\/\//.test(body.cancelUrl)) throw new HTTPException(400, { message: 'Cancel URL must be https' });
    const prev = db.listOverrides().find(o => o.key === key);
    const pick = <T,>(v: T | undefined, p: T | null | undefined) => (v === undefined ? p ?? null : v);
    db.upsertOverride({
      key,
      name: pick(body.name, prev?.name),
      service_id: pick(body.serviceId, prev?.service_id),
      period: pick(body.period, prev?.period),
      status: pick(body.status, prev?.status),
      cancel_url: pick(body.cancelUrl, prev?.cancel_url),
      notes: pick(body.notes, prev?.notes),
      remind_days: pick(body.remindDays, prev?.remind_days),
      // Explicit null = the user separated it: stored as '' so automatic card-switch linking won't redo it.
      merged_into: body.mergedInto === null ? '' : pick(body.mergedInto, prev?.merged_into),
      // Archiving stamps the time, so a charge after it un-archives the subscription on its own.
      // Restoring stores the negative time, which restarts the auto-archive clock.
      archived_at: body.archived === undefined ? prev?.archived_at ?? null : body.archived ? Math.floor(Date.now() / 1000) : -Math.floor(Date.now() / 1000),
    });
    return c.body(null, 204);
  });

  /**
   * "Not a subscription": the series (and anything merged into it) is never proposed again and its
   * charges go back to Transactions. A manual one is deleted. Returns a batch id for Undo.
   */
  api.post('/subscriptions/:key/dismiss', c => {
    const { db, sync } = c.var.tenant;
    const key = c.req.param('key');
    const item = findSubscription(buildSubscriptionsView(db, sync).items, key);
    if (!item) throw new HTTPException(404, { message: GONE });
    const batch = randomToken(8);
    const keys = [...new Set([key, ...item.mergedKeys])];
    const manuals = db.listManual().filter(m => keys.includes(m.key));
    const ruleKeys = [...new Set(keys.flatMap(k => {
      const m = manuals.find(x => x.key === k);
      // A manual subscription leaves its charges to detection, so suppress what detection would call them.
      return m ? [m.groupKey, ...(m.matchAmount != null ? [`${m.groupKey}|${m.matchAmount}`] : [])] : [k];
    }))];
    db.suppress(batch, ruleKeys, manuals[0]);
    manuals.forEach(m => db.deleteManual(m.key));
    return c.json({ batch });
  });

  /** Undo a dismissal. */
  api.delete('/suppressions/:batch', c => {
    const { db } = c.var.tenant;
    const { found, manual } = db.unsuppressBatch(c.req.param('batch'));
    if (!found) throw new HTTPException(404);
    if (manual && !db.listManual().some(m => m.key === manual.key)) db.insertManual(manual);
    return c.body(null, 204);
  });

  // --- Transactions ---
  const txnView = (db: Db, sync: SyncService, now = Math.floor(Date.now() / 1000)) => {
    const view = buildSubscriptionsView(db, sync, now);
    const owner = new Map<string, { key: string; name: string }>();
    for (const i of view.items) for (const id of i.transactionIds) owner.set(id, { key: i.key, name: i.name });
    return { owner, view };
  };
  /** Every field monobank's statement returns, read from the stored bank item, so older rows get them without a resync. */
  const detailsOf = (raw: Record<string, unknown> | null) => {
    const num = (k: string) => (typeof raw?.[k] === 'number' ? (raw[k] as number) : null);
    const str = (k: string) => (typeof raw?.[k] === 'string' && raw[k] ? (raw[k] as string) : null);
    return {
      bankId: str('id'),
      originalMcc: num('originalMcc'),
      commissionRate: num('commissionRate'),
      cashbackAmount: num('cashbackAmount'),
      balance: num('balance'),
      comment: str('comment'),
      receiptId: str('receiptId'),
      invoiceId: str('invoiceId'),
      counterEdrpou: str('counterEdrpou'),
      counterIban: str('counterIban'),
    };
  };
  const toRow = (db: Db, t: ReturnType<Db['listTransactions']>[number], owner: Map<string, { key: string; name: string }>, excluded?: Set<string>) => {
    const o = owner.get(t.id);
    return {
      ...t,
      details: detailsOf(db.transactionRaw(t.id)),
      subscriptionKey: o?.key ?? null,
      subscriptionName: o?.name ?? null,
      /** Unlinked from a subscription by the user. */
      excluded: excluded?.has(t.id) ?? false,
    };
  };

  /** Filters: q (description), account, from/to (unix s), min/max (abs amount in account currency, minor), debit=1, unassigned=1. */
  api.get('/transactions', c => {
    const { db, sync } = c.var.tenant;
    const p = c.req.query();
    const num = (v?: string) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
    const [from, to, min, max] = [num(p.from), num(p.to), num(p.min), num(p.max)];
    const limit = Math.min(500, num(p.limit) ?? 100);
    const offset = num(p.offset) ?? 0;
    const q = p.q?.trim().toLowerCase();
    const { owner } = txnView(db, sync);
    const excluded = db.excludedIds();
    const rows = db
      .listTransactions(from ?? 0)
      .filter(t =>
        (to == null || t.time <= to) &&
        (!p.account || t.accountId === p.account) &&
        (p.debit !== '1' || t.amount < 0) &&
        (min == null || Math.abs(t.amount) >= min) &&
        (max == null || Math.abs(t.amount) <= max) &&
        (!q || t.description.toLowerCase().includes(q) || (t.counterName ?? '').toLowerCase().includes(q)) &&
        (p.unassigned !== '1' || !owner.has(t.id)),
      )
      .reverse();
    return c.json({ total: rows.length, items: rows.slice(offset, offset + limit).map(t => toRow(db, t, owner, excluded)) });
  });

  /** Other debits from the same merchant, to attach when creating a subscription by hand. */
  api.get('/transactions/:id/similar', c => {
    const { db, sync } = c.var.tenant;
    const all = db.listTransactions();
    const t = all.find(x => x.id === c.req.param('id'));
    if (!t) throw new HTTPException(404);
    const groupKey = groupKeyOf(t);
    const { owner } = txnView(db, sync);
    const excluded = db.excludedIds();
    const amount = Math.abs(t.operationAmount);
    const items = all
      .filter(x => x.id !== t.id && x.operationAmount < 0 && groupKey && groupKeyOf(x) === groupKey)
      .reverse()
      .slice(0, 50)
      
      .map(x => ({ ...toRow(db, x, owner, excluded), sameAmount: Math.abs(Math.abs(x.operationAmount) - amount) <= amount * 0.03 }));
    const service = matchService(t.description);
    const cleaned = t.description.replace(/\s*[#№]?\d{3,}\S*/g, '').trim() || t.description;
    return c.json({
      transaction: toRow(db, t, owner, excluded),
      groupKey,
      merchant: merchantKey(t.description),
      suggested: { name: service?.name ?? t.counterName ?? cleaned, serviceId: service?.id ?? null },
      items,
    });
  });

  api.post('/manual-subscriptions', async c => {
    const { db, sync } = c.var.tenant;
    const body = await c.req.json<{ transactionId: string; name?: string; serviceId?: string | null; period: Period; matchAmount?: boolean; attachIds?: string[] }>();
    const t = db.listTransactions().find(x => x.id === body.transactionId);
    if (!t) throw new HTTPException(404, { message: 'Transaction not found.' });
    if (t.operationAmount >= 0) throw new HTTPException(400, { message: "Incoming money can't be a subscription." });
    if (!PERIODS.includes(body.period)) throw new HTTPException(400, { message: 'Bad period' });
    if (body.serviceId && !serviceById(body.serviceId)) throw new HTTPException(400, { message: 'Unknown service' });
    const groupKey = groupKeyOf(t);
    const key = `manual:${randomToken(6)}`;
    const ids = [...new Set([t.id, ...(body.attachIds ?? [])])].slice(0, 500);
    db.unexcludeTransactions(ids); // attaching by hand overrides an earlier unlink
    if (groupKey) db.unsuppressGroup(groupKey); // and an earlier "Not a subscription" on this merchant
    db.insertManual({
      key,
      groupKey: groupKey || `txn:${t.id}`, // no usable merchant: only the attached charges count
      matchAmount: body.matchAmount === false ? null : Math.abs(t.operationAmount),
      period: body.period,
      name: body.name?.trim() || serviceById(body.serviceId)?.name || t.description,
      serviceId: body.serviceId ?? null,
      transactionIds: ids,
    });
    return c.json({ key }, 201);
  });

  api.delete('/manual-subscriptions/:key', c => {
    const { db, sync } = c.var.tenant;
    if (!c.req.param('key').startsWith('manual:')) throw new HTTPException(400, { message: 'Not a manual subscription' });
    db.deleteManual(c.req.param('key'));
    return c.body(null, 204);
  });

  /** Charge history of one subscription, newest first, with UAH at each charge's rate and what changed. */
  api.get('/subscriptions/:key/transactions', async c => {
    const { db, sync } = c.var.tenant;
    await sync.refreshRates();
    const item = findSubscription(buildSubscriptionsView(db, sync).items, c.req.param('key'));
    if (!item) throw new HTTPException(404, { message: GONE });
    const accounts = new Map(db.listAccounts().map(a => [a.id, a]));
    const ids = new Set(item.transactionIds);
    const chrono = db.listTransactions().filter(t => ids.has(t.id)).toSorted((a, b) => a.time - b.time);
    const rows = chrono.map((t, i) => {
      const prev = chrono[i - 1];
      const local = localAmountOf(t, sync.toLocal);
      const price = Math.abs(t.operationAmount);
      const prevPrice = prev && prev.operationCurrency === t.operationCurrency ? Math.abs(prev.operationAmount) : null;
      const card = accounts.get(t.accountId);
      const prevCard = prev && prev.accountId !== t.accountId ? accounts.get(prev.accountId) : undefined;
      return {
        id: t.id,
        time: t.time,
        description: t.description,
        price,
        currency: t.operationCurrency,
        /** UAH at this charge's own rate; null when no rate is known. */
        local,
        rate: local ? Math.round((toMajor(local, LOCAL_CURRENCY) / toMajor(price, t.operationCurrency)) * 10_000) / 10_000 : null,
        hold: !!t.hold,
        card: card ? { id: card.id, maskedPan: card.masked_pan, currency: card.currency } : null,
        /** Set on the first charge after the subscription moved cards. */
        movedFrom: prev && prev.accountId !== t.accountId ? { id: prev.accountId, maskedPan: prevCard?.masked_pan ?? null } : null,
        /** Price difference to the previous charge in the same currency (merchant currency, minor units). */
        priceChange: prevPrice != null && prevPrice !== price ? { from: prevPrice, delta: price - prevPrice, pct: Math.round(((price - prevPrice) / prevPrice) * 1_000) / 10 } : null,
        currencyChanged: !!prev && prev.operationCurrency !== t.operationCurrency,
      };
    });
    const byCurrency: Record<string, number> = {};
    for (const r of rows) byCurrency[r.currency] = (byCurrency[r.currency] ?? 0) + r.price;
    return c.json({
      key: item.key,
      count: rows.length,
      totalLocal: rows.reduce((s, r) => s + (r.local ?? 0), 0),
      totalByCurrency: byCurrency,
      since: chrono[0]?.time ?? null,
      items: rows.reverse(),
    });
  });

  /** Unlink a wrongly attached charge: it goes back to Transactions and stays out of detection. */
  api.post('/subscriptions/:key/unlink', async c => {
    const { db, sync } = c.var.tenant;
    const key = c.req.param('key');
    const { transactionId } = await c.req.json<{ transactionId: string }>();
    const item = findSubscription(buildSubscriptionsView(db, sync).items, key);
    if (!item?.transactionIds.includes(transactionId)) throw new HTTPException(404, { message: 'That charge is not part of this subscription.' });
    db.excludeTransaction(transactionId, key);
    const manual = db.listManual().find(m => m.transactionIds.includes(transactionId));
    if (manual) db.setManualTransactionIds(manual.key, manual.transactionIds.filter(id => id !== transactionId));
    return c.body(null, 204);
  });

  /** Undo an unlink. */
  api.delete('/excluded-transactions/:id', c => {
    c.var.tenant.db.unexcludeTransactions([c.req.param('id')]);
    return c.body(null, 204);
  });

  // Split a merchant into separate subscriptions by price, or undo it. Keyed by the group, so new charges follow.
  api.put('/split-groups/:groupKey', c => (c.var.tenant.db.setSplit(c.req.param('groupKey'), true), c.body(null, 204)));
  api.delete('/split-groups/:groupKey', c => (c.var.tenant.db.setSplit(c.req.param('groupKey'), false), c.body(null, 204)));

  app.route('/api', api);
  return app;
};
