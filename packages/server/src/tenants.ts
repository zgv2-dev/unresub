import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { CoreDb, UserRow } from './core-db.ts';
import { decryptSecret, encryptSecret, randomToken } from './crypto.ts';
import { openDb, type Db } from './db.ts';
import { SyncService } from './sync.ts';

export interface Tenant {
  userId: string;
  db: Db;
  sync: SyncService;
}

export interface TenantOptions {
  /** null keeps every database in memory (tests). */
  dataDir: string | null;
  publicUrl: string | null;
  backfillMonths: number;
  log?: (msg: string) => void;
}

const USER_ID = /^u_[\w-]{8,}$/;

/** A fresh random data key for a new user, wrapped by the instance key. */
export const newDataKey = (instanceKey: Buffer, userId: string) => encryptSecret(randomBytes(32).toString('base64'), instanceKey, `user:${userId}`);

/**
 * One SQLite file per user (`users/<id>.db`). A request only ever gets its own user's
 * handle, so a missing WHERE clause can't leak rows across users, and export or delete
 * is a whole file. Bank tokens are encrypted with the user's own data key.
 */
export class Tenants {
  #open = new Map<string, Tenant>();

  constructor(private core: CoreDb, private instanceKey: Buffer, private opts: TenantOptions) {
    if (opts.dataDir) mkdirSync(join(opts.dataDir, 'users'), { recursive: true });
  }

  pathOf(userId: string) {
    if (!USER_ID.test(userId)) throw new Error('Bad user id');
    return this.opts.dataDir ? join(this.opts.dataDir, 'users', `${userId}.db`) : ':memory:';
  }

  /** Creates the account row with a fresh data key. Call inside a core transaction. */
  createUser(username: string, passwordHash: string, isAdmin: boolean) {
    const id = `u_${randomToken(12)}`;
    this.core.insertUser({ id, username, password_hash: passwordHash, is_admin: isAdmin ? 1 : 0, data_key_enc: newDataKey(this.instanceKey, id) });
    return this.core.getUser(id)!;
  }

  dataKey(user: Pick<UserRow, 'id' | 'data_key_enc'>) {
    return Buffer.from(decryptSecret(user.data_key_enc, this.instanceKey, `user:${user.id}`), 'base64');
  }

  get(userId: string): Tenant {
    const cached = this.#open.get(userId);
    if (cached) return cached;
    const user = this.core.getUser(userId);
    if (!user) throw new Error('Unknown user');
    const db = openDb(this.pathOf(userId));
    const sync = new SyncService(db, {
      key: this.dataKey(user),
      publicUrl: this.opts.publicUrl,
      backfillMonths: this.opts.backfillMonths,
      log: this.opts.log,
      rates: this.core,
    });
    const t = { userId, db, sync };
    this.#open.set(userId, t);
    return t;
  }

  all() {
    return this.core.listUsers().map(u => this.get(u.id));
  }

  /** Closes and deletes the user's database. The core row is deleted by the caller. */
  remove(userId: string) {
    this.#open.get(userId)?.db.close();
    this.#open.delete(userId);
    const path = this.pathOf(userId);
    if (path !== ':memory:') for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });
  }

  closeAll() {
    for (const t of this.#open.values()) t.db.close();
    this.#open.clear();
  }

  /**
   * Moves a pre-multi-user database into the user's slot: keeps a backup, re-encrypts the
   * bank tokens with the user's data key, routes their webhooks and shares the rate history.
   */
  adoptLegacy(userId: string, legacy: { path: string; db: Db; key: Buffer }) {
    const target = this.pathOf(userId);
    legacy.db.close();
    copyFileSync(legacy.path, `${legacy.path}.pre-multiuser-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`);
    if (target === ':memory:') throw new Error('Legacy adoption needs a data dir');
    for (const ext of ['', '-wal', '-shm']) if (existsSync(legacy.path + ext)) renameSync(legacy.path + ext, target + ext);

    const t = this.get(userId);
    const dataKey = this.dataKey(this.core.getUser(userId)!);
    for (const s of t.db.listSources()) {
      const plain = decryptSecret(s.credentials_enc, legacy.key, s.id);
      t.db.setCredentials(s.id, encryptSecret(plain, dataKey, s.id));
      this.core.addRoute(s.id, userId);
    }
    const rates = t.db.raw.prepare('SELECT * FROM rate_snapshots').all() as { fetched_at: number; currency: number; rate_buy: number | null; rate_sell: number | null; rate_cross: number | null }[];
    for (const r of rates) this.core.insertRates(r.fetched_at, [{ currency: r.currency, buy: r.rate_buy ?? undefined, sell: r.rate_sell ?? undefined, cross: r.rate_cross ?? undefined }]);
    return t;
  }
}
