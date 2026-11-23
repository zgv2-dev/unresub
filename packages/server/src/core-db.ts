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
  password_hash TEXT NOT NULL,             -- '' once the account has a passkey (legacy accounts only)
  is_admin      INTEGER NOT NULL DEFAULT 0,
  data_key_enc  TEXT NOT NULL,             -- the user's data key, wrapped by the instance key
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash    TEXT PRIMARY KEY,             -- sha256 of the token; the token itself is never stored
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf       TEXT NOT NULL,
  scope      TEXT NOT NULL DEFAULT 'full', -- 'enrol': may only add a passkey (recovery, re-enrol, password migration)
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

-- WebAuthn credentials. The only way to sign in (passwords are only kept until a passkey replaces them).
CREATE TABLE IF NOT EXISTS passkeys (
  id           TEXT PRIMARY KEY,          -- credential id, base64url
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key   TEXT NOT NULL,             -- COSE key, base64url
  counter      INTEGER NOT NULL DEFAULT 0,
  transports   TEXT,                      -- JSON array
  device_type  TEXT,                      -- 'singleDevice' | 'multiDevice'
  backed_up    INTEGER NOT NULL DEFAULT 0,
  name         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys(user_id);

-- One-time recovery codes (hashed). Using one gives a session that can only add a new passkey.
CREATE TABLE IF NOT EXISTS recovery_codes (
  code_hash TEXT PRIMARY KEY,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  used_at   INTEGER
);

-- Admin-issued, single-use, short-lived links to add a passkey to someone's account.
CREATE TABLE IF NOT EXISTS reenrol_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
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

export interface PasskeyRow {
  id: string;
  user_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  device_type: string | null;
  backed_up: number;
  name: string;
  created_at: number;
  last_used_at: number | null;
}

export type SessionScope = 'full' | 'enrol';

export interface SessionRow {
  id_hash: string;
  user_id: string;
  csrf: string;
  scope: SessionScope;
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
  const cols = (t: string) => new Set((db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(c => c.name));
  if (!cols('sessions').has('scope')) db.exec("ALTER TABLE sessions ADD COLUMN scope TEXT NOT NULL DEFAULT 'full'");

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

    insertSession: db.prepare('INSERT INTO sessions (id_hash, user_id, csrf, scope, user_agent, created_at, last_seen, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    setScope: db.prepare('UPDATE sessions SET scope = ? WHERE id_hash = ?'),

    passkeys: db.prepare('SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at'),
    passkey: db.prepare('SELECT * FROM passkeys WHERE id = ?'),
    passkeyCount: db.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?'),
    insertPasskey: db.prepare('INSERT INTO passkeys (id, user_id, public_key, counter, transports, device_type, backed_up, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    usePasskey: db.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?'),
    renamePasskey: db.prepare('UPDATE passkeys SET name = ? WHERE id = ? AND user_id = ?'),
    deletePasskey: db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?'),

    clearRecovery: db.prepare('DELETE FROM recovery_codes WHERE user_id = ?'),
    insertRecovery: db.prepare('INSERT INTO recovery_codes (code_hash, user_id) VALUES (?, ?)'),
    useRecovery: db.prepare('UPDATE recovery_codes SET used_at = ? WHERE code_hash = ? AND user_id = ? AND used_at IS NULL'),
    recoveryLeft: db.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL'),

    insertReenrol: db.prepare('INSERT INTO reenrol_tokens (token_hash, user_id, created_by, expires_at) VALUES (?, ?, ?, ?)'),
    useReenrol: db.prepare('UPDATE reenrol_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING user_id'),
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

    insertSession: (s: Omit<SessionRow, 'created_at' | 'last_seen' | 'scope'> & { scope?: SessionScope }) =>
      void q.insertSession.run(s.id_hash, s.user_id, s.csrf, s.scope ?? 'full', s.user_agent, now(), now(), s.expires_at),
    setSessionScope: (idHash: string, scope: SessionScope) => void q.setScope.run(scope, idHash),

    listPasskeys: (userId: string) => q.passkeys.all(userId) as unknown as PasskeyRow[],
    getPasskey: (id: string) => q.passkey.get(id) as unknown as PasskeyRow | undefined,
    passkeyCount: (userId: string) => (q.passkeyCount.get(userId) as { n: number }).n,
    insertPasskey: (p: Omit<PasskeyRow, 'created_at' | 'last_used_at'>) =>
      void q.insertPasskey.run(p.id, p.user_id, p.public_key, p.counter, p.transports, p.device_type, p.backed_up, p.name, now()),
    usePasskey: (id: string, counter: number) => void q.usePasskey.run(counter, now(), id),
    renamePasskey: (userId: string, id: string, name: string) => q.renamePasskey.run(name, id, userId).changes === 1,
    deletePasskey: (userId: string, id: string) => q.deletePasskey.run(id, userId).changes === 1,

    /** Replaces all of the user's recovery codes with these (already hashed). */
    setRecoveryCodes: (userId: string, hashes: string[]) => {
      q.clearRecovery.run(userId);
      for (const h of hashes) q.insertRecovery.run(h, userId);
    },
    useRecoveryCode: (userId: string, hash: string) => q.useRecovery.run(now(), hash, userId).changes === 1,
    recoveryCodesLeft: (userId: string) => (q.recoveryLeft.get(userId) as { n: number }).n,

    insertReenrol: (tokenHash: string, userId: string, createdBy: string, expiresAt: number) => void q.insertReenrol.run(tokenHash, userId, createdBy, expiresAt),
    /** Atomic single use; returns the user id or null. */
    useReenrol: (tokenHash: string) => (q.useReenrol.get(now(), tokenHash, now()) as { user_id: string } | undefined)?.user_id ?? null,
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
