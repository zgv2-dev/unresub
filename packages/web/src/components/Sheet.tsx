import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icon.tsx';

type Props = {
  onClose: () => void;
  label: string;
  /** Pinned at the top: icon, title, subtitle. The close button is added here. */
  head?: ReactNode;
  /** Pinned at the bottom, e.g. the Save button. */
  footer?: ReactNode;
  children: ReactNode;
};

/**
 * Open sheets share one history entry, so the Android back button (and browser back) closes the
 * top sheet instead of leaving the app. Closing with the X or backdrop pops that entry again.
 */
const stack: { close: () => void }[] = [];
let popping = false;
addEventListener('popstate', () => {
  const top = stack.at(-1);
  if (!top) return;
  popping = true;
  top.close();
  popping = false;
  // More sheets still open underneath: keep an entry for the next back press.
  queueMicrotask(() => stack.length && !history.state?.sheet && history.pushState({ sheet: true }, ''));
});

const useBackToClose = (onClose: () => void) => {
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    const entry = { close: () => latest.current() };
    stack.push(entry);
    if (!history.state?.sheet) history.pushState({ sheet: true }, '');
    return () => {
      stack.splice(stack.indexOf(entry), 1);
      if (popping) return;
      // Closed from the UI. Wait a tick: another sheet may open in its place and reuse the entry.
      setTimeout(() => !stack.length && history.state?.sheet && history.back(), 0);
    };
  }, []);
};

/**
 * Bottom sheet on phones, a floating side panel on desktop.
 * Head and footer stay put; only the body scrolls, with a thin inset scrollbar.
 */
export const Sheet = ({ onClose, label, head, footer, children }: Props) => {
  useBackToClose(onClose);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  return (
    <div className="backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={label} onClick={e => e.stopPropagation()}>
        <header className="sheet-top">
          <div className="sheet-grip" />
          <div className="sheet-head">
            {head}
            <button className="icon-btn sheet-close" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
          </div>
        </header>
        <div className="sheet-body">{children}</div>
        {footer && <footer className="sheet-foot">{footer}</footer>}
      </div>
    </div>
  );
};
