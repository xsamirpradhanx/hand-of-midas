import React, { useState } from 'react';
import { useBrokerStatus } from '../../hooks/useBrokerStatus';
import styles from './BrokerStatusBanner.module.css';

const LABELS: Record<string, string> = { schwab: 'Schwab', etrade: 'E*TRADE' };

/**
 * Standing notice that a brokerage connection is down.
 *
 * Replaces the repeating fallback toast for this case. When a refresh grant is
 * revoked EVERY request falls back, so the toast re-fired every few seconds
 * indefinitely and offered nothing to act on. One persistent, dismissible
 * banner states the condition once and names the fix.
 */
export const BrokerStatusBanner: React.FC = () => {
  const { status, refresh } = useBrokerStatus();
  const [dismissed, setDismissed] = useState<string[]>([]);

  const down = (status?.brokers ?? []).filter(
    b => b.needsReauth && !dismissed.includes(b.broker),
  );
  if (down.length === 0) return null;

  return (
    <div className={styles.wrapper}>
      {down.map(b => (
        <div key={b.broker} className={styles.banner} role="status">
          <span className={styles.icon} aria-hidden="true">⚠️</span>
          <div className={styles.content}>
            <strong className={styles.title}>
              {LABELS[b.broker] ?? b.broker} disconnected
            </strong>
            <span className={styles.detail}>
              {b.reason ?? 'Re-authorization required.'} Market data is being served
              from Yahoo in the meantime.
            </span>
          </div>
          <div className={styles.actions}>
            <button type="button" className={styles.retry} onClick={refresh}>
              Recheck
            </button>
            <button
              type="button"
              className={styles.dismiss}
              aria-label={`Dismiss ${b.broker} notice`}
              onClick={() => setDismissed(d => [...d, b.broker])}
            >
              ✕
            </button>
          </div>
        </div>
      ))}
    </div>
  );
};
