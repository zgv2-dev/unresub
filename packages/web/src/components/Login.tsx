import { useState, type FormEvent } from 'react';
import { ApiError, auth, getServer, isNative, setServer, type AuthStatus, type User } from '../api.ts';
import { Icon } from './Icon.tsx';
import { ServiceIcon } from './ServiceIcon.tsx';

export const Logo = ({ size = 18 }: { size?: number }) => (
  <span className="brand-mark">
    <Icon name="refresh" size={size} strokeWidth={2.4} />
  </span>
);

const SAMPLE = [['anthropic', 'Claude'], ['spotify', 'Spotify'], ['netflix', 'Netflix'], ['discord', 'Discord'], ['youtube', 'YouTube']] as const;

type Mode = 'setup' | 'login' | 'signup';

const inviteFromUrl = () => new URLSearchParams(location.search).get('invite') ?? '';

/**
 * Sign-in screen. First run: create the admin with the setup code from the server log.
 * In the Android app it also asks which server to use.
 */
export const Login = ({ status, onDone, onServerChange }: { status: AuthStatus | null; onDone: (u: User) => void; onServerChange: () => void }) => {
  const invite = inviteFromUrl();
  const [mode, setMode] = useState<Mode>(status?.setupRequired ? 'setup' : invite ? 'signup' : 'login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [setupCode, setSetupCode] = useState('');
  const [server, setServerInput] = useState(getServer());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editServer, setEditServer] = useState(false);
  const needServer = isNative && (editServer || !getServer() || !status);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const creds = { username: username.trim(), password };
      const user =
        mode === 'setup' ? await auth.setup({ ...creds, setupCode: setupCode.trim() })
        : mode === 'signup' ? await auth.signup({ ...creds, ...(invite && { invite }) })
        : await auth.login(creds);
      if (invite) history.replaceState(null, '', location.pathname);
      onDone(user);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** Checks the address before leaving this step, so a typo or an old server gets a clear message. */
  const connect = async (e: FormEvent) => {
    e.preventDefault();
    let url = server.trim().replace(/\/+$/, '');
    if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
    setServerInput(url);
    setServer(url);
    setBusy(true);
    setError(null);
    try {
      await auth.status();
      setEditServer(false);
      onServerChange();
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      setError(
        status === 0 ? `Can't reach ${url}. Check the address and your connection.`
        : status === 401 || status === 404 ? `${url} answers, but runs an older UnReSub without accounts. Update the server, then try again.`
        : `${url} answered with an error (${status}). Try again in a minute.`,
      );
    } finally {
      setBusy(false);
    }
  };

  const hero = (
    <div className="login-hero">
      <Logo size={28} />
      <h1>UnReSub</h1>
      <p>Every subscription on your monobank cards, the next charge date, and what it really costs per month and per year.</p>
      <div className="login-floats">
        {SAMPLE.map(([id, name]) => <ServiceIcon key={id} serviceId={id} name={name} />)}
      </div>
    </div>
  );

  if (needServer) {
    return (
      <main className="login">
        {hero}
        <form onSubmit={connect} className="card pad stack">
          <label className="field">
            <span>Your UnReSub server</span>
            <input className="input" type="url" inputMode="url" value={server} onChange={e => setServerInput(e.target.value)} placeholder="https://unresub.example.com" autoFocus autoCapitalize="off" autoCorrect="off" />
          </label>
          <button className="btn block" disabled={busy || !server.trim()}>
            <Icon name="chevron" size={18} /> {busy ? 'Checking…' : 'Continue'}
          </button>
          {error && <p className="small error" role="alert">{error}</p>}
          <p className="xs faint">The address where you or your family host UnReSub.</p>
        </form>
      </main>
    );
  }

  const title = mode === 'setup' ? 'Create the admin account' : mode === 'signup' ? 'Create your account' : 'Sign in';
  const canSignup = !status?.setupRequired && (status?.signup === 'open' || !!invite);

  return (
    <main className="login">
      {hero}
      <form onSubmit={submit} className="card pad stack">
        <strong>{title}</strong>
        {mode === 'setup' && (
          <>
            <p className="small muted">
              First run. The setup code is printed in the server log{status?.legacyData ? ', and your existing data moves to this account' : ''}.
            </p>
            <label className="field">
              <span>Setup code</span>
              <input className="input" value={setupCode} onChange={e => setSetupCode(e.target.value)} autoFocus autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            </label>
          </>
        )}
        <label className="field">
          <span>Username</span>
          <input className="input" value={username} onChange={e => setUsername(e.target.value)} autoFocus={mode !== 'setup'} autoComplete="username" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        </label>
        <label className="field">
          <span>Password</span>
          <input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={mode === 'login' ? undefined : 10} />
        </label>
        <button className="btn block" disabled={busy || !username.trim() || !password || (mode === 'setup' && !setupCode.trim())}>
          <Icon name="lock" size={18} /> {busy ? 'One moment…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
        {error && <p className="small error">{error}</p>}
        {mode !== 'setup' && canSignup && (
          <button type="button" className="btn ghost sm" onClick={() => (setMode(mode === 'login' ? 'signup' : 'login'), setError(null))}>
            {mode === 'login' ? 'New here? Create an account' : 'Have an account? Sign in'}
          </button>
        )}
        {isNative && (
          <button type="button" className="btn ghost sm" onClick={() => setEditServer(true)}>
            Server: {getServer()} · change
          </button>
        )}
      </form>
    </main>
  );
};
