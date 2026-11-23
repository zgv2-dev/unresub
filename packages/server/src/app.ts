import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import {
  annualEquivalent,
  applyCorrections,
  buildManualSubscriptions,
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
import { randomToken, safeEqual } from './crypto.ts';
import type { Db, OverrideRow } from './db.ts';
import { MonobankError } from './sources/monobank.ts';
import type { SyncService } from './sync.ts';

const PERIODS: Period[] = ['weekly', 'monthly', 'quarterly', 'semiannual', 'annual'];

export const buildSubscriptionsView = (db: Db, sync: Pick<SyncService, 'toLocal' | 'convert'>, now = Math.floor(Date.now() / 1000)) => {
  const accounts = new Map(db.listAccounts().map(a => [a.id, a]));
  const hasSubCard = [...accounts.values()].some(a => a.is_subscription_card);
  const overrides = new Map(db.listOverrides().map(o => [o.key, o]));
  const splitGroups = db.splitGroups();
  const transactions = db.listTransactions();
  // Manual subscriptions claim their transactions first, so detection doesn't count them twice.
  const manual = buildManualSubscriptions(db.listManual(), transactions, { now, toLocal: sync.toLocal });
  const raw = [
    ...manual.subscriptions,
    ...detectSubscriptions(transactions.filter(t => !manual.claimed.has(t.id)), { now, toLocal: sync.toLocal, splitGroups }),
  ];
  const nameOf = new Map(raw.map(r => [r.key, overrides.get(r.key)?.name ?? serviceById(r.serviceId)?.name ?? r.name]));
  const detected = applyCorrections(
    raw,
    new Map([...overrides].map(([k, o]) => [k, { period: o.period, mergedInto: o.merged_into }])),
    now,
  );

  const items = detected.map(d => {
    const isManual = d.key.startsWith('manual:');
    const o: Partial<OverrideRow> = overrides.get(d.key) ?? {};
    const serviceId = o.service_id ?? d.serviceId;
    const service = serviceById(serviceId);
    const period = d.period;
    const account = accounts.get(d.accountId);
    return {
      ...d,
      serviceId,
      name: o.name ?? (isManual ? d.name : service?.name ?? d.name),
      manual: isManual,
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

export const createApp = (db: Db, sync: SyncService, apiToken: string) => {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    if (err instanceof MonobankError) {
      return c.json({ error: err.status === 403 ? 'monobank rejected the token' : err.message }, err.status === 429 ? 429 : 502);
    }
    console.error(err);
    return c.json({ error: 'Internal error' }, 500);
  });

  app.get('/healthz', c => c.text('ok'));

  // --- Webhooks (public, authenticated by the secret in the path) ---
  // monobank verifies the URL with a GET before enabling it.
  app.get('/hooks/:sourceId/:secret', c => {
    const row = db.getSource(c.req.param('sourceId'));
    return row && safeEqual(c.req.param('secret'), row.webhook_secret) ? c.body(null, 200) : c.body(null, 404);
  });
  app.post('/hooks/:sourceId/:secret', async c => {
    const body = await c.req.json().catch(() => null);
    const row = db.getSource(c.req.param('sourceId'));
    if (!row || !safeEqual(c.req.param('secret'), row.webhook_secret)) return c.body(null, 404);
    // Always answer 200 quickly: monobank disables webhooks after repeated failures.
    try {
      sync.handleWebhook(row.id, c.req.param('secret'), body);
    } catch (e) {
      console.error('[webhook]', (e as Error).message);
    }
    return c.body(null, 200);
  });

  // --- API (bearer token) ---
  // The Android app (Capacitor WebView) calls the API from https://localhost.
  app.use('/api/*', cors({ origin: ['https://localhost', 'capacitor://localhost'], allowHeaders: ['Authorization', 'Content-Type'] }));
  const api = new Hono();
  api.use('*', bearerAuth({ verifyToken: token => safeEqual(token, apiToken) }));

  api.get('/catalog', c =>
    c.json(SERVICE_CATALOG.map(({ id, name, category, cancelUrl }) => ({ id, name, category, cancelUrl: cancelUrl ?? null }))),
  );

  api.get('/sources', c =>
    c.json(db.listSources().map(s => ({
      id: s.id,
      kind: s.kind,
      name: s.name,
      createdAt: s.created_at,
      webhookUrl: sync.webhookUrl(s) ? 'configured' : null,
      sync: sync.status(s.id),
      progress: syncProgress(db, sync, s.id),
    }))),
  );

  api.post('/sources/monobank', async c => {
    const { token } = await c.req.json<{ token?: string }>();
    if (!token || !/^[\w-]{20,}$/.test(token.trim())) throw new HTTPException(400, { message: 'Paste the token from api.monobank.ua' });
    return c.json(await sync.connectMonobank(token.trim()), 201);
  });

  api.delete('/sources/:id', c => {
    db.deleteSource(c.req.param('id'));
    return c.body(null, 204);
  });

  api.post('/sources/:id/sync', c => {
    if (!db.getSource(c.req.param('id'))) throw new HTTPException(404);
    void sync.syncSource(c.req.param('id'));
    return c.json({ started: true }, 202);
  });

  api.get('/accounts', c =>
    c.json(db.listAccounts().map(a => ({
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
    }))),
  );

  api.patch('/accounts/:id', async c => {
    const { isSubscriptionCard } = await c.req.json<{ isSubscriptionCard: boolean }>();
    db.setSubscriptionCard(c.req.param('id'), !!isSubscriptionCard);
    return c.body(null, 204);
  });

  api.get('/subscriptions', async c => {
    await sync.refreshRates();
    return c.json(buildSubscriptionsView(db, sync));
  });

  api.patch('/subscriptions/:key', async c => {
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
      merged_into: pick(body.mergedInto, prev?.merged_into),
    });
    return c.body(null, 204);
  });

  // --- Transactions ---
  const txnView = (now = Math.floor(Date.now() / 1000)) => {
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
    const p = c.req.query();
    const num = (v?: string) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
    const [from, to, min, max] = [num(p.from), num(p.to), num(p.min), num(p.max)];
    const limit = Math.min(500, num(p.limit) ?? 100);
    const offset = num(p.offset) ?? 0;
    const q = p.q?.trim().toLowerCase();
    const { owner } = txnView();
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
    const all = db.listTransactions();
    const t = all.find(x => x.id === c.req.param('id'));
    if (!t) throw new HTTPException(404);
    const groupKey = groupKeyOf(t);
    const { owner } = txnView();
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
    if (!c.req.param('key').startsWith('manual:')) throw new HTTPException(400, { message: 'Not a manual subscription' });
    db.deleteManual(c.req.param('key'));
    return c.body(null, 204);
  });

  // Split a merchant into separate subscriptions by price, or undo it. Keyed by the group, so new charges follow.
  api.put('/split-groups/:groupKey', c => (db.setSplit(c.req.param('groupKey'), true), c.body(null, 204)));
  api.delete('/split-groups/:groupKey', c => (db.setSplit(c.req.param('groupKey'), false), c.body(null, 204)));

  app.route('/api', api);
  return app;
};
