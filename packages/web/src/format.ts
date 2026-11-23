import { formatMoney, type Period } from '@unresub/core';

export const PERIOD_LABEL: Record<Period, string> = {
  weekly: 'Weekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  semiannual: 'Every 6 months',
  annual: 'Yearly',
};

export const PERIOD_SHORT: Record<Period, string> = {
  weekly: 'weekly',
  monthly: 'monthly',
  quarterly: 'quarterly',
  semiannual: 'half-yearly',
  annual: 'yearly',
};

export const dateFmt = new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'short' });
export const dateFmtYear = new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'short', year: 'numeric' });

export const fmtDate = (unix: number) => {
  const d = new Date(unix * 1000);
  return (d.getFullYear() === new Date().getFullYear() ? dateFmt : dateFmtYear).format(d);
};

export const daysUntil = (unix: number) => Math.ceil((unix * 1000 - Date.now()) / 86_400_000);

export const relative = (unix: number) => {
  const d = daysUntil(unix);
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d === -1) return 'yesterday';
  return d > 0 ? `in ${d} days` : `${-d} days ago`;
};

/** Splits "2 468,49 грн" into the whole part and the ",49 грн" tail so the hero can style cents. */
export const splitMoney = (minor: number, currency: number) => {
  const s = formatMoney(minor, currency);
  const m = s.match(/^(.*?)([,.]\d{2})(\D*)$/);
  return m ? { whole: m[1], cents: `${m[2]}${m[3]}` } : { whole: s, cents: '' };
};

export const fmtEta = (s: number) => (s < 90 ? `${s}s` : s < 5_400 ? `${Math.round(s / 60)} min` : `${(s / 3_600).toFixed(1)} h`);

export const last4 = (pan: string | null | undefined) => (pan ? pan.slice(-4) : null);

export const PERIOD_OPTIONS = (Object.keys(PERIOD_LABEL) as Period[]).map(value => ({ value, label: PERIOD_LABEL[value] }));
