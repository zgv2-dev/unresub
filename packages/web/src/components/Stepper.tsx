import { Icon } from './Icon.tsx';

/** Small number control instead of the native number input with its spinners. */
export const Stepper = ({ value, onChange, min = 0, max = 99, label, suffix }: { value: number; onChange: (v: number) => void; min?: number; max?: number; label: string; suffix?: string }) => {
  const set = (v: number) => onChange(Math.max(min, Math.min(max, v)));
  return (
    <div className="input stepper" role="group" aria-label={label}>
      <button type="button" onClick={() => set(value - 1)} disabled={value <= min} aria-label="Less"><Icon name="minus" size={16} /></button>
      <input
        className="num"
        inputMode="numeric"
        value={value}
        aria-label={label}
        onChange={e => set(Number(e.target.value.replace(/\D/g, '')) || 0)}
        onKeyDown={e => {
          if (e.key === 'ArrowUp') (e.preventDefault(), set(value + 1));
          if (e.key === 'ArrowDown') (e.preventDefault(), set(value - 1));
        }}
      />
      {suffix && <span className="faint small">{suffix}</span>}
      <button type="button" onClick={() => set(value + 1)} disabled={value >= max} aria-label="More"><Icon name="plus" size={16} /></button>
    </div>
  );
};
