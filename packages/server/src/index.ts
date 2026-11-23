import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { openDb } from './db.ts';
import { env } from './env.ts';
import { SyncService } from './sync.ts';

const db = openDb(env.dbPath);
const sync = new SyncService(db, { key: env.secretKey, publicUrl: env.publicUrl, backfillMonths: env.backfillMonths });
const app = createApp(db, sync, env.apiToken);

// Serve the built web UI in production.
const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
if (existsSync(webDist)) {
  app.use('/*', serveStatic({ root: webDist }));
  app.get('*', serveStatic({ root: webDist, path: 'index.html' }));
}

sync.startScheduler(env.syncIntervalHours);
void sync.syncAll();

serve({ fetch: app.fetch, port: env.port }, ({ port }) => {
  console.log(`UnReSub API on http://localhost:${port}`);
  if (!env.publicUrl) console.log('PUBLIC_URL not set: webhooks disabled, relying on scheduled sync');
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    db.close();
    process.exit(0);
  });
}
