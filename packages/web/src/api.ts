import type { Alert, DetectionStatus, Period } from '@unresub/core';

const SERVER_KEY = 'unresub.server';
const TOKEN_KEY = 'unresub.session';

/** True inside the Android app (Capacitor WebView), where the server is remote and chosen at sign-in. */
export const isNative = (() => {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string } }).Capacitor;
  return !!(cap?.isNativePlatform?.() ?? (cap?.getPlatform && cap.getPlatform() !== 'web'));
})();

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null) => {
    try {
      v ? localStorage.setItem(k, v) : localStorage.removeItem(k);
    } catch {}
  },
};

/** The browser build talks to its own origin; the app to the server URL the user typed (or a build-time default). */
export const getServer = () => (isNative ? store.get(SERVER_KEY) ?? import.meta.env.VITE_API_BASE ?? '' : import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');
export const setServer = (url: string | null) => store.set(SERVER_KEY, url?.trim().replace(/\/$/, '') || null);

// The app keeps a bearer token (cookies don't cross from the WebView's origin); the browser uses an httpOnly cookie plus a CSRF token.
const getToken = () => (isNative ? store.get(TOKEN_KEY) : null);
const setToken = (t: string | null) => isNative && store.set(TOKEN_KEY, t);
let csrfToken: string | null = null;

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(`${getServer()}/api${path}`, {
      ...init,
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(csrfToken && { 'X-CSRF-Token': csrfToken }),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError(0, isNative ? `Can't reach ${getServer() || 'the server'}` : "Can't reach the server");
  }
  if (!res.ok) {
    const msg = await res.json().then(b => b.error ?? b.message, () => res.statusText).catch(() => res.statusText);
    throw new ApiError(res.status, msg || res.statusText);
  }
  return res.status === 204 ? (undefined as T) : res.json();
};

const send = <T>(method: string, path: string, body?: unknown) =>
  call<T>(path, { method, ...(body !== undefined && { body: JSON.stringify(body) }) });

export interface User {
  id: string;
  username: string;
  isAdmin: boolean;
  createdAt: number;
}

export interface AuthStatus {
  setupRequired: boolean;
  legacyData: boolean;
  signup: 'invite' | 'open';
  user: User | null;
  csrfToken: string | null;
}

interface SignedIn {
  user: User;
  csrfToken: string | null;
  token?: string;
}

const client = isNative ? 'app' : 'web';
const signedIn = (r: SignedIn) => {
  csrfToken = r.csrfToken;
  if (r.token) setToken(r.token);
  return r.user;
};

export const auth = {
  status: async () => {
    const s = await call<AuthStatus>('/auth/status');
    csrfToken = s.csrfToken;
    return s;
  },
  setup: (b: { username: string; password: string; setupCode: string }) => send<SignedIn>('POST', '/auth/setup', { ...b, client }).then(signedIn),
  login: (b: { username: string; password: string }) => send<SignedIn>('POST', '/auth/login', { ...b, client }).then(signedIn),
  signup: (b: { username: string; password: string; invite?: string }) => send<SignedIn>('POST', '/auth/signup', { ...b, client }).then(signedIn),
  logout: async () => {
    await send<void>('POST', '/auth/logout').catch(() => {});
    csrfToken = null;
    setToken(null);
  },
  /** Forget a session the server no longer accepts. */
  forget: () => ((csrfToken = null), setToken(null)),
  changePassword: (current: string, next: string) => send<void>('POST', '/me/password', { current, next }),
  deleteAccount: (password: string) => send<void>('DELETE', '/me', { password }).then(() => setToken(null)),
  exportData: () => call<unknown>('/me/export'),
};

export interface Invite {
  id: number;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  usedBy: string | null;
}

export const admin = {
  users: () => call<User[]>('/admin/users'),
  setAdmin: (id: string, isAdmin: boolean) => send<User>('PATCH', `/admin/users/${id}`, { isAdmin }),
  deleteUser: (id: string) => send<void>('DELETE', `/admin/users/${id}`),
  invites: () => call<Invite[]>('/admin/invites'),
  createInvite: () => send<{ code: string; expiresAt: number }>('POST', '/admin/invites', {}),
  deleteInvite: (id: number) => send<void>('DELETE', `/admin/invites/${id}`),
  settings: () => call<{ signup: 'invite' | 'open' }>('/admin/settings'),
  setSignup: (signup: 'invite' | 'open') => send<{ signup: 'invite' | 'open' }>('PUT', '/admin/settings', { signup }),
};

export interface SubscriptionItem {
  key: string;
  serviceId: string | null;
  name: string;
  detectedName: string;
  period: Period;
  price: number;
  currency: number;
  localPrice: number;
  rate: number;
  monthly: number;
  annual: number;
  monthlyLocal: number;
  annualLocal: number;
  lastChargeAt: number;
  nextChargeAt: number;
  chargeCount: number;
  confidence: number;
  status: DetectionStatus;
  userStatus: 'confirmed' | 'ignored' | null;
  needsDetails: boolean;
  cancelUrl: string | null;
  notes: string | null;
  remindDays: number | null;
  category: string | null;
  account: { id: string; maskedPan: string | null; type: string | null; isSubscriptionCard: boolean } | null;
  onMainCard: boolean;
  groupKey: string;
  /** One merchant may really be several subscriptions: offer "split by price". */
  canSplit: boolean;
  /** Came from a split; undo through groupKey. */
  isSplit: boolean;
  /** Series folded into this one. */
  merged: { key: string; name: string }[];
  periodCorrected: boolean;
  /** Created by hand from a transaction. */
  manual: boolean;
  /** Card it was charged to before the current one, when it moved (e.g. main card to subscriptions card). */
  movedFrom: { id: string; maskedPan: string | null } | null;
  /** Keys folded in automatically because the subscription moved to a card in another currency. */
  autoLinked: string[];
}

export interface TransactionRow {
  id: string;
  accountId: string;
  time: number;
  description: string;
  mcc: number | null;
  amount: number;
  accountCurrency: number;
  operationAmount: number;
  operationCurrency: number;
  counterName?: string | null;
  hold?: boolean;
  subscriptionKey: string | null;
  subscriptionName: string | null;
  hidden: boolean;
  /** Unlinked from a subscription by the user */
  excluded?: boolean;
}

export interface HistoryRow {
  id: string;
  time: number;
  description: string;
  /** Merchant currency, positive minor units */
  price: number;
  currency: number;
  /** UAH at this charge's own rate */
  local: number | null;
  rate: number | null;
  hold: boolean;
  card: { id: string; maskedPan: string | null; currency: number } | null;
  /** Set on the first charge after the subscription moved cards */
  movedFrom: { id: string; maskedPan: string | null } | null;
  priceChange: { from: number; delta: number; pct: number } | null;
  currencyChanged: boolean;
}

export interface HistoryResponse {
  key: string;
  count: number;
  totalLocal: number;
  totalByCurrency: Record<string, number>;
  since: number | null;
  items: HistoryRow[];
}

export interface TransactionFilters {
  q?: string;
  account?: string;
  from?: number;
  to?: number;
  min?: number;
  max?: number;
  debit?: boolean;
  unassigned?: boolean;
  limit?: number;
  offset?: number;
}

export interface SimilarResponse {
  transaction: TransactionRow;
  groupKey: string;
  suggested: { name: string; serviceId: string | null };
  items: (TransactionRow & { sameAmount: boolean })[];
}

export interface SubscriptionsResponse {
  items: SubscriptionItem[];
  alerts: Alert[];
  totals: { monthlyLocal: number; annualLocal: number; count: number };
  hasSubscriptionCard: boolean;
}

export interface Source {
  id: string;
  kind: string;
  name: string;
  webhookUrl: string | null;
  sync: SyncStatus;
  progress: AccountProgress[];
}

export interface SyncStatus {
  running: boolean;
  phase: 'idle' | 'incremental' | 'backfill';
  state: 'idle' | 'fetching' | 'waiting_rate_limit' | 'retrying';
  currentAccountId: string | null;
  /** Epoch ms of the next allowed bank request */
  nextRequestAt: number | null;
  /** Requests done / planned in the current run */
  done: number;
  total: number;
  etaSeconds: number | null;
  remainingByAccount: Record<string, number>;
  lastError: string | null;
  lastFinishedAt: number | null;
}

/** Per card, derived from stored data, so it survives server restarts. */
export interface AccountProgress {
  accountId: string;
  maskedPan: string | null;
  currency: number;
  type: string | null;
  monthsDone: number;
  monthsTotal: number;
  historyFrom: number | null;
  syncedTo: number | null;
  state: 'syncing' | 'queued' | 'done' | 'error' | 'pending';
}

export interface Account {
  id: string;
  sourceId: string;
  currency: number;
  balance: number;
  maskedPan: string | null;
  type: string | null;
  isSubscriptionCard: boolean;
}

export interface CatalogEntry {
  id: string;
  name: string;
  category: string;
  cancelUrl: string | null;
}

export type OverridePatch = Partial<{
  name: string | null;
  serviceId: string | null;
  period: Period | null;
  status: 'confirmed' | 'ignored' | null;
  cancelUrl: string | null;
  notes: string | null;
  remindDays: number | null;
  mergedInto: string | null;
}>;

export const api = {
  subscriptions: () => call<SubscriptionsResponse>('/subscriptions'),
  updateSubscription: (key: string, patch: OverridePatch) =>
    call<void>(`/subscriptions/${encodeURIComponent(key)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  hide: (key: string, hidden = true) => api.updateSubscription(key, { status: hidden ? 'ignored' : null }),
  merge: (key: string, into: string | null) => api.updateSubscription(key, { mergedInto: into }),
  setSplit: (groupKey: string, split: boolean) =>
    call<void>(`/split-groups/${encodeURIComponent(groupKey)}`, { method: split ? 'PUT' : 'DELETE' }),
  transactions: (f: TransactionFilters) => {
    const qs = new URLSearchParams(
      Object.entries(f).flatMap(([k, v]) => (v === undefined || v === '' || v === false ? [] : [[k, v === true ? '1' : String(v)]])),
    );
    return call<{ total: number; items: TransactionRow[] }>(`/transactions?${qs}`);
  },
  history: (key: string) => call<HistoryResponse>(`/subscriptions/${encodeURIComponent(key)}/transactions`),
  unlink: (key: string, transactionId: string) =>
    call<void>(`/subscriptions/${encodeURIComponent(key)}/unlink`, { method: 'POST', body: JSON.stringify({ transactionId }) }),
  relink: (transactionId: string) => call<void>(`/excluded-transactions/${encodeURIComponent(transactionId)}`, { method: 'DELETE' }),
  similar: (id: string) => call<SimilarResponse>(`/transactions/${encodeURIComponent(id)}/similar`),
  createManual: (body: { transactionId: string; name: string; serviceId: string | null; period: Period; matchAmount: boolean; attachIds: string[] }) =>
    call<{ key: string }>('/manual-subscriptions', { method: 'POST', body: JSON.stringify(body) }),
  deleteManual: (key: string) => call<void>(`/manual-subscriptions/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  sources: () => call<Source[]>('/sources'),
  connectMonobank: (token: string) =>
    call<{ id: string; name: string; accounts: number; webhook: string }>('/sources/monobank', { method: 'POST', body: JSON.stringify({ token }) }),
  syncSource: (id: string) => call<void>(`/sources/${id}/sync`, { method: 'POST' }),
  deleteSource: (id: string) => call<void>(`/sources/${id}`, { method: 'DELETE' }),
  accounts: () => call<Account[]>('/accounts'),
  setSubscriptionCard: (id: string, isSubscriptionCard: boolean) =>
    call<void>(`/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ isSubscriptionCard }) }),
  catalog: () => call<CatalogEntry[]>('/catalog'),
};
