import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import {
  annualEquivalent,
  computeAlerts,
  detectSubscriptions,
  monthlyEquivalent,
  SERVICE_CATALOG,
  serviceById,
  type Period,
} from '@unresub/core';
import { safeEqual } from './crypto.ts';
import type { Db, OverrideRow } from './db.ts';
import { MonobankError } from './sources/monobank.ts';
import type { SyncService } from './sync.ts';

const PERIODS: Period[] = ['weekly', 'monthly', 'quarterly', 'semiannual', 'annual'];

export const buildSubscriptionsView = (db: Db, sync: Pick<SyncService, 'toLocal' | 'convert'>, now = Math.floor(Date.now() / 1000)) => {
  const accounts = new Map(db.listAccounts().map(a => [a.id, a]));
  const hasSubCard = [...accounts.values()].some(a => a.is_subscription_card);
  const overrides = new Map(db.listOverrides().map(o => [o.key, o]));
  const detected = detectSubscriptions(db.listTransactions(), { now, toLocal: sync.toLocal });

  const items = detected.map(d => {
    const o: Partial<OverrideRow> = overrides.get(d.key) ?? {};
    const serviceId = o.service_id ?? d.serviceId;
    const service = serviceById(serviceId);
    const period = o.period ?? d.period;
    const account = accounts.get(d.accountId);
    return {
      ...d,
      serviceId,
      name: o.name ?? service?.name ?? d.name,
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
    const body = await c.req.json<Partial<{ name: string | null; serviceId: string | null; period: Period | null; status: 'confirmed' | 'ignored' | null; cancelUrl: string | null; notes: string | null; remindDays: number | null }>>();
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
    });
    return c.body(null, 204);
  });

  app.route('/api', api);
  return app;
};
