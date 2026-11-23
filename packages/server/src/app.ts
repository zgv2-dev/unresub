import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import {
  annualEquivalent,
  applyCorrections,
  buildManualSubscriptions,
  extendWithSwitchedCharges,
  linkCardSwitches,
  groupKeyOf,
  matchService,
  merchantKey,
  computeAlerts,
  detectSubscriptions,
  monthlyEquivalent,
  SERVICE_CATALOG,
  serviceById,
  type Period,
} from '@unresub/core';
import {
  checkCredentials,
  guard,
  limits as makeLimits,
  publicUser,
  recordFailure,
  requireAdmin,
  requireUser,
  type AuthEnv,
  type Limits,
  type Sessions,
} from './auth.ts';
import type { CoreDb, UserRow } from './core-db.ts';
import { burnPasswordCheck, hashPassword, randomToken, safeEqual, sha256, verifyPassword } from './crypto.ts';
import type { Db, OverrideRow } from './db.ts';
import { MonobankError } from './sources/monobank.ts';
import type { SyncService } from './sync.ts';
import type { Tenants } from './tenants.ts';

const PERIODS: Period[] = ['weekly', 'monthly', 'quarterly', 'semiannual', 'annual'];

export const buildSubscriptionsView = (db: Db, sync: Pick<SyncService, 'toLocal' | 'convert'>, now = Math.floor(Date.now() / 1000)) => {
  const accounts = new Map(db.listAccounts().map(a => [a.id, a]));
  const hasSubCard = [...accounts.values()].some(a => a.is_subscription_card);
  const overrides = new Map(db.listOverrides().map(o => [o.key, o]));
  const splitGroups = db.splitGroups();
  const transactions = db.listTransactions();
  // Manual subscriptions claim their transactions first, so detection doesn't count them twice.
  const manual = buildManualSubscriptions(db.listManual(), transactions, { now, toLocal: sync.toLocal });
  // A subscription moved to a card with another charge currency: continue the old series with the
  // first new charges, and once the new card has its own series, fold the old one into it.
  const raw = extendWithSwitchedCharges(
    [
      ...manual.subscriptions,
      ...detectSubscriptions(transactions.filter(t => !manual.claimed.has(t.id)), { now, toLocal: sync.toLocal, splitGroups }),
    ],
    transactions,
    { now, toLocal: sync.toLocal },
  );
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
      onMainCard: hasSubCard && !!account && !account.is_subscription_card && o.status !== 'ignored',
    };
  });

  const alerts = computeAlerts(
    items.map(i => ({
      key: i.key, name: i.name, nextChargeAt: i.nextChargeAt, price: i.price, currency: i.currency,
      accountId: i.accountId, status: i.status, ignored: i.userStatus === 'ignored', remindDays: i.remindDays,
    })),
    [...accounts.values()].map(a => ({ id: a.id, currency: a.currency, balance: a.balance, isSubscriptionCard: !!a.is_subscription_card })),
    { now, convert: sync.convert },
  );

  const counted = items.filter(i => i.userStatus !== 'ignored' && i.status !== 'possibly_cancelled');
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
  limits?: Limits;
  log?: (msg: string) => void;
}


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
      return c.json({ error: err.status === 403 ? 'monobank rejected the token' : err.message }, err.status === 429 ? 429 : 502);
    }
    console.error(err);
    return c.json({ error: 'Internal error' }, 500);
  });

  app.get('/healthz', c => c.text('ok'));

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

  // --- Auth (public) ---
  const session = (c: Context, user: UserRow, client: unknown) => {
    const app = client === 'app';
    const { token, csrf } = sessions.create(c, user.id, { cookie: !app });
    return { user: publicUser(user), csrfToken: app ? null : csrf, ...(app && { token }) };
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
      csrfToken: user && found.viaCookie ? found.session.csrf : null,
    });
  });

  app.post('/api/auth/setup', async c => {
    if (core.userCount() > 0) throw new HTTPException(409, { message: 'Already set up, sign in instead' });
    guard(c, limits);
    const body = await readJson(c);
    const code = typeof body.setupCode === 'string' ? body.setupCode.trim() : '';
    if (!deps.setupCodes.some(s => safeEqual(code, s))) {
      recordFailure(c, limits);
      throw new HTTPException(403, { message: 'Wrong setup code. It is printed in the server log.' });
    }
    const { username, password } = checkCredentials(body.username, body.password);
    const hash = await hashPassword(password);
    const user = core.tx(() => {
      if (core.userCount() > 0) throw new HTTPException(409, { message: 'Already set up, sign in instead' });
      return tenants.createUser(username, hash, true);
    });
    log(`[auth] setup complete, admin account created`);
    if (deps.legacy) {
      const t = tenants.adoptLegacy(user.id, deps.legacy);
      deps.legacy = null;
      log(`[auth] existing data moved to the admin account`);
      void t.sync.registerWebhooks().then(() => t.sync.syncAll());
    }
    return c.json(session(c, user, body.client), 201);
  });

  app.post('/api/auth/login', async c => {
    const body = await readJson(c);
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    guard(c, limits, username);
    const user = username ? core.userByName(username) : undefined;
    const ok = user ? await verifyPassword(password, user.password_hash) : (await burnPasswordCheck(password), false);
    if (!user || !ok) {
      recordFailure(c, limits, username);
      throw new HTTPException(401, { message: 'Wrong username or password' });
    }
    limits.user.reset(username);
    return c.json(session(c, user, body.client));
  });

  app.post('/api/auth/signup', async c => {
    guard(c, limits);
    const body = await readJson(c);
    const invite = typeof body.invite === 'string' ? sha256(body.invite.trim()) : null;
    const open = core.signupMode() === 'open';
    if (core.userCount() === 0) throw new HTTPException(409, { message: 'Finish setup first' });
    if (!open && !(invite && core.validInvite(invite))) {
      recordFailure(c, limits);
      throw new HTTPException(403, { message: open ? 'Bad invite' : 'Sign-up needs an invite link from the admin' });
    }
    const { username, password } = checkCredentials(body.username, body.password);
    const hash = await hashPassword(password);
    const user = core.tx(() => {
      if (core.userByName(username)) throw new HTTPException(409, { message: 'That username is taken' });
      const u = tenants.createUser(username, hash, false);
      // Only a still-unused invite counts; an open instance ignores a stale one.
      if (!open && !core.useInvite(invite!, u.id)) throw new HTTPException(403, { message: 'That invite was already used' });
      return u;
    });
    log(`[auth] new account created`);
    return c.json(session(c, user, body.client), 201);
  });

  // --- Everything below needs a signed-in user, and only ever sees that user's database. ---
  const api = new Hono<AuthEnv>();
  api.use('*', requireUser(core, sessions, tenants));

  api.post('/auth/logout', c => {
    sessions.end(c, c.var.session);
    return c.body(null, 204);
  });

  api.get('/me', c => c.json(publicUser(c.var.user)));

  api.post('/me/password', async c => {
    const body = await readJson(c);
    guard(c, limits, c.var.user.username);
    if (typeof body.current !== 'string' || !(await verifyPassword(body.current, c.var.user.password_hash))) {
      recordFailure(c, limits, c.var.user.username);
      throw new HTTPException(403, { message: 'Current password is wrong' });
    }
    const { password } = checkCredentials(c.var.user.username, body.next);
    core.setPassword(c.var.user.id, await hashPassword(password));
    core.deleteOtherSessions(c.var.user.id, c.var.session.id_hash);
    return c.body(null, 204);
  });

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
    core.deleteUser(userId); // cascades to sessions, webhook routes and invites
  };

  /** Deletes the account and its whole database. */
  api.delete('/me', async c => {
    const body = await readJson(c);
    const me = c.var.user;
    if (typeof body.password !== 'string' || !(await verifyPassword(body.password, me.password_hash))) {
      throw new HTTPException(403, { message: 'Password is wrong' });
    }
    if (me.is_admin && core.adminCount() === 1 && core.userCount() > 1) {
      throw new HTTPException(409, { message: 'Make someone else an admin first' });
    }
    deleteUser(me.id);
    sessions.end(c, c.var.session);
    return c.body(null, 204);
  });

  // --- Admin: accounts and sign-up only. Admins can't read other users' data. ---
  const admin = new Hono<AuthEnv>();
  admin.use('*', requireAdmin);
  admin.get('/users', c => c.json(core.listUsers().map(publicUser)));
  admin.patch('/users/:id', async c => {
    const body = await readJson(c);
    const target = core.getUser(c.req.param('id'));
    if (!target) throw new HTTPException(404);
    if (typeof body.isAdmin === 'boolean') {
      if (!body.isAdmin && target.is_admin && core.adminCount() === 1) throw new HTTPException(409, { message: 'Keep at least one admin' });
      core.setAdmin(target.id, body.isAdmin);
    }
    return c.json(publicUser(core.getUser(target.id)!));
  });
  admin.delete('/users/:id', c => {
    const target = core.getUser(c.req.param('id'));
    if (!target) throw new HTTPException(404);
    if (target.id === c.var.user.id) throw new HTTPException(409, { message: 'Delete your own account from Account settings' });
    deleteUser(target.id);
    return c.body(null, 204);
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
    if (!token || !/^[\w-]{20,}$/.test(token.trim())) throw new HTTPException(400, { message: 'Paste the token from api.monobank.ua' });
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
    const body = await c.req.json<Partial<{ name: string | null; serviceId: string | null; period: Period | null; status: 'confirmed' | 'ignored' | null; cancelUrl: string | null; notes: string | null; remindDays: number | null; mergedInto: string | null }>>();
    if (body.mergedInto === key) throw new HTTPException(400, { message: "Can't merge a subscription into itself" });
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
    });
    return c.body(null, 204);
  });

  // --- Transactions ---
  const txnView = (db: Db, sync: SyncService, now = Math.floor(Date.now() / 1000)) => {
    const view = buildSubscriptionsView(db, sync, now);
    const owner = new Map<string, { key: string; name: string; hidden: boolean }>();
    for (const i of view.items) for (const id of i.transactionIds) owner.set(id, { key: i.key, name: i.name, hidden: i.userStatus === 'ignored' });
    return { owner, view };
  };
  const toRow = (t: ReturnType<Db['listTransactions']>[number], owner: Map<string, { key: string; name: string; hidden: boolean }>) => {
    const o = owner.get(t.id);
    return {
      ...t,
      subscriptionKey: o?.key ?? null,
      subscriptionName: o?.name ?? null,
      hidden: o?.hidden ?? false,
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
    return c.json({ total: rows.length, items: rows.slice(offset, offset + limit).map(t => toRow(t, owner)) });
  });

  /** Other debits from the same merchant, to attach when creating a subscription by hand. */
  api.get('/transactions/:id/similar', c => {
    const { db, sync } = c.var.tenant;
    const all = db.listTransactions();
    const t = all.find(x => x.id === c.req.param('id'));
    if (!t) throw new HTTPException(404);
    const groupKey = groupKeyOf(t);
    const { owner } = txnView(db, sync);
    const amount = Math.abs(t.operationAmount);
    const items = all
      .filter(x => x.id !== t.id && x.operationAmount < 0 && groupKey && groupKeyOf(x) === groupKey)
      .reverse()
      .slice(0, 50)
      .map(x => ({ ...toRow(x, owner), sameAmount: Math.abs(Math.abs(x.operationAmount) - amount) <= amount * 0.03 }));
    const service = matchService(t.description);
    const cleaned = t.description.replace(/\s*[#№]?\d{3,}\S*/g, '').trim() || t.description;
    return c.json({
      transaction: toRow(t, owner),
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
    if (!t) throw new HTTPException(404, { message: 'Transaction not found' });
    if (t.operationAmount >= 0) throw new HTTPException(400, { message: 'Only charges can be subscriptions' });
    if (!PERIODS.includes(body.period)) throw new HTTPException(400, { message: 'Bad period' });
    if (body.serviceId && !serviceById(body.serviceId)) throw new HTTPException(400, { message: 'Unknown service' });
    const groupKey = groupKeyOf(t);
    const key = `manual:${randomToken(6)}`;
    const ids = [...new Set([t.id, ...(body.attachIds ?? [])])].slice(0, 500);
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

  // Split a merchant into separate subscriptions by price, or undo it. Keyed by the group, so new charges follow.
  api.put('/split-groups/:groupKey', c => (c.var.tenant.db.setSplit(c.req.param('groupKey'), true), c.body(null, 204)));
  api.delete('/split-groups/:groupKey', c => (c.var.tenant.db.setSplit(c.req.param('groupKey'), false), c.body(null, 204)));

  app.route('/api', api);
  return app;
};
