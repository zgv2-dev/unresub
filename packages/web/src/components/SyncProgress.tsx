import type { Source } from '../api.ts';
import { fmtEta, last4 } from '../format.ts';

const STATE_LABEL = { fetching: '', waiting_rate_limit: 'waiting for monobank', retrying: 'monobank is busy, retrying', idle: '' } as const;

/** Per-card history progress while a sync runs. */
export const SyncProgress = ({ src, compact }: { src: Source; compact?: boolean }) => {
  const { sync, progress = [] } = src;
  const pct = sync.total ? Math.round((sync.done / sync.total) * 100) : null;
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="toggle-row small">
        <span>
          <strong>{sync.phase === 'backfill' ? 'Loading history' : 'Checking new transactions'}</strong>
          {STATE_LABEL[sync.state] && <span className="muted"> · {STATE_LABEL[sync.state]}</span>}
        </span>
        <span className="muted num">{sync.etaSeconds != null ? `~${fmtEta(sync.etaSeconds)} left` : pct != null ? `${pct}%` : ''}</span>
      </div>
      {compact ? (
        <div className={`progress ${pct == null ? 'indeterminate' : ''}`}><i style={pct != null ? { width: `${pct}%` } : undefined} /></div>
      ) : (
        progress.map(p => {
          const w = p.monthsTotal ? Math.min(100, (p.monthsDone / p.monthsTotal) * 100) : 0;
          return (
            <div key={p.accountId} className="stack" style={{ gap: 5 }}>
              <div className="toggle-row xs">
                <span className="muted">{last4(p.maskedPan) ? `•••• ${last4(p.maskedPan)}` : p.type}{p.state === 'syncing' && ' · now'}{p.state === 'queued' && ' · queued'}</span>
                <span className="faint num">{p.state === 'done' ? 'done' : `${Math.floor(p.monthsDone)} of ${p.monthsTotal} months`}</span>
              </div>
              <div className={`progress ${p.state === 'syncing' && !w ? 'indeterminate' : ''}`}><i style={{ width: `${w}%` }} /></div>
            </div>
          );
        })
      )}
    </div>
  );
};
