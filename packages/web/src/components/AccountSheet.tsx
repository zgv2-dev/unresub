import { useEffect, useState, type FormEvent } from 'react';
import { admin, auth, getServer, type Invite, type User } from '../api.ts';
import { fmtDate } from '../format.ts';
import { Icon } from './Icon.tsx';
import { Sheet } from './Sheet.tsx';

/** Account: password, export, sign out, delete. Admins also manage who can join. Admins never see others' bank data. */
export const AccountSheet = ({ user, onClose, onLogout }: { user: User; onClose: () => void; onLogout: () => void }) => {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg({ ok: true, text: ok });
      return true;
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
      return false;
    }
  };

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => auth.changePassword(current, next), 'Password changed. Other devices were signed out.')) setCurrent(''), setNext('');
  };

  const exportData = () =>
    run(async () => {
      const data = await auth.exportData();
      const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })),
        download: `unresub-${user.username}.json`,
      });
      a.click();
      URL.revokeObjectURL(a.href);
    });

  const [deleting, setDeleting] = useState(false);
  const [confirmPw, setConfirmPw] = useState('');
  const deleteAccount = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => auth.deleteAccount(confirmPw))) onLogout();
  };

  return (
    <Sheet onClose={onClose} label="Account">
      <div className="sheet-head">
        <span className="avatar static">{user.username.slice(0, 2).toUpperCase()}</span>
        <div>
          <h2>{user.username}</h2>
          <div className="muted small">{user.isAdmin ? 'Admin · ' : ''}since {fmtDate(user.createdAt)}</div>
        </div>
        <button className="icon-btn sheet-close" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
      </div>

      {msg && <p className={`small ${msg.ok ? 'muted' : 'error'}`}>{msg.text}</p>}

      <div className="divider-title">Password</div>
      <form onSubmit={changePassword} className="stack">
        <input className="input" type="password" placeholder="Current password" value={current} onChange={e => setCurrent(e.target.value)} autoComplete="current-password" />
        <input className="input" type="password" placeholder="New password, 10+ characters" value={next} onChange={e => setNext(e.target.value)} autoComplete="new-password" minLength={10} />
        <button className="btn soft sm" disabled={!current || next.length < 10}>Change password</button>
      </form>

      {user.isAdmin && <AdminPanel user={user} />}

      <div className="divider-title">Your data</div>
      <div className="sheet-actions">
        <button className="btn soft sm" onClick={() => void exportData()}><Icon name="download" size={16} /> Export</button>
        <button className="btn soft sm" onClick={onLogout}><Icon name="logout" size={16} /> Sign out</button>
        <button className="btn ghost sm" onClick={() => setDeleting(v => !v)}><Icon name="trash" size={16} /> Delete account</button>
      </div>
      {deleting && (
        <form onSubmit={deleteAccount} className="stack" style={{ marginTop: 12 }}>
          <p className="small muted">This deletes your account, your bank connections and all your data on this server. It can't be undone.</p>
          <input className="input" type="password" placeholder="Password to confirm" value={confirmPw} onChange={e => setConfirmPw(e.target.value)} autoComplete="current-password" />
          <button className="btn danger sm" disabled={!confirmPw}>Delete everything</button>
        </form>
      )}
    </Sheet>
  );
};

const AdminPanel = ({ user }: { user: User }) => {
  const [users, setUsers] = useState<User[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [signup, setSignup] = useState<'invite' | 'open'>('invite');
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    Promise.all([admin.users(), admin.invites(), admin.settings()]).then(
      ([u, i, s]) => (setUsers(u), setInvites(i), setSignup(s.signup)),
      e => setError((e as Error).message),
    );
  useEffect(() => void load(), []);
  const act = (fn: () => Promise<unknown>) => fn().then(load, e => setError((e as Error).message));

  const invite = () =>
    act(async () => {
      const { code } = await admin.createInvite();
      // The web origin is the server; inside the app, use the server URL.
      const url = `${getServer() || location.origin}/?invite=${encodeURIComponent(code)}`;
      setLink(url);
      await navigator.clipboard?.writeText(url).catch(() => {});
    });

  const pending = invites.filter(i => !i.usedAt && i.expiresAt * 1000 > Date.now());

  return (
    <>
      <div className="divider-title">People on this server</div>
      {error && <p className="small error">{error}</p>}
      <ul className="list card">
        {users.map(u => (
          <li key={u.id} className="toggle-row" style={{ padding: '10px 14px' }}>
            <span>
              <strong>{u.username}</strong>
              <span className="xs muted"> {u.isAdmin ? '· admin' : ''}</span>
            </span>
            {u.id !== user.id && (
              <span className="fix-btns">
                <button className="btn ghost sm" onClick={() => void act(() => admin.setAdmin(u.id, !u.isAdmin))}>{u.isAdmin ? 'Remove admin' : 'Make admin'}</button>
                <button className="btn ghost sm" onClick={() => confirm(`Delete ${u.username} and all their data?`) && void act(() => admin.deleteUser(u.id))} aria-label={`Delete ${u.username}`}><Icon name="trash" size={16} /></button>
              </span>
            )}
          </li>
        ))}
      </ul>
      <p className="xs faint" style={{ margin: '8px 4px' }}>Each person's cards and subscriptions are private to them, admins included.</p>

      <label className="toggle-row small" style={{ padding: '4px' }}>
        <span>Anyone with the link can sign up</span>
        <span className="switch">
          <input type="checkbox" checked={signup === 'open'} onChange={e => void act(() => admin.setSignup(e.target.checked ? 'open' : 'invite'))} />
          <i />
        </span>
      </label>
      {signup === 'invite' && (
        <div className="stack" style={{ marginTop: 8 }}>
          <button className="btn soft sm" onClick={() => void invite()}><Icon name="plus" size={16} /> Invite someone</button>
          {link && (
            <div className="fix-row">
              <span><strong>Invite link, valid 7 days, one use</strong><em style={{ wordBreak: 'break-all' }}>{link}</em></span>
              <button className="btn ghost sm" onClick={() => void navigator.clipboard?.writeText(link)} aria-label="Copy"><Icon name="copy" size={16} /></button>
            </div>
          )}
          {!!pending.length && <p className="xs faint">{pending.length} unused invite{pending.length > 1 ? 's' : ''}.</p>}
        </div>
      )}
    </>
  );
};
