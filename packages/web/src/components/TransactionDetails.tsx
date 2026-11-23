import { useState, type ReactNode } from 'react';
import { currencyAlpha, formatMoney, LOCAL_CURRENCY, mccCategory, toMajor } from '@unresub/core';
import type { Account, TransactionRow } from '../api.ts';
import { last4 } from '../format.ts';
import { CATEGORY_ICON, Icon } from './Icon.tsx';

const fullFmt = new Intl.DateTimeFormat('uk-UA', { dateStyle: 'long', timeStyle: 'medium' });

/** "1 USD = 41.2345 UAH": the foreign side is always the 1, so the number reads like a bank rate. */
export const impliedRate = (t: Pick<TransactionRow, 'amount' | 'accountCurrency' | 'operationAmount' | 'operationCurrency'>) => {
  if (t.operationCurrency === t.accountCurrency || !t.amount || !t.operationAmount) return null;
  const acct = toMajor(Math.abs(t.amount), t.accountCurrency);
  const op = toMajor(Math.abs(t.operationAmount), t.operationCurrency);
  const [base, quote, rate] = t.accountCurrency === LOCAL_CURRENCY || t.operationCurrency !== LOCAL_CURRENCY
    ? [t.operationCurrency, t.accountCurrency, acct / op]
    : [t.accountCurrency, t.operationCurrency, op / acct];
  return `1 ${currencyAlpha(base)} = ${rate.toLocaleString('uk-UA', { maximumFractionDigits: 4 })} ${currencyAlpha(quote)}`;
};

const Copy = ({ value, label }: { value: string; label: string }) => {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="icon-btn sm"
      title={`Copy ${label}`}
      aria-label={`Copy ${label}`}
      onClick={() => void navigator.clipboard?.writeText(value).then(() => (setDone(true), setTimeout(() => setDone(false), 1_500)))}
    >
      <Icon name={done ? 'check' : 'copy'} size={14} />
    </button>
  );
};

const Mono = ({ value, label }: { value: string; label: string }) => (
  <>
    <code className="kv-code">{value}</code>
    <Copy value={value} label={label} />
  </>
);

/** Everything monobank sent for one transaction, in the sheet/panel. */
export const TransactionDetails = ({ t, account }: { t: TransactionRow; account?: Account }) => {
  const d = t.details;
  const cat = mccCategory(t.mcc);
  const original = d?.originalMcc != null && d.originalMcc !== t.mcc ? mccCategory(d.originalMcc) : null;
  const foreign = t.operationCurrency !== t.accountCurrency;
  const rate = impliedRate(t);
  const sign = t.amount > 0 ? '+' : '−';

  const rows: [string, ReactNode][] = [
    ['Status', t.hold ? <span className="chip warn">Pending</span> : <span className="chip ok">Settled</span>],
    ['Date and time', fullFmt.format(t.time * 1000)],
    [
      'Category',
      <>
        <Icon name={CATEGORY_ICON[cat.id]} size={16} className="faint" /> {cat.label}
        {t.mcc != null && <span className="faint num">MCC {t.mcc}</span>}
      </>,
    ],
    ...(original
      ? [['Original category', <>{original.label} <span className="faint num">MCC {d!.originalMcc}</span></>] as [string, ReactNode]]
      : []),
    ['Amount on the card', <span className="num">{sign}{formatMoney(Math.abs(t.amount), t.accountCurrency)}</span>],
    ...(foreign
      ? [
          ['Original amount', <span className="num">{sign}{formatMoney(Math.abs(t.operationAmount), t.operationCurrency)}</span>] as [string, ReactNode],
          ['Rate', <span className="num">{rate ?? '—'}</span>] as [string, ReactNode],
        ]
      : []),
    ...(d?.commissionRate ? [['Commission', <span className="num">{formatMoney(d.commissionRate, t.accountCurrency)}</span>] as [string, ReactNode]] : []),
    ...(d?.cashbackAmount ? [['Cashback', <span className="num credit">+{formatMoney(d.cashbackAmount, t.accountCurrency)}</span>] as [string, ReactNode]] : []),
    ...(d?.balance != null ? [['Balance after', <span className="num">{formatMoney(d.balance, t.accountCurrency)}</span>] as [string, ReactNode]] : []),
    [
      'Card',
      account ? (
        <>
          {account.maskedPan ? `••${last4(account.maskedPan)}` : 'Account'}
          <span className="faint">{[account.type, currencyAlpha(account.currency)].filter(Boolean).join(' · ')}</span>
        </>
      ) : '—',
    ],
    ...(account?.iban ? [['Account IBAN', <Mono value={account.iban} label="account IBAN" />] as [string, ReactNode]] : []),
    ...(d?.comment ? [['Comment', <span className="pre">{d.comment}</span>] as [string, ReactNode]] : []),
    ...(t.counterName ? [['Counterparty', t.counterName] as [string, ReactNode]] : []),
    ...(d?.counterEdrpou ? [['Counterparty EDRPOU', <Mono value={d.counterEdrpou} label="EDRPOU" />] as [string, ReactNode]] : []),
    ...(d?.counterIban ? [['Counterparty IBAN', <Mono value={d.counterIban} label="counterparty IBAN" />] as [string, ReactNode]] : []),
    ...(d?.receiptId
      ? [[
          'Receipt',
          <>
            <Mono value={d.receiptId} label="receipt number" />
            <a className="btn ghost sm" href="https://check.gov.ua/" target="_blank" rel="noreferrer" title="Check the receipt on check.gov.ua with this number">
              check.gov.ua <Icon name="external" size={14} />
            </a>
          </>,
        ] as [string, ReactNode]]
      : []),
    ...(d?.invoiceId ? [['Invoice', <Mono value={d.invoiceId} label="invoice id" />] as [string, ReactNode]] : []),
    ['Bank description', <code className="kv-code">{t.description}</code>],
    ...(d?.bankId ? [['Transaction ID', <Mono value={d.bankId} label="transaction id" />] as [string, ReactNode]] : []),
  ];

  return (
    <>
      <div className="divider-title">Details</div>
      <dl className="kv">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {!d?.bankId && <p className="xs faint" style={{ marginTop: 8 }}>The bank sent no extra details for this transaction.</p>}
    </>
  );
};
