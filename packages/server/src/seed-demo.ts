/** Fills the database with a fake monobank account and a year of transactions, so the UI works without a token. */
import { demoTransactions } from '@unresub/core/fixtures';
import { encryptSecret, randomToken } from './crypto.ts';
import { openDb } from './db.ts';
import { env } from './env.ts';

const db = openDb(env.dbPath);
const id = 'demo';
if (!db.getSource(id)) {
  db.insertSource({
    id,
    kind: 'monobank',
    name: 'monobank · Demo',
    credentials_enc: encryptSecret(JSON.stringify({ token: 'demo' }), env.secretKey, id),
    webhook_secret: randomToken(),
  });
}
db.upsertAccounts(id, [
  { externalId: 'acc-main', currency: 980, balance: 1_254_300, creditLimit: 0, maskedPan: '537541******1234', iban: null, type: 'black' },
  { externalId: 'acc-subs', currency: 980, balance: 45_000, creditLimit: 0, maskedPan: '537541******9876', iban: null, type: 'white' },
]);
const txns = demoTransactions().map(({ accountId: _, ...t }) => ({ ...t, id: t.id.replace('fixture', 'demo'), accountExternalId: 'acc-main', raw: null }));
db.insertTransactions(`${id}:acc-main`, txns);
console.log(`Seeded ${txns.length} demo transactions into ${env.dbPath}`);
db.close();
