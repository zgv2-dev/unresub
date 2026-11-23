/** Fills the database with a fake monobank account and a year of transactions, so the UI works without a token. */
import { demoTransactions } from '@unresub/core/fixtures';
import { join } from 'node:path';
import { openCoreDb } from './core-db.ts';
import { encryptSecret, randomToken } from './crypto.ts';
import { env, loadInstanceKey } from './env.ts';
import { Tenants } from './tenants.ts';

// Usage: pnpm seed:demo [username]  (defaults to the first account; create it in the app first)
const core = openCoreDb(join(env.dataDir, 'core.db'));
const user = process.argv[2] ? core.userByName(process.argv[2]) : core.listUsers()[0];
if (!user) throw new Error('No such account. Open the app and finish setup first.');
const tenants = new Tenants(core, loadInstanceKey(), { dataDir: env.dataDir, publicUrl: null, backfillMonths: env.backfillMonths });
const { db } = tenants.get(user.id);
const id = 'demo';
if (!db.getSource(id)) {
  db.insertSource({
    id,
    kind: 'monobank',
    name: 'monobank · Demo',
    credentials_enc: encryptSecret(JSON.stringify({ token: 'demo' }), tenants.dataKey(user), id),
    webhook_secret: randomToken(),
  });
}
db.upsertAccounts(id, [
  { externalId: 'acc-main', currency: 980, balance: 1_254_300, creditLimit: 0, maskedPan: '537541******1234', iban: null, type: 'black' },
  { externalId: 'acc-usd', currency: 840, balance: 500, creditLimit: 0, maskedPan: '537541******9876', iban: null, type: 'black' },
]);
db.setSubscriptionCard(`${id}:acc-usd`, true);
const nowS = Math.floor(Date.now() / 1000);
for (let m = 12; m >= 0; m--) {
  core.insertRates(nowS - m * 30 * 86_400, [{ currency: 840, buy: 41 + m * 0.05, sell: 41.4 + m * 0.05 }, { currency: 978, buy: 47.5, sell: 48.3 }]);
}
// Claude and Discord already moved to the USD subscriptions card; the rest still sit on the main card.
const onUsd = /claude|discord/i;
const txns = demoTransactions().map(({ accountId: _, ...t }) => {
  const usd = onUsd.test(t.description);
  return {
    ...t,
    id: t.id.replace('fixture', 'demo'),
    accountExternalId: usd ? 'acc-usd' : 'acc-main',
    ...(usd && { accountCurrency: 840, amount: t.operationAmount }),
    raw: null,
  };
});
db.insertTransactions(`${id}:acc-main`, txns.filter(t => t.accountExternalId === 'acc-main'));
db.insertTransactions(`${id}:acc-usd`, txns.filter(t => t.accountExternalId === 'acc-usd'));
console.log(`Seeded ${txns.length} demo transactions for ${user.username}`);
tenants.closeAll();
core.close();
