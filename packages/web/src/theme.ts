import { useEffect, useState } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'unresub.theme';
const read = (): ThemePref => {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
};

const apply = (pref: ThemePref) => {
  const root = document.documentElement;
  pref === 'system' ? root.removeAttribute('data-theme') : root.setAttribute('data-theme', pref);
  const dark = pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0a0b10' : '#f3f4f8');
};

apply(read());

export const useTheme = () => {
  const [pref, setPref] = useState<ThemePref>(read);
  useEffect(() => {
    apply(pref);
    try {
      pref === 'system' ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, pref);
    } catch {}
    if (pref !== 'system') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => apply('system');
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [pref]);
  const cycle = () => setPref(p => (p === 'system' ? 'light' : p === 'light' ? 'dark' : 'system'));
  return { pref, cycle };
};
