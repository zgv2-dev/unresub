import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Icon } from './Icon.tsx';
import { Popover } from './Popover.tsx';

export type Option<T extends string> = { value: T; label: string; hint?: string; icon?: ReactNode };

type Props<T extends string> = {
  value: T;
  onChange: (v: T) => void;
  options: Option<T>[];
  /** Accessible name and the phone sheet's title. */
  label: string;
  placeholder?: string;
  /** Adds a search box; on by default for long lists. */
  searchable?: boolean;
  className?: string;
};

/** Design-system replacement for <select>: popover on desktop, bottom sheet on phones, full keyboard support. */
export const Select = <T extends string>({ value, onChange, options, label, placeholder = 'Choose…', searchable, className = '' }: Props<T>) => {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const id = useId();
  const withSearch = searchable ?? options.length > 8;
  const current = options.find(o => o.value === value);

  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return n ? options.filter(o => `${o.label} ${o.hint ?? ''}`.toLowerCase().includes(n)) : options;
  }, [options, q]);

  const show = () => {
    setQ('');
    setActive(Math.max(0, options.findIndex(o => o.value === value)));
    setOpen(true);
  };
  const close = (focus = true) => {
    setOpen(false);
    if (focus) btn.current?.focus();
  };
  const pick = (o: Option<T>) => {
    onChange(o.value);
    close();
  };

  useEffect(() => {
    if (!open) return;
    // Wait for the popover to be placed. On phones skip the search box so the keyboard doesn't cover the list.
    const phone = matchMedia('(max-width: 639px)').matches;
    const f = requestAnimationFrame(() => (withSearch && !phone ? search.current : list.current)?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(f);
  }, [open, withSearch]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const onKey = (e: KeyboardEvent) => {
    const max = shown.length - 1;
    const moves: Record<string, () => number> = {
      ArrowDown: () => Math.min(max, active + 1),
      ArrowUp: () => Math.max(0, active - 1),
      Home: () => 0,
      End: () => max,
      PageDown: () => Math.min(max, active + 8),
      PageUp: () => Math.max(0, active - 8),
    };
    if (moves[e.key]) {
      e.preventDefault();
      setActive(moves[e.key]!());
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (shown[active]) pick(shown[active]);
    } else if (e.key === 'Tab') {
      close(false);
    } else if (!withSearch && e.key.length === 1) {
      // Type-ahead: jump to the next option starting with the letter.
      const k = e.key.toLowerCase();
      const from = shown.findIndex((o, i) => i > active && o.label.toLowerCase().startsWith(k));
      const i = from >= 0 ? from : shown.findIndex(o => o.label.toLowerCase().startsWith(k));
      if (i >= 0) setActive(i);
    }
  };

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`input select-trigger ${open ? 'open' : ''} ${className}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${current?.label ?? placeholder}`}
        onClick={() => (open ? close() : show())}
        onKeyDown={e => {
          if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
            e.preventDefault();
            show();
          }
        }}
      >
        {current?.icon}
        <span className={current ? 'select-value' : 'select-value faint'}>{current?.label ?? placeholder}</span>
        <Icon name="chevron" size={16} className="select-chevron" />
      </button>
      {open && (
        <Popover anchor={btn} onClose={() => close(false)} onEscape={() => close()} title={label} width={260}>
          {withSearch && (
            <div className="pop-search">
              <Icon name="search" size={16} />
              <input
                ref={search}
                className="input"
                value={q}
                onChange={e => (setQ(e.target.value), setActive(0))}
                onKeyDown={onKey}
                placeholder="Search"
                role="combobox"
                aria-expanded
                aria-controls={id}
                aria-activedescendant={shown[active] ? `${id}-${active}` : undefined}
              />
            </div>
          )}
          <ul
            ref={list}
            id={id}
            className="pop-list"
            role="listbox"
            aria-label={label}
            tabIndex={withSearch ? -1 : 0}
            aria-activedescendant={!withSearch && shown[active] ? `${id}-${active}` : undefined}
            onKeyDown={onKey}
          >
            {shown.map((o, i) => (
              <li
                key={o.value}
                id={`${id}-${i}`}
                data-i={i}
                role="option"
                aria-selected={o.value === value}
                className={i === active ? 'active' : ''}
                onPointerMove={() => setActive(i)}
                onClick={() => pick(o)}
              >
                {o.icon}
                <span className="pop-label">
                  {o.label}
                  {o.hint && <em>{o.hint}</em>}
                </span>
                {o.value === value && <Icon name="check" size={16} className="pop-check" />}
              </li>
            ))}
            {!shown.length && <li className="pop-empty" aria-disabled>Nothing found</li>}
          </ul>
        </Popover>
      )}
    </>
  );
};
