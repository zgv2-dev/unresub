import { useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from './Icon.tsx';
import { Popover } from './Popover.tsx';

const monthFmt = new Intl.DateTimeFormat('uk-UA', { month: 'long', year: 'numeric' });
/** "листопад 2026 р." → "Листопад 2026" */
const monthTitle = (d: Date) => {
  const s = monthFmt.format(d).replace(/\s*р\.$/, '');
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const shortFmt = new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'short', year: 'numeric' });
const WEEKDAYS = [...Array(7)].map((_, i) => new Intl.DateTimeFormat('uk-UA', { weekday: 'short' }).format(new Date(2024, 0, 1 + i)));

/** 'YYYY-MM-DD' in local time, the same format as <input type="date">. */
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parse = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return y && m && d ? new Date(y, m - 1, d) : null;
};
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

type Props = { value: string; onChange: (v: string) => void; label: string; placeholder?: string; min?: string; max?: string };

/** Calendar date picker in the app's style; replaces <input type="date">. */
export const DatePicker = ({ value, onChange, label, placeholder = 'Any date', min, max }: Props) => {
  const [open, setOpen] = useState(false);
  const selected = parse(value);
  const [focus, setFocus] = useState<Date>(selected ?? new Date());
  const btn = useRef<HTMLButtonElement>(null);
  const grid = useRef<HTMLDivElement>(null);

  const allowed = (d: Date) => (!min || iso(d) >= min) && (!max || iso(d) <= max);
  const show = () => {
    setFocus(selected ?? new Date());
    setOpen(true);
    requestAnimationFrame(() => requestAnimationFrame(() => grid.current?.focus({ preventScroll: true })));
  };
  const close = () => (setOpen(false), btn.current?.focus());
  const pick = (d: Date) => {
    if (!allowed(d)) return;
    onChange(iso(d));
    close();
  };

  const first = new Date(focus.getFullYear(), focus.getMonth(), 1);
  const start = addDays(first, -((first.getDay() + 6) % 7)); // weeks start on Monday
  const days = [...Array(42)].map((_, i) => addDays(start, i));
  const today = iso(new Date());

  const onKey = (e: KeyboardEvent) => {
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (step[e.key]) setFocus(f => addDays(f, step[e.key]!));
    else if (e.key === 'PageUp') setFocus(f => new Date(f.getFullYear(), f.getMonth() - 1, f.getDate()));
    else if (e.key === 'PageDown') setFocus(f => new Date(f.getFullYear(), f.getMonth() + 1, f.getDate()));
    else if (e.key === 'Enter' || e.key === ' ') pick(focus);
    else return;
    e.preventDefault();
  };

  return (
    <>
      <button ref={btn} type="button" className={`input select-trigger ${open ? 'open' : ''}`} aria-haspopup="dialog" aria-expanded={open} aria-label={`${label}: ${selected ? shortFmt.format(selected) : placeholder}`} onClick={() => (open ? close() : show())}>
        <Icon name="calendar" size={16} className="faint" />
        <span className={selected ? 'select-value num' : 'select-value faint'}>{selected ? shortFmt.format(selected) : placeholder}</span>
        {selected && (
          <span
            role="button"
            tabIndex={0}
            className="select-clear"
            aria-label={`Clear ${label}`}
            onClick={e => (e.stopPropagation(), onChange(''))}
            onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), e.stopPropagation(), onChange(''))}
          >
            <Icon name="x" size={14} />
          </span>
        )}
      </button>
      {open && (
        <Popover anchor={btn} onClose={() => setOpen(false)} onEscape={close} title={label} width={300} fixed>
          <div className="cal">
            <div className="cal-head">
              <button type="button" className="icon-btn sm" onClick={() => setFocus(f => new Date(f.getFullYear(), f.getMonth() - 1, 1))} aria-label="Previous month"><Icon name="chevronLeft" size={16} /></button>
              <strong aria-live="polite">{monthTitle(focus)}</strong>
              <button type="button" className="icon-btn sm" onClick={() => setFocus(f => new Date(f.getFullYear(), f.getMonth() + 1, 1))} aria-label="Next month"><Icon name="chevron" size={16} /></button>
            </div>
            <div className="cal-grid" role="grid" tabIndex={0} ref={grid} onKeyDown={onKey} aria-label={monthFmt.format(focus)}>
              {WEEKDAYS.map(w => <span key={w} className="cal-wd" role="columnheader">{w}</span>)}
              {days.map(d => {
                const k = iso(d);
                return (
                  <button
                    key={k}
                    type="button"
                    tabIndex={-1}
                    role="gridcell"
                    disabled={!allowed(d)}
                    aria-selected={k === value}
                    className={[d.getMonth() !== focus.getMonth() && 'out', k === today && 'today', k === iso(focus) && 'focus'].filter(Boolean).join(' ')}
                    onClick={() => pick(d)}
                  >
                    {d.getDate()}
                  </button>
                );
              })}
            </div>
            <div className="cal-foot">
              <button type="button" className="btn ghost sm" onClick={() => (onChange(''), close())}>Clear</button>
              <button type="button" className="btn soft sm" onClick={() => pick(new Date())}>Today</button>
            </div>
          </div>
        </Popover>
      )}
    </>
  );
};
