import type { Alert, DetectionStatus, Period } from '@unresub/core';

const TOKEN_KEY = 'unresub.apiToken';
// Empty for the browser build (same origin). The Android build sets it to the server URL.
const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');

export const getApiToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
};
export const setApiToken = (t: string | null) => {
  try {
    t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY);
  } catch {}
};

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const res = await fetch(`${API_BASE}/api${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${getApiToken() ?? ''}`, 'Content-Type': 'application/json', ...init.headers },
  });
  if (!res.ok) {
    const msg = await res.json().then(b => b.error ?? b.message, () => res.statusText).catch(() => res.statusText);
    throw new ApiError(res.status, msg || res.statusText);
  }
  return res.status === 204 ? (undefined as T) : res.json();
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
