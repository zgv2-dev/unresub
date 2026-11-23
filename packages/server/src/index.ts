import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, type LegacyData } from './app.ts';
import { Sessions } from './auth.ts';
import { openCoreDb } from './core-db.ts';
import { randomToken } from './crypto.ts';
import { openDb } from './db.ts';
import { env, loadInstanceKey } from './env.ts';
import { SyncService } from './sync.ts';
import { Tenants } from './tenants.ts';

const key = loadInstanceKey();
const core = openCoreDb(join(env.dataDir, 'core.db'));
const tenants = new Tenants(core, key, { dataDir: env.dataDir, publicUrl: env.publicUrl, backfillMonths: env.backfillMonths });

// A database from before accounts existed waits here, still receiving webhooks, until the first admin claims it.
let legacy: LegacyData | null = null;
if (core.userCount() === 0 && existsSync(env.legacyDbPath)) {
  const db = openDb(env.legacyDbPath);
  legacy = { path: env.legacyDbPath, db, key, sync: new SyncService(db, { key, publicUrl: env.publicUrl, backfillMonths: env.backfillMonths, rates: core }) };
}

const setupCodes = [...env.setupCodes];
if (core.userCount() === 0) {
  const code = randomToken(9);
  setupCodes.push(code);
  console.log([
    '',
    '┌─────────────────────────────────────────────────┐',
    '│  UnReSub first-run setup                        │',
    `│  Open the app and enter this setup code:        │`,
    `│  ${code.padEnd(47)}│`,
    '└─────────────────────────────────────────────────┘',
    legacy ? 'Existing data found: it moves to the admin account you create.' : '',
  ].join('\n'));
}

const app = createApp({ core, tenants, sessions: new Sessions(core, env.sessionDays), setupCodes, legacy });

// Serve the built web UI in production.
const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
if (existsSync(webDist)) {
  app.use('/*', serveStatic({ root: webDist }));
  app.get('*', serveStatic({ root: webDist, path: 'index.html' }));
}

/** Every user's sources sync independently: each token has its own rate limiter, so one backfill never blocks another. */
const syncEveryone = () => {
  core.pruneSessions();
  for (const t of tenants.all()) void t.sync.syncAll();
};
setInterval(syncEveryone, env.syncIntervalHours * 3_600_000).unref();
syncEveryone();

serve({ fetch: app.fetch, port: env.port }, ({ port }) => {
  console.log(`UnReSub on http://localhost:${port} (data in ${env.dataDir})`);
  if (!env.publicUrl) console.log('PUBLIC_URL not set: webhooks disabled, relying on scheduled sync');
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    tenants.closeAll();
    legacy?.db.close();
    core.close();
    process.exit(0);
  });
}
