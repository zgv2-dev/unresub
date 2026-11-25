import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Back navigation over the History API. The Android app forwards its Back button to the WebView's
 * history (MainActivity), so the same entries serve Android Back and browser Back.
 *
 * - Open overlays (sheets, pickers) share one entry: Back closes the top one.
 * - Screens (tab, sub-view) push an entry per change: Back returns to the previous screen.
 * - At the first entry there is nothing to go back to, and Android leaves the app.
 */
type Entry = { sheet?: true; back?: { key: string; value: unknown }; [key: string]: unknown };
const current = (): Entry => history.state ?? {};

const overlays: { close: () => void }[] = [];
const screens = new Set<() => void>();
let popping = false;

addEventListener('popstate', () => {
  const top = overlays.at(-1);
  if (top) {
    popping = true;
    top.close();
    popping = false;
    // More overlays still open underneath: keep an entry for the next Back press.
    queueMicrotask(() => overlays.length && !current().sheet && history.pushState({ ...current(), sheet: true }, ''));
  }
  for (const sync of screens) sync();
});

/** Back closes this overlay. Closing it from the UI drops its entry again. */
export const useBackToClose = (onClose: () => void) => {
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    const entry = { close: () => latest.current() };
    overlays.push(entry);
    if (!current().sheet) history.pushState({ ...current(), sheet: true }, '');
    return () => {
      overlays.splice(overlays.indexOf(entry), 1);
      if (popping) return;
      // Closed from the UI. Wait a tick: another overlay may open in its place and reuse the entry.
      setTimeout(() => !overlays.length && current().sheet && history.back(), 0);
    };
  }, []);
};

/**
 * Screen state kept in history, e.g. the active tab. Changing it pushes an entry, so Back returns
 * to the previous value. `resets` are nested screen keys cleared on change (a tab's sub-view).
 */
export const useScreen = <T extends string>(key: string, initial: T, resets: string[] = []) => {
  const read = useCallback(() => (current()[key] as T | undefined) ?? initial, [key, initial]);
  const [value, setValue] = useState(read);

  useEffect(() => {
    const sync = () => setValue(read());
    screens.add(sync);
    return () => void screens.delete(sync);
  }, [read]);

  const go = useCallback(
    (next: T) => {
      const now = current();
      const from = read();
      if (next === from) return;
      // Going back to where we came from: pop instead of piling up entries.
      if (!now.sheet && now.back?.key === key && now.back.value === next) return history.back();
      const { sheet, ...rest } = now;
      const entry: Entry = { ...rest, [key]: next, back: { key, value: from } };
      for (const k of resets) delete entry[k];
      // Leaving from an open overlay: the screen change takes over the overlay's entry.
      if (sheet) history.replaceState(entry, '');
      else history.pushState(entry, '');
      setValue(next);
    },
    [key, read, resets],
  );

  return [value, go] as const;
};
