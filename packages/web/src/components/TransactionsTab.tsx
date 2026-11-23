import { useEffect, useMemo, useState } from 'react';
import { currencyAlpha, formatMoney, LOCAL_CURRENCY, matchService, mccCategory } from '@unresub/core';
import { api, type Account, type TransactionFilters, type TransactionRow } from '../api.ts';
import { dateFmtYear, last4 } from '../format.ts';
import { CATEGORY_ICON, Icon } from './Icon.tsx';
import { impliedRate } from './TransactionDetails.tsx';
import { ServiceIcon } from './ServiceIcon.tsx';
import { DatePicker } from './DatePicker.tsx';
import { Select } from './Select.tsx';

type Props = {
  accounts: Account[];
  /** Bumped by the parent after changes elsewhere (sync, new subscription) to refetch. */
  version: number;
  onOpenTransaction: (t: TransactionRow) => void;
};

const PAGE = 100;
const dayFmt = new Intl.DateTimeFormat('uk-UA', { weekday: 'short', day: 'numeric', month: 'long' });
const toUnix = (date: string, endOfDay = false) => (date ? Math.floor(new Date(`${date}T${endOfDay ? '23:59:59' : '00:00:00'}`).getTime() / 1000) : undefined);
const toMinor = (v: string) => (v.trim() && Number.isFinite(Number(v.replace(',', '.'))) ? Math.round(Number(v.replace(',', '.')) * 100) : undefined);

export const TransactionsTab = ({ accounts, version, onOpenTransaction }: Props) => {
  const [q, setQ] = useState('');
  const [account, setAccount] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [debit, setDebit] = useState(true);
  const [unassigned, setUnassigned] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [items, setItems] = useState<TransactionRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  const filters: TransactionFilters = useMemo(
    () => ({ q: q.trim() || undefined, account: account || undefined, from: toUnix(from), to: toUnix(to, true), min: toMinor(min), max: toMinor(max), debit, unassigned, limit: PAGE }),
    [q, account, from, to, min, max, debit, unassigned],
  );

  useEffect(() => {
    // Debounce typing in search and amount boxes.
    const t = setTimeout(() => {
      api.transactions(filters).then(r => (setItems(r.items), setTotal(r.total), setErr(null)), e => setErr((e as Error).message));
    }, 250);
    return () => clearTimeout(t);
  }, [filters, version]);

  const more = () => api.transactions({ ...filters, offset: items?.length ?? 0 }).then(r => setItems(v => [...(v ?? []), ...r.items]));

  const byDay = useMemo(() => {
    const groups: [string, TransactionRow[]][] = [];
    for (const t of items ?? []) {
      const day = dayFmt.format(t.time * 1000);
      const g = groups.at(-1);
      g?.[0] === day ? g[1].push(t) : groups.push([day, [t]]);
    }
    return groups;
  }, [items]);

  const cards = accounts.filter(a => a.maskedPan);
  const activeFilters = [account, from, to, min, max].filter(Boolean).length + (unassigned ? 1 : 0);

  return (
    <>
      <h1 className="page-title">Transactions</h1>

      <div className="txn-search">
        <label className="search-box">
          <Icon name="search" size={18} />
          <input className="input" type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Search merchant" aria-label="Search merchant" />
        </label>
        <button className={`icon-btn ${showFilters || activeFilters ? 'on' : ''}`} onClick={() => setShowFilters(v => !v)} aria-expanded={showFilters} aria-label="Filters">
          <Icon name="filter" size={18} />
          {!!activeFilters && <span className="badge-count">{activeFilters}</span>}
        </button>
      </div>

      <div className="chip-row">
        <button className="chip-btn" aria-pressed={debit} onClick={() => setDebit(v => !v)}>Charges only</button>
        <button className="chip-btn" aria-pressed={unassigned} onClick={() => setUnassigned(v => !v)}>Not in a subscription</button>
      </div>

      {showFilters && (
        <section className="card pad stack filters">
          <div className="field">
            <span>Card</span>
            <Select
              label="Card"
              value={account}
              onChange={setAccount}
              options={[{ value: '', label: 'All cards' }, ...cards.map(a => ({ value: a.id, label: `•••• ${last4(a.maskedPan)}`, hint: `${currencyAlpha(a.currency)} · ${a.type ?? 'card'}` }))]}
            />
          </div>
          <div className="grid-2">
            <div className="field"><span>From</span><DatePicker label="From" value={from} onChange={setFrom} max={to || undefined} /></div>
            <div className="field"><span>To</span><DatePicker label="To" value={to} onChange={setTo} min={from || undefined} /></div>
          </div>
          <div className="grid-2">
            <label className="field"><span>Amount from</span><input className="input num" inputMode="decimal" value={min} onChange={e => setMin(e.target.value)} placeholder="0" /></label>
            <label className="field"><span>Amount to</span><input className="input num" inputMode="decimal" value={max} onChange={e => setMax(e.target.value)} placeholder="any" /></label>
          </div>
          {!!activeFilters && (
            <button className="btn ghost sm" onClick={() => (setAccount(''), setFrom(''), setTo(''), setMin(''), setMax(''), setUnassigned(false))}>
              Clear filters
            </button>
          )}
        </section>
      )}

      {err && <p className="error small">{err}</p>}
      {!items && <div className="stack">{[0, 1, 2, 3, 4].map(i => <div key={i} className="skeleton" style={{ height: 60 }} />)}</div>}
      {items && !items.length && (
        <div className="card empty">
          <span className="svc"><Icon name="receipt" /></span>
          <strong style={{ color: 'var(--text)' }}>Nothing here</strong>
          <span className="small">Try another search or clear the filters.</span>
        </div>
      )}

      {byDay.map(([day, list]) => (
        <section key={day} className="section">
          <div className="section-head"><h2>{day}</h2></div>
          <ul className="list card">
            {list.map(t => <TxnRow key={t.id} t={t} account={accounts.find(a => a.id === t.accountId)} onOpen={() => onOpenTransaction(t)} />)}
          </ul>
        </section>
      ))}

      {items && items.length < total && (
        <div style={{ textAlign: 'center', marginTop: 12 }}>
          <button className="btn ghost sm" onClick={() => void more()}>Show more ({total - items.length})</button>
        </div>
      )}
    </>
  );
};

const TxnRow = ({ t, account, onOpen }: { t: TransactionRow; account?: Account; onOpen: () => void }) => {
  const foreign = t.operationCurrency !== t.accountCurrency;
  const credit = t.amount > 0;
  const cat = mccCategory(t.mcc);
  const d = t.details;
  return (
    <li>
      <button className="row-btn" onClick={onOpen}>
        <ServiceIcon serviceId={matchService(t.description)?.id ?? null} name={t.counterName || t.description} />
        <div className="row-main">
          <span className="row-title">{t.description}</span>
          <span className="row-meta">
            {new Date(t.time * 1000).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })}
            <> · <Icon name={CATEGORY_ICON[cat.id]} size={13} className="row-cat" /> {cat.label}</>
            {account?.maskedPan && <> · ••{last4(account.maskedPan)}</>}
            {t.counterName && t.counterName !== t.description && <> · {t.counterName}</>}
          </span>
          {d?.comment && <span className="row-meta row-comment">“{d.comment}”</span>}
          {(t.subscriptionKey || t.hold || !!d?.cashbackAmount || !!d?.commissionRate) && (
            <span className="chips">
              {t.hold && <span className="chip warn">Pending</span>}
              {t.subscriptionKey && <span className="chip ok">{t.subscriptionName}</span>}
              {!!d?.cashbackAmount && <span className="chip ok">+{formatMoney(d.cashbackAmount, t.accountCurrency)} cashback</span>}
              {!!d?.commissionRate && <span className="chip">{formatMoney(d.commissionRate, t.accountCurrency)} fee</span>}
            </span>
          )}
        </div>
        <div className="row-price num">
          <strong className={credit ? 'credit' : ''}>{credit ? '+' : '−'}{formatMoney(Math.abs(t.amount), t.accountCurrency)}</strong>
          {foreign && <span title={impliedRate(t) ?? undefined}>{formatMoney(Math.abs(t.operationAmount), t.operationCurrency)}</span>}
          {d?.balance != null && <span className="faint">bal. {formatMoney(d.balance, t.accountCurrency)}</span>}
        </div>
      </button>
    </li>
  );
};

export const fmtTxnDate = (unix: number) => dateFmtYear.format(unix * 1000);
