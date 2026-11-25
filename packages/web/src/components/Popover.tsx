import { useEffect, useLayoutEffect, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useMedia } from '../hooks.ts';
import { useBackToClose } from '../nav.ts';

type Props = {
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** Escape closes only the popover, never the sheet underneath. Defaults to onClose. */
  onEscape?: () => void;
  /** Shown as the header of the bottom sheet on phones. */
  title: string;
  /** Minimum width; the panel grows to the anchor's width unless `fixed`. */
  width?: number | 'anchor';
  fixed?: boolean;
  children: ReactNode;
};

/**
 * Floating panel under (or above) its anchor on wide screens, bottom sheet on phones.
 * Rendered in a portal so it is never clipped by a scrolling sheet.
 */
export const Popover = ({ anchor, onClose, onEscape, title, width = 'anchor', fixed, children }: Props) => {
  const phone = useMedia('(max-width: 639px)');
  useBackToClose(onEscape ?? onClose);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; width: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    if (phone) return;
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      const w = width === 'anchor' ? r.width : fixed ? width : Math.max(width, r.width);
      const left = Math.min(Math.max(8, r.left), innerWidth - w - 8);
      const below = innerHeight - r.bottom - 12;
      const above = r.top - 12;
      setPos(
        below >= 280 || below >= above
          ? { left, top: r.bottom + 6, width: w, maxHeight: Math.min(360, below) }
          : { left, bottom: innerHeight - r.top + 6, width: w, maxHeight: Math.min(360, above) },
      );
    };
    place();
    addEventListener('resize', place);
    addEventListener('scroll', place, true);
    return () => {
      removeEventListener('resize', place);
      removeEventListener('scroll', place, true);
    };
  }, [anchor, phone, width, fixed]);

  useEffect(() => {
    if (phone) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (anchor.current?.contains(t) || (t as Element).closest?.('.pop')) return;
      onClose();
    };
    addEventListener('pointerdown', onDown, true);
    return () => removeEventListener('pointerdown', onDown, true);
  }, [anchor, onClose, phone]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      (onEscape ?? onClose)();
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, [onClose, onEscape]);

  if (phone) {
    return createPortal(
      <div className="backdrop pop-backdrop" onClick={onClose}>
        <div className="sheet pop pop-sheet" role="dialog" aria-label={title} onClick={e => e.stopPropagation()}>
          <div className="sheet-grip" />
          <div className="pop-title">{title}</div>
          {children}
        </div>
      </div>,
      document.body,
    );
  }
  if (!pos) return null;
  return createPortal(
    <div className="pop pop-float" style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: pos.width, maxHeight: pos.maxHeight }}>
      {children}
    </div>,
    document.body,
  );
};
