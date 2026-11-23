import { DatabaseSync } from 'node:sqlite';

/**
 * Instance-wide data: accounts, sessions, invites, which user owns which webhook, and
 * public exchange rates. Nothing financial lives here; each user's bank data is in its own
 * file (see tenants.ts), so one user's queries can't reach another's rows.
 */
const SCHEMA = /* sql */ `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  data_key_enc  TEXT NOT NULL,             -- the user's data key, wrapped by the instance key
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash    TEXT PRIMARY KEY,             -- sha256 of the token; the token itself is never stored
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf       TEXT NOT NULL,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS invites (
  code_hash  TEXT PRIMARY KEY,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  used_at    INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Webhook URLs carry a source id; this maps it to exactly one user's database.
CREATE TABLE IF NOT EXISTS source_routes (
  source_id TEXT PRIMARY KEY,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
);

-- Public monobank /bank/currency snapshots, shared by everyone.
CREATE TABLE IF NOT EXISTS rate_snapshots (
  fetched_at INTEGER NOT NULL,
  currency   INTEGER NOT NULL,
  rate_buy   REAL,
  rate_sell  REAL,
  rate_cross REAL,
  PRIMARY KEY (fetched_at, currency)
);
`;

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  is_admin: number;
  data_key_enc: string;
  created_at: number;
}

export interface SessionRow {
  id_hash: string;
  user_id: string;
  csrf: string;
  user_agent: string | null;
  created_at: number;
  last_seen: number;
  expires_at: number;
}

export type SignupMode = 'invite' | 'open';

const now = () => Math.floor(Date.now() / 1000);

export const openCoreDb = (path: string) => {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);

  const q = {
    userCount: db.prepare('SELECT COUNT(*) AS n FROM users'),
    users: db.prepare('SELECT * FROM users ORDER BY created_at'),
    user: db.prepare('SELECT * FROM users WHERE id = ?'),
    userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    insertUser: db.prepare('INSERT INTO users (id, username, password_hash, is_admin, data_key_enc, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    setPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
    setAdmin: db.prepare('UPDATE users SET is_admin = ? WHERE id = ?'),
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
    adminCount: db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1'),

    insertSession: db.prepare('INSERT INTO sessions (id_hash, user_id, csrf, user_agent, created_at, last_seen, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    session: db.prepare('SELECT * FROM sessions WHERE id_hash = ? AND expires_at > ?'),
    touchSession: db.prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE id_hash = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE id_hash = ?'),
    deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?'),
    pruneSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),

    insertInvite: db.prepare('INSERT INTO invites (code_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)'),
    invite: db.prepare('SELECT * FROM invites WHERE code_hash = ? AND used_by IS NULL AND expires_at > ?'),
    useInvite: db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code_hash = ? AND used_by IS NULL'),
    invites: db.prepare('SELECT rowid AS id, created_at, expires_at, used_at, (SELECT username FROM users WHERE id = used_by) AS used_by FROM invites ORDER BY created_at DESC LIMIT 50'),
    deleteInvite: db.prepare('DELETE FROM invites WHERE rowid = ?'),

    setting: db.prepare('SELECT value FROM settings WHERE key = ?'),
    setSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'),

    addRoute: db.prepare('INSERT OR REPLACE INTO source_routes (source_id, user_id) VALUES (?, ?)'),
    route: db.prepare('SELECT user_id FROM source_routes WHERE source_id = ?'),
    removeRoute: db.prepare('DELETE FROM source_routes WHERE source_id = ? AND user_id = ?'),

    insertRate: db.prepare('INSERT OR IGNORE INTO rate_snapshots (fetched_at, currency, rate_buy, rate_sell, rate_cross) VALUES (?, ?, ?, ?, ?)'),
    rateNear: db.prepare('SELECT * FROM rate_snapshots WHERE currency = ? ORDER BY ABS(fetched_at - ?) LIMIT 1'),
  };

  const tx = <T,>(fn: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };

  return {
    raw: db,
    close: () => db.close(),
    tx,

    userCount: () => (q.userCount.get() as { n: number }).n,
    listUsers: () => q.users.all() as unknown as UserRow[],
    getUser: (id: string) => q.user.get(id) as unknown as UserRow | undefined,
    userByName: (username: string) => q.userByName.get(username) as unknown as UserRow | undefined,
    insertUser: (u: Omit<UserRow, 'created_at'>) => void q.insertUser.run(u.id, u.username, u.password_hash, u.is_admin, u.data_key_enc, now()),
    setPassword: (id: string, hash: string) => void q.setPassword.run(hash, id),
    setAdmin: (id: string, admin: boolean) => void q.setAdmin.run(admin ? 1 : 0, id),
    deleteUser: (id: string) => void q.deleteUser.run(id),
    adminCount: () => (q.adminCount.get() as { n: number }).n,

    insertSession: (s: Omit<SessionRow, 'created_at' | 'last_seen'>) =>
      void q.insertSession.run(s.id_hash, s.user_id, s.csrf, s.user_agent, now(), now(), s.expires_at),
    getSession: (idHash: string) => q.session.get(idHash, now()) as unknown as SessionRow | undefined,
    touchSession: (idHash: string, expiresAt: number) => void q.touchSession.run(now(), expiresAt, idHash),
    deleteSession: (idHash: string) => void q.deleteSession.run(idHash),
    /** Signs the user out everywhere except `keepIdHash`. */
    deleteOtherSessions: (userId: string, keepIdHash = '') => void q.deleteUserSessions.run(userId, keepIdHash),
    pruneSessions: () => void q.pruneSessions.run(now()),

    insertInvite: (codeHash: string, createdBy: string, expiresAt: number) => void q.insertInvite.run(codeHash, createdBy, now(), expiresAt),
    validInvite: (codeHash: string) => !!q.invite.get(codeHash, now()),
    /** Atomic: false if someone used it first. */
    useInvite: (codeHash: string, userId: string) => q.useInvite.run(userId, now(), codeHash).changes === 1,
    listInvites: () => q.invites.all() as unknown as { id: number; created_at: number; expires_at: number; used_at: number | null; used_by: string | null }[],
    deleteInvite: (id: number) => void q.deleteInvite.run(id),

    signupMode: (): SignupMode => ((q.setting.get('signup') as { value: string } | undefined)?.value === 'open' ? 'open' : 'invite'),
    setSignupMode: (mode: SignupMode) => void q.setSetting.run('signup', mode),

    addRoute: (sourceId: string, userId: string) => void q.addRoute.run(sourceId, userId),
    routeOf: (sourceId: string) => (q.route.get(sourceId) as { user_id: string } | undefined)?.user_id ?? null,
    removeRoute: (sourceId: string, userId: string) => void q.removeRoute.run(sourceId, userId),

    insertRates: (at: number, rates: { currency: number; buy?: number; sell?: number; cross?: number }[]) => {
      for (const r of rates) q.insertRate.run(at, r.currency, r.buy ?? null, r.sell ?? null, r.cross ?? null);
    },
    rateNear: (currency: number, time: number) =>
      q.rateNear.get(currency, time) as unknown as
        | { fetched_at: number; currency: number; rate_buy: number | null; rate_sell: number | null; rate_cross: number | null }
        | undefined,
  };
};

export type CoreDb = ReturnType<typeof openCoreDb>;
