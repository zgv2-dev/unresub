import { useEffect, useState } from 'react';
import { admin, auth, getServer, type Invite, type Passkey, type User } from '../api.ts';
import { fmtDate } from '../format.ts';
import { Icon } from './Icon.tsx';
import { Sheet } from './Sheet.tsx';

/** Account: passkeys, recovery codes, export, sign out, delete. Admins also manage who can join. Admins never see others' bank data. */
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

  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [codesLeft, setCodesLeft] = useState<number | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const loadKeys = () => Promise.all([auth.passkeys(), auth.me()]).then(([p, me]) => (setPasskeys(p), setCodesLeft(me.recoveryCodesLeft)), () => {});
  useEffect(() => void loadKeys(), []);
  const addPasskey = () => run(async () => {
    const r = await auth.addPasskey();
    if (r.recoveryCodes) setCodes(r.recoveryCodes);
    await loadKeys();
  }, 'Passkey added.');
  const rename = (p: Passkey) => {
    const name = prompt('Passkey name', p.name)?.trim();
    if (name && name !== p.name) void run(() => auth.renamePasskey(p.id, name).then(loadKeys));
  };
  const remove = (p: Passkey) => confirm(`Remove "${p.name}"? You won't be able to sign in with it.`) && void run(() => auth.removePasskey(p.id).then(loadKeys));
  const newCodes = () => confirm('Make new recovery codes? The old ones stop working.') && void run(async () => {
    setCodes((await auth.newRecoveryCodes()).recoveryCodes);
    await loadKeys();
  });

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
  const deleteAccount = async () => {
    if (await run(() => auth.deleteAccount())) onLogout();
  };

  return (
    <Sheet
      onClose={onClose}
      label="Account"
      head={
        <>
          <span className="avatar static">{user.username.slice(0, 2).toUpperCase()}</span>
          <div>
            <h2>{user.username}</h2>
            <div className="muted small">{user.isAdmin ? 'Admin · ' : ''}since {fmtDate(user.createdAt)}</div>
          </div>
        </>
      }
    >
      {msg && <p className={`small ${msg.ok ? 'muted' : 'error'}`}>{msg.text}</p>}

      <div className="divider-title">Passkeys</div>
      <ul className="list card">
        {passkeys.map(p => (
          <li key={p.id} className="passkey-row">
            <Icon name="key" size={18} />
            <span>
              <strong className="clamp-1">{p.name}</strong>
              <span className="xs muted">{p.synced ? 'Synced · ' : ''}added {fmtDate(p.createdAt)}{p.lastUsedAt ? ` · used ${fmtDate(p.lastUsedAt)}` : ''}</span>
            </span>
            <button className="btn ghost sm" onClick={() => rename(p)} aria-label={`Rename ${p.name}`}><Icon name="pencil" size={16} /></button>
            {passkeys.length > 1 && <button className="btn ghost sm" onClick={() => remove(p)} aria-label={`Remove ${p.name}`}><Icon name="trash" size={16} /></button>}
          </li>
        ))}
      </ul>
      <div className="sheet-actions" style={{ marginTop: 10 }}>
        <button className="btn soft sm" onClick={() => void addPasskey()}><Icon name="plus" size={16} /> Add a passkey</button>
        <button className="btn ghost sm" onClick={newCodes}>New recovery codes{codesLeft != null ? ` (${codesLeft} left)` : ''}</button>
      </div>
      {codes && (
        <div className="fix-row" style={{ marginTop: 10, display: 'block' }}>
          <strong>Save these recovery codes. Each works once; they won't be shown again.</strong>
          <ul className="codes num">{codes.map(c => <li key={c}>{c}</li>)}</ul>
          <button className="btn soft sm" onClick={() => void navigator.clipboard?.writeText(codes.join('\n')).catch(() => {})}><Icon name="copy" size={16} /> Copy</button>
        </div>
      )}

      {user.isAdmin && <AdminPanel user={user} />}

      <div className="divider-title">Your data</div>
      <div className="sheet-actions">
        <button className="btn soft sm" onClick={() => void exportData()}><Icon name="download" size={16} /> Export</button>
        <button className="btn soft sm" onClick={onLogout}><Icon name="logout" size={16} /> Sign out</button>
        <button className="btn ghost sm" onClick={() => setDeleting(v => !v)}><Icon name="trash" size={16} /> Delete account</button>
      </div>
      {deleting && (
        <div className="stack" style={{ marginTop: 12 }}>
          <p className="small muted">This deletes your account, your bank connections and all your data on this server. It can't be undone. Confirm with your passkey.</p>
          <button className="btn danger sm" onClick={() => void deleteAccount()}>Delete everything</button>
        </div>
      )}
    </Sheet>
  );
};

const AdminPanel = ({ user }: { user: User }) => {
  const [users, setUsers] = useState<User[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [signup, setSignup] = useState<'invite' | 'open'>('invite');
  const [link, setLink] = useState<string | null>(null);
  const [linkLabel, setLinkLabel] = useState('Invite link, valid 7 days, one use');
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
      setLinkLabel('Invite link, valid 7 days, one use');
      await navigator.clipboard?.writeText(url).catch(() => {});
    });

  const reenrol = (u: User) =>
    act(async () => {
      const { token } = await admin.reenrolLink(u.id);
      const url = `${getServer() || location.origin}/?reenrol=${encodeURIComponent(token)}`;
      setLink(url);
      setLinkLabel(`Passkey link for ${u.username}, valid 24 hours, one use`);
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
              <span className="xs muted"> {u.isAdmin ? '· admin' : ''}{u.passkeys === 0 ? ' · no passkey yet' : ''}</span>
            </span>
            {u.id !== user.id && (
              <span className="fix-btns">
                <button className="btn ghost sm" onClick={() => void reenrol(u)} title="Link to add a new passkey" aria-label={`Passkey link for ${u.username}`}><Icon name="key" size={16} /></button>
                <button className="btn ghost sm" onClick={() => void act(() => admin.setAdmin(u.id, !u.isAdmin))}>{u.isAdmin ? 'Remove admin' : 'Make admin'}</button>
                <button className="btn ghost sm" onClick={() => confirm(`Delete ${u.username} and all their data?`) && void act(() => admin.deleteUser(u.id))} aria-label={`Delete ${u.username}`}><Icon name="trash" size={16} /></button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {link && (
        <div className="fix-row" style={{ marginTop: 8 }}>
          <span><strong>{linkLabel}</strong><em style={{ wordBreak: 'break-all' }}>{link}</em></span>
          <button className="btn ghost sm" onClick={() => void navigator.clipboard?.writeText(link)} aria-label="Copy"><Icon name="copy" size={16} /></button>
        </div>
      )}
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
          {!!pending.length && <p className="xs faint">{pending.length} unused invite{pending.length > 1 ? 's' : ''}.</p>}
        </div>
      )}
    </>
  );
};
