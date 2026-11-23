import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import type { CoreDb, SessionRow, SessionScope, UserRow } from './core-db.ts';
import { randomToken, safeEqual, sha256 } from './crypto.ts';
import type { Tenant, Tenants } from './tenants.ts';

export const SESSION_COOKIE = 'unresub_session';
export const USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/i;

export type AuthEnv = {
  Variables: { user: UserRow; session: SessionRow; tenant: Tenant; viaCookie: boolean; mustEnrol: boolean };
};

const nowS = () => Math.floor(Date.now() / 1000);

export const publicUser = (u: UserRow) => ({ id: u.id, username: u.username, isAdmin: !!u.is_admin, createdAt: u.created_at });

export const checkUsername = (username: unknown) => {
  if (typeof username !== 'string' || !USERNAME.test(username.trim())) {
    throw new HTTPException(400, { message: 'Username: 3 to 32 letters, digits, dots, dashes or underscores' });
  }
  return username.trim().toLowerCase();
};

const isHttps = (c: Context) => new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https';

/**
 * The client address. Behind one reverse proxy (Railway, Caddy, nginx) the proxy appends
 * the real peer as the last X-Forwarded-For entry; earlier entries are client-controlled.
 */
export const clientIp = (c: Context) => c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim() || 'direct';

/** Fixed-window failure counter. In memory: a restart resets it, which is fine for one process. */
export class Limiter {
  #hits = new Map<string, { n: number; until: number }>();
  constructor(private max: number, private windowS: number) {}

  /** Seconds until `key` may try again, or 0. */
  retryAfter(key: string) {
    const h = this.#hits.get(key);
    if (!h || h.until <= nowS()) return 0;
    return h.n >= this.max ? h.until - nowS() : 0;
  }
  fail(key: string) {
    const h = this.#hits.get(key);
    if (!h || h.until <= nowS()) this.#hits.set(key, { n: 1, until: nowS() + this.windowS });
    else h.n++;
    if (this.#hits.size > 10_000) for (const [k, v] of this.#hits) if (v.until <= nowS()) this.#hits.delete(k);
  }
  reset(key: string) {
    this.#hits.delete(key);
  }
}

export const limits = () => ({
  /** Per account: slows down guessing one user's password from many addresses. */
  user: new Limiter(5, 15 * 60),
  /** Per address: slows down spraying many accounts. Also covers setup codes and invites. */
  ip: new Limiter(20, 15 * 60),
});
export type Limits = ReturnType<typeof limits>;

export const guard = (c: Context, l: Limits, username?: string) => {
  const wait = Math.max(l.ip.retryAfter(clientIp(c)), username ? l.user.retryAfter(username.toLowerCase()) : 0);
  if (wait > 0) {
    throw new HTTPException(429, {
      res: new Response(JSON.stringify({ error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.` }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': String(wait) },
      }),
    });
  }
};

export const recordFailure = (c: Context, l: Limits, username?: string) => {
  l.ip.fail(clientIp(c));
  if (username) l.user.fail(username.toLowerCase());
};

export class Sessions {
  constructor(private core: CoreDb, private days: number) {}

  /** Returns the raw token; only its hash is stored. */
  create(c: Context, userId: string, { cookie, scope = 'full' }: { cookie: boolean; scope?: SessionScope }) {
    const token = randomToken(32);
    const csrf = randomToken(24);
    this.core.insertSession({
      id_hash: sha256(token),
      user_id: userId,
      csrf,
      scope,
      user_agent: c.req.header('user-agent')?.slice(0, 200) ?? null,
      expires_at: nowS() + this.days * 86_400,
    });
    if (cookie) {
      setCookie(c, SESSION_COOKIE, token, {
        httpOnly: true,
        secure: isHttps(c),
        sameSite: 'Lax',
        path: '/',
        maxAge: this.days * 86_400,
      });
    }
    return { token, csrf };
  }

  /** Session token from the cookie (browser) or a bearer header (Android app). */
  read(c: Context) {
    const bearer = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    const token = bearer ?? getCookie(c, SESSION_COOKIE);
    if (!token) return null;
    const session = this.core.getSession(sha256(token));
    if (!session) return null;
    // Sliding expiry, written at most hourly.
    if (nowS() - session.last_seen > 3_600) this.core.touchSession(session.id_hash, nowS() + this.days * 86_400);
    return { session, viaCookie: !bearer };
  }

  end(c: Context, session: SessionRow) {
    this.core.deleteSession(session.id_hash);
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure: isHttps(c) });
  }
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
/** All a session may do before the account has a passkey (recovery, re-enrol link, old password account). */
const ENROL_PATHS = new Set(['/api/me', '/api/me/passkeys/options', '/api/me/passkeys/verify', '/api/auth/logout']);

/** A session must add a passkey first when it came from a recovery path or the account has none. */
export const mustEnrol = (core: CoreDb, session: SessionRow) => session.scope === 'enrol' || core.passkeyCount(session.user_id) === 0;

/**
 * Loads the user and their own database for /api routes. Cookie sessions must echo the
 * session's CSRF token in X-CSRF-Token on writes; bearer tokens aren't sent by browsers
 * on their own, so they don't need it.
 */
export const requireUser = (core: CoreDb, sessions: Sessions, tenants: Tenants): MiddlewareHandler<AuthEnv> => async (c, next) => {
  const found = sessions.read(c);
  const user = found && core.getUser(found.session.user_id);
  if (!found || !user) throw new HTTPException(401, { message: 'Sign in first' });
  if (found.viaCookie && !SAFE.has(c.req.method) && !safeEqual(c.req.header('x-csrf-token') ?? '', found.session.csrf)) {
    throw new HTTPException(403, { message: 'Missing or bad CSRF token, reload the page' });
  }
  const enrol = mustEnrol(core, found.session);
  if (enrol && !ENROL_PATHS.has(c.req.path)) throw new HTTPException(403, { message: 'Add a passkey to continue' });
  c.set('mustEnrol', enrol);
  c.set('user', user);
  c.set('session', found.session);
  c.set('viaCookie', found.viaCookie);
  c.set('tenant', tenants.get(user.id));
  await next();
};

export const requireAdmin: MiddlewareHandler<AuthEnv> = async (c, next) => {
  if (!c.var.user.is_admin) throw new HTTPException(403, { message: 'Admins only' });
  await next();
};
