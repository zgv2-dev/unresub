import { useState, type FormEvent } from 'react';
import { setApiToken } from '../api.ts';
import { Icon } from './Icon.tsx';
import { ServiceIcon } from './ServiceIcon.tsx';

export const Logo = ({ size = 18 }: { size?: number }) => (
  <span className="brand-mark">
    <Icon name="refresh" size={size} strokeWidth={2.4} />
  </span>
);

const SAMPLE = [['anthropic', 'Claude'], ['spotify', 'Spotify'], ['netflix', 'Netflix'], ['discord', 'Discord'], ['youtube', 'YouTube']] as const;

export const Login = ({ onDone }: { onDone: () => void }) => {
  const [token, setToken] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setApiToken(token.trim());
    onDone();
  };
  return (
    <main className="login">
      <div className="login-hero">
        <Logo size={28} />
        <h1>UnReSub</h1>
        <p>Every subscription on your monobank cards, the next charge date, and what it really costs per month and per year.</p>
        <div className="login-floats">
          {SAMPLE.map(([id, name]) => <ServiceIcon key={id} serviceId={id} name={name} />)}
        </div>
      </div>
      <form onSubmit={submit} className="card pad stack">
        <label className="field">
          <span>Access token</span>
          <input className="input" type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="UNRESUB_API_TOKEN" autoFocus autoComplete="current-password" />
        </label>
        <button className="btn block" disabled={!token.trim()}>
          <Icon name="lock" size={18} /> Unlock
        </button>
        <p className="xs faint">The token is the UNRESUB_API_TOKEN value from your server's environment. It stays on this device.</p>
      </form>
    </main>
  );
};
