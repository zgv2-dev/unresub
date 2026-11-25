import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, auth, getServer, isNative, passkeysSupported, saveFile, setServer, type AuthStatus, type SignedIn } from '../api.ts';
import { Icon } from './Icon.tsx';
import { ServiceIcon } from './ServiceIcon.tsx';

export const Logo = ({ size = 18 }: { size?: number }) => (
  <span className="brand-mark">
    <Icon name="refresh" size={size} strokeWidth={2.4} />
  </span>
);

const SAMPLE = [['anthropic', 'Claude'], ['spotify', 'Spotify'], ['netflix', 'Netflix'], ['discord', 'Discord'], ['youtube', 'YouTube']] as const;

type Mode = 'signin' | 'setup' | 'signup' | 'recover' | 'password';

const param = (k: string) => new URLSearchParams(location.search).get(k) ?? '';
const clearParams = () => history.replaceState(null, '', location.pathname);

export const Shell = ({ children }: { children: ReactNode }) => (
  <main className="login">
    <div className="login-hero">
      <Logo size={28} />
      <h1>UnReSub</h1>
      <p>Every subscription on your monobank cards, the next charge date, and what it really costs per month and per year.</p>
      <div className="login-floats">
        {SAMPLE.map(([id, name]) => <ServiceIcon key={id} serviceId={id} name={name} />)}
      </div>
    </div>
    {children}
  </main>
);

/**
 * Sign-in with passkeys only. First run: create the admin with the setup code from the server
 * log. Invite links (?invite=) open sign-up; admin re-enrol links (?reenrol=) let someone add a
 * new passkey. In the Android app it first asks which server to use.
 */
export const Login = ({ status, onDone, onServerChange }: { status: AuthStatus | null; onDone: (r: SignedIn) => void; onServerChange: () => void }) => {
  const invite = param('invite');
  const [mode, setMode] = useState<Mode>(status?.setupRequired ? 'setup' : invite ? 'signup' : 'signin');
  const [username, setUsername] = useState('');
  const [setupCode, setSetupCode] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [server, setServerInput] = useState(getServer());
  const [editServer, setEditServer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needServer = isNative && (editServer || !getServer() || !status);

  const run = async (fn: () => Promise<SignedIn>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      clearParams();
      onDone(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // An admin's re-enrol link signs straight in, limited to adding a passkey.
  useEffect(() => {
    const token = param('reenrol');
    if (token && status && !needServer) void run(() => auth.reenrol(token));
  }, []);

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
      const st = e instanceof ApiError ? e.status : 0;
      setError(
        st === 0 ? `Can't reach ${url}. Check the address and your connection.`
        : st === 401 || st === 404 ? `${url} answers, but runs an older UnReSub. Update the server, then try again.`
        : `${url} answered with an error (${st}). Try again in a minute.`,
      );
    } finally {
      setBusy(false);
    }
  };

  if (needServer) {
    return (
      <Shell>
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
      </Shell>
    );
  }

  const canSignup = !status?.setupRequired && (status?.signup === 'open' || !!invite);
  const go = (m: Mode) => () => (setMode(m), setError(null));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const name = username.trim();
    if (mode === 'setup') return void run(() => auth.register({ username: name, setupCode: setupCode.trim() }));
    if (mode === 'signup') return void run(() => auth.register({ username: name, ...(invite && { invite }) }));
    if (mode === 'recover') return void run(() => auth.recover(name, code));
    if (mode === 'password') return void run(() => auth.passwordOnce(name, password));
    return void run(() => auth.signIn());
  };

  const usernameField = (
    <label className="field">
      <span>Username</span>
      <input className="input" value={username} onChange={e => setUsername(e.target.value)} autoFocus={mode !== 'setup'} autoComplete="username webauthn" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
    </label>
  );

  return (
    <Shell>
      <form onSubmit={submit} className="card pad stack">
        {!passkeysSupported() && <p className="small error">This browser can't use passkeys. Try a current Chrome, Safari, Firefox or Edge.</p>}

        {mode === 'signin' && (
          <>
            <strong>Sign in</strong>
            <p className="small muted">With the passkey on this device, your phone, or your password manager. No passwords.</p>
            <button className="btn block" disabled={busy}>
              <Icon name="key" size={18} /> {busy ? 'Waiting for passkey…' : 'Sign in with passkey'}
            </button>
          </>
        )}

        {(mode === 'setup' || mode === 'signup') && (
          <>
            <strong>{mode === 'setup' ? 'Create the admin account' : 'Create your account'}</strong>
            {mode === 'setup' && (
              <>
                <p className="small muted">First run. The setup code is printed in the server log{status?.legacyData ? ', and your existing data moves to this account' : ''}.</p>
                <label className="field">
                  <span>Setup code</span>
                  <input className="input" value={setupCode} onChange={e => setSetupCode(e.target.value)} autoFocus autoCapitalize="off" autoCorrect="off" spellCheck={false} />
                </label>
              </>
            )}
            {usernameField}
            <button className="btn block" disabled={busy || !username.trim() || (mode === 'setup' && !setupCode.trim())}>
              <Icon name="key" size={18} /> {busy ? 'Waiting for passkey…' : 'Create passkey'}
            </button>
            <p className="xs faint">Your device saves a passkey for this account. You'll get recovery codes in case you lose it.</p>
          </>
        )}

        {mode === 'recover' && (
          <>
            <strong>Lost your passkey?</strong>
            <p className="small muted">Use one of your recovery codes, then add a new passkey. No codes? Ask the admin for a passkey link.</p>
            {usernameField}
            <label className="field">
              <span>Recovery code</span>
              <input className="input" value={code} onChange={e => setCode(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder="xxxx-xxxx-xxxx" />
            </label>
            <button className="btn block" disabled={busy || !username.trim() || !code.trim()}>Continue</button>
          </>
        )}

        {mode === 'password' && (
          <>
            <strong>Account from before passkeys</strong>
            <p className="small muted">Your password works one last time, to add a passkey. Then it's deleted.</p>
            {usernameField}
            <label className="field">
              <span>Password</span>
              <input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" />
            </label>
            <button className="btn block" disabled={busy || !username.trim() || !password}>Continue</button>
          </>
        )}

        {error && <p className="small error" role="alert">{error}</p>}

        {mode !== 'setup' && (
          <div className="login-links">
            {mode !== 'signin' && <button type="button" className="btn ghost sm" onClick={go('signin')}>Sign in with passkey</button>}
            {mode !== 'signup' && canSignup && <button type="button" className="btn ghost sm" onClick={go('signup')}>Create an account</button>}
            {mode === 'signin' && <button type="button" className="btn ghost sm" onClick={go('recover')}>Lost your passkey?</button>}
            {mode === 'signin' && <button type="button" className="btn ghost sm" onClick={go('password')}>I had a password</button>}
          </div>
        )}
        {isNative && (
          <button type="button" className="btn ghost sm" onClick={() => setEditServer(true)}>
            Server: {getServer()} · change
          </button>
        )}
      </form>
    </Shell>
  );
};

/** Shown once after an account or its first passkey is created. */
export const RecoveryCodes = ({ codes, onDone }: { codes: string[]; onDone: () => void }) => {
  const [saved, setSaved] = useState(false);
  const text = `UnReSub recovery codes (${getServer() || location.origin})\nEach works once.\n\n${codes.join('\n')}\n`;
  const [err, setErr] = useState<string | null>(null);
  const download = () =>
    void saveFile('unresub-recovery-codes.txt', text).then(ok => ok && setSaved(true), e => setErr((e as Error).message));
  return (
    <Shell>
      <div className="card pad stack">
        <strong>Save your recovery codes</strong>
        <p className="small muted">If you lose every passkey, one of these gets you back in. Each works once. They won't be shown again.</p>
        <ul className="codes num">{codes.map(c => <li key={c}>{c}</li>)}</ul>
        <div className="sheet-actions">
          <button className="btn soft sm" onClick={() => void navigator.clipboard?.writeText(text).then(() => setSaved(true), download)}><Icon name="copy" size={16} /> Copy</button>
          <button className="btn soft sm" onClick={download}><Icon name="download" size={16} /> Download</button>
        </div>
        {err && <p className="error small">{err}</p>}
        <button className="btn block" onClick={onDone} disabled={!saved}>{saved ? "I've saved them" : 'Copy or download first'}</button>
      </div>
    </Shell>
  );
};

/** Signed in through recovery, a re-enrol link or an old password: add a passkey before anything else. */
export const Enrol = ({ username, onDone, onCancel }: { username: string; onDone: (codes: string[] | null) => void; onCancel: () => void }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone((await auth.addPasskey()).recoveryCodes);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell>
      <div className="card pad stack">
        <strong>Add a passkey, {username}</strong>
        <p className="small muted">UnReSub signs in with passkeys only. Create one now to continue.</p>
        <button className="btn block" onClick={() => void add()} disabled={busy}>
          <Icon name="key" size={18} /> {busy ? 'Waiting for passkey…' : 'Create passkey'}
        </button>
        {error && <p className="small error" role="alert">{error}</p>}
        <button className="btn ghost sm" onClick={onCancel}>Sign out</button>
      </div>
    </Shell>
  );
};
