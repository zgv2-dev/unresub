import { useRef, useState, type PointerEvent } from 'react';
import { Icon } from './Icon.tsx';

type Props = { text: string; onUndo: () => void; onDismiss: () => void };

/** Undo toast. Swipe it sideways or down to dismiss; a short swipe snaps back. The × does the same with a mouse or keyboard. */
export const Toast = ({ text, onUndo, onDismiss }: Props) => {
  const [off, setOff] = useState({ x: 0, y: 0 });
  const [leaving, setLeaving] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ x: number; y: number; id: number } | null>(null);

  const onDown = (e: PointerEvent) => {
    if ((e.target as Element).closest('button')) return;
    drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    // Sideways follows the finger; vertically only downwards, with resistance upwards.
    const dy = e.clientY - d.y;
    setOff({ x: e.clientX - d.x, y: dy > 0 ? dy : dy / 4 });
  };
  const onUp = () => {
    if (!drag.current) return;
    drag.current = null;
    const { x, y } = off;
    if (Math.abs(x) > 80) setLeaving({ x: Math.sign(x) * 500, y });
    else if (y > 40) setLeaving({ x, y: 200 });
    else setOff({ x: 0, y: 0 });
  };

  const pos = leaving ?? off;
  const dragging = !!drag.current;
  return (
    <div
      className="toast"
      role="status"
      style={{
        transform: `translate(calc(-50% + ${pos.x}px), ${pos.y}px)`,
        opacity: leaving ? 0 : 1 - Math.min(0.6, Math.abs(pos.x) / 300),
        transition: dragging ? 'none' : 'transform 0.22s ease, opacity 0.22s ease',
        touchAction: 'none',
      }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onTransitionEnd={() => leaving && onDismiss()}
    >
      <span>{text}</span>
      <button onClick={onUndo}>Undo</button>
      <button className="toast-close" onClick={onDismiss} aria-label="Dismiss"><Icon name="x" size={16} /></button>
    </div>
  );
};
