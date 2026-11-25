import { Capacitor, registerPlugin } from '@capacitor/core';
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type { Alert, DetectionStatus, Period } from '@unresub/core';

const SERVER_KEY = 'unresub.server';
const TOKEN_KEY = 'unresub.session';

/** True inside the Android app (Capacitor WebView), where the server is remote and chosen at sign-in. */
export const isNative = Capacitor.isNativePlatform();

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
  passkeys?: number;
}

export interface AuthStatus {
  setupRequired: boolean;
  legacyData: boolean;
  signup: 'invite' | 'open';
  user: User | null;
  /** Signed in, but must add a passkey before anything else (recovery, re-enrol link, old password account). */
  mustEnrol: boolean;
  csrfToken: string | null;
}

export interface SignedIn {
  user: User;
  mustEnrol: boolean;
  csrfToken: string | null;
  token?: string;
  /** Shown once, right after the account (or its first passkey) is created. */
  recoveryCodes?: string[] | null;
}

export interface Passkey {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  synced: boolean;
}

type Options = { flowId: string; options: Record<string, any> };

// The browser uses WebAuthn directly. The Android app can't (its WebView origin is https://localhost),
// so it goes through the native Credential Manager plugin (MainActivity's PasskeyPlugin).
const NativePasskey = registerPlugin<{
  create(o: { requestJson: string }): Promise<{ responseJson: string }>;
  get(o: { requestJson: string }): Promise<{ responseJson: string }>;
}>('Passkey');

// The app's WebView ignores <a download> with blob URLs, so it saves through the system picker (SaveFilePlugin).
const NativeSaveFile = registerPlugin<{
  save(o: { name: string; mime: string; text: string }): Promise<{ saved: boolean }>;
}>('SaveFile');

/** Saves text as a file: a download in the browser, the "Save as" picker in the app. False if cancelled. */
export const saveFile = async (name: string, text: string, mime = 'text/plain') => {
  if (isNative) {
    try {
      return (await NativeSaveFile.save({ name, mime, text })).saved;
    } catch (e) {
      if ((e as { code?: string }).code === 'UNIMPLEMENTED') throw new Error('Update the app to save files.');
      throw e;
    }
  }
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type: mime })), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  // Revoking right away cancels the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  return true;
};

const passkeyError = (e: unknown) => {
  const name = (e as { name?: string })?.name;
  const msg = (e as Error)?.message ?? String(e);
  if (name === 'NotAllowedError' || /cancel/i.test(msg)) return new Error('Passkey request cancelled.');
  if (name === 'InvalidStateError') return new Error('This device already has a passkey for this account.');
  return new Error(msg || 'Passkey failed');
};

const createPasskey = async (options: Record<string, any>) => {
  try {
    if (isNative) return JSON.parse((await NativePasskey.create({ requestJson: JSON.stringify(options) })).responseJson);
    return await startRegistration({ optionsJSON: options as any });
  } catch (e) {
    throw passkeyError(e);
  }
};

const usePasskey = async (options: Record<string, any>) => {
  try {
    if (isNative) return JSON.parse((await NativePasskey.get({ requestJson: JSON.stringify(options) })).responseJson);
    return await startAuthentication({ optionsJSON: options as any });
  } catch (e) {
    throw passkeyError(e);
  }
};

export const passkeysSupported = () => isNative || browserSupportsWebAuthn();

const client = isNative ? 'app' : 'web';
const signedIn = (r: SignedIn) => {
  csrfToken = r.csrfToken;
  if (r.token) setToken(r.token);
  return r;
};

export const auth = {
  status: async () => {
    const s = await call<AuthStatus>('/auth/status');
    csrfToken = s.csrfToken;
    return s;
  },
  /** Setup (first admin, with the setup code) or sign-up (open, or with an invite). */
  register: async (b: { username: string; setupCode?: string; invite?: string }) => {
    const { flowId, options } = await send<Options>('POST', '/auth/register/options', b);
    const response = await createPasskey(options);
    return signedIn(await send<SignedIn>('POST', '/auth/register/verify', { flowId, response, client }));
  },
  signIn: async () => {
    const { flowId, options } = await send<Options>('POST', '/auth/login/options', {});
    const response = await usePasskey(options);
    return signedIn(await send<SignedIn>('POST', '/auth/login/verify', { flowId, response, client }));
  },
  recover: (username: string, code: string) => send<SignedIn>('POST', '/auth/recover', { username, code, client }).then(signedIn),
  reenrol: (token: string) => send<SignedIn>('POST', '/auth/reenrol', { token, client }).then(signedIn),
  /** Accounts made before passkeys: one last password sign-in, only to add a passkey. */
  passwordOnce: (username: string, password: string) => send<SignedIn>('POST', '/auth/login', { username, password, client }).then(signedIn),
  logout: async () => {
    await send<void>('POST', '/auth/logout').catch(() => {});
    csrfToken = null;
    setToken(null);
  },
  /** Forget a session the server no longer accepts. */
  forget: () => ((csrfToken = null), setToken(null)),
  me: () => call<User & { recoveryCodesLeft: number }>('/me'),
  passkeys: () => call<Passkey[]>('/me/passkeys'),
  addPasskey: async (name?: string) => {
    const { flowId, options } = await send<Options>('POST', '/me/passkeys/options', {});
    const response = await createPasskey(options);
    return send<{ recoveryCodes: string[] | null }>('POST', '/me/passkeys/verify', { flowId, response, name });
  },
  renamePasskey: (id: string, name: string) => send<void>('PATCH', `/me/passkeys/${encodeURIComponent(id)}`, { name }),
  removePasskey: (id: string) => send<void>('DELETE', `/me/passkeys/${encodeURIComponent(id)}`),
  newRecoveryCodes: () => send<{ recoveryCodes: string[] }>('POST', '/me/recovery-codes', {}),
  deleteAccount: async () => {
    const { flowId, options } = await send<Options>('POST', '/me/confirm', {});
    const response = await usePasskey(options);
    await send<void>('DELETE', '/me', { flowId, response });
    setToken(null);
  },
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
  reenrolLink: (id: string) => send<{ token: string; expiresAt: number }>('POST', `/admin/users/${id}/reenrol`, {}),
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
  userStatus: 'confirmed' | null;
  /** active: charging; inactive: an expected charge didn't come; archived: by the user or after long silence. */
  lifecycle: 'active' | 'inactive' | 'archived';
  archivedBy: 'user' | 'auto' | null;
  archivedAt: number | null;
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
  /** Unlinked from a subscription by the user */
  excluded?: boolean;
  details?: TransactionDetails;
}

/** The rest of monobank's statement item; null when the bank didn't send it. Amounts in account-currency minor units. */
export interface TransactionDetails {
  bankId: string | null;
  originalMcc: number | null;
  commissionRate: number | null;
  cashbackAmount: number | null;
  /** Card balance right after this operation */
  balance: number | null;
  comment: string | null;
  receiptId: string | null;
  invoiceId: string | null;
  counterEdrpou: string | null;
  counterIban: string | null;
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
  iban?: string | null;
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
  archived: boolean;
  name: string | null;
  serviceId: string | null;
  period: Period | null;
  status: 'confirmed' | null;
  cancelUrl: string | null;
  notes: string | null;
  remindDays: number | null;
  mergedInto: string | null;
}>;

export const api = {
  subscriptions: () => call<SubscriptionsResponse>('/subscriptions'),
  updateSubscription: (key: string, patch: OverridePatch) =>
    call<void>(`/subscriptions/${encodeURIComponent(key)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  archive: (key: string, archived = true) => api.updateSubscription(key, { archived }),
  /** "Not a subscription": its charges go back to Transactions and detection stops proposing it. */
  dismiss: (key: string) => call<{ batch: string }>(`/subscriptions/${encodeURIComponent(key)}/dismiss`, { method: 'POST' }),
  undoDismiss: (batch: string) => call<void>(`/suppressions/${encodeURIComponent(batch)}`, { method: 'DELETE' }),
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
