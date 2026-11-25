import { useEffect, type ReactNode } from 'react';
import { useBackToClose } from '../nav.ts';
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
