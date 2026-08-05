import React, { useState, useEffect } from 'react';
import { OptionsChainTable } from './OptionsChainTable';
import { OptionsMetrics } from './OptionsMetrics';
import { OptionsOutcome } from './OptionsOutcome';
import { ErrorBoundary } from '../ErrorBoundary';
import { api } from '../../lib/api';
import styles from './OptionsDashboard.module.css';
import chainStyles from './OptionsChainTable.module.css';

/**
 * Returns true if the expiry date is a standard monthly expiry.
 * Monthly expirations fall on the 3rd Friday of the month (day 15–21).
 */
function isMonthlyExpiry(dateStr: string): boolean {
  const d = new Date(dateStr + 'T12:00:00Z');
  const day = d.getUTCDate();
  const dow = d.getUTCDay(); // 5 = Friday
  return dow === 5 && day >= 15 && day <= 21;
}

interface Props {
  symbol: string;
}

type Tab = 'chain' | 'metrics' | 'predictor';

export const OptionsDashboard: React.FC<Props> = ({ symbol }) => {
  const [activeTab, setActiveTab] = useState<Tab>('chain');
  const [expirations, setExpirations] = useState<string[]>([]);
  const [activeExpiry, setActiveExpiry] = useState<string | null>(null);
  const [underlyingPrice, setUnderlyingPrice] = useState<number>(0);
  const [highlightWhaleFlow, setHighlightWhaleFlow] = useState<boolean>(() => {
    try {
      return localStorage.getItem('options_highlight_whale_flow') !== 'false';
    } catch {
      return true;
    }
  });

  const toggleWhaleFlow = (checked: boolean) => {
    setHighlightWhaleFlow(checked);
    try {
      localStorage.setItem('options_highlight_whale_flow', String(checked));
    } catch (err) {
      console.warn(err);
    }
  };

  const [strikeDesc, setStrikeDesc] = useState<boolean>(() => {
    try {
      return localStorage.getItem('options_strike_desc') === 'true';
    } catch {
      return false;
    }
  });

  const toggleStrikeOrder = (checked: boolean) => {
    setStrikeDesc(checked);
    try {
      localStorage.setItem('options_strike_desc', String(checked));
    } catch (err) {
      console.warn(err);
    }
  };

  useEffect(() => {
    let isMounted = true;
    // Fetch expirations
    api.getOptionsChain(symbol)
      .then(res => {
        if (!isMounted) return;
        setExpirations(res.expirations);
        if (res.expirations.length > 0) {
          setActiveExpiry(res.expirations[0]);
        }
      })
      .catch(console.error);
    // Fetch underlying quote for ATM detection
    api.getQuote(symbol)
      .then(quote => {
        if (!isMounted) return;
        if (quote?.price) setUnderlyingPrice(quote.price);
      })
      .catch(console.error);
    return () => { isMounted = false; };
  }, [symbol]);

  return (
    <div className={styles.container}>
      <div className={styles.subTabBar}>
        <div className={styles.tabGroup}>
          <button
            className={`${styles.tab} ${activeTab === 'chain' ? styles.active : ''}`}
            onClick={() => setActiveTab('chain')}
          >
            Chain View
          </button>
          <button
            className={`${styles.tab} ${activeTab === 'metrics' ? styles.active : ''}`}
            onClick={() => setActiveTab('metrics')}
          >
            Institutional Metrics
          </button>
          <button
            className={`${styles.tab} ${activeTab === 'predictor' ? styles.active : ''}`}
            onClick={() => setActiveTab('predictor')}
          >
            Outcome Predictor
          </button>
        </div>

        <label className={styles.whaleToggleLabel} title="Highlight contracts with high unusual volume concentration & whale flow">
          <span className={styles.whaleToggleText}>🐋 Highlight Whale Flow</span>
          <input
            type="checkbox"
            className={styles.whaleToggleCheckbox}
            checked={highlightWhaleFlow}
            onChange={(e) => toggleWhaleFlow(e.target.checked)}
          />
        </label>

        <label
          className={styles.strikeOrderLabel}
          title="Toggle strike order: Ascending (low→high, industry standard) or Descending (high→low, matches chart Y-axis)"
        >
          <span className={styles.strikeOrderText}>
            {strikeDesc ? '↓' : '↑'} Strike Order ({strikeDesc ? 'Desc' : 'Asc'})
          </span>
          <input
            type="checkbox"
            className={styles.strikeOrderCheckbox}
            checked={strikeDesc}
            onChange={(e) => toggleStrikeOrder(e.target.checked)}
          />
        </label>
      </div>

      {expirations.length > 0 && (
        <div className={chainStyles.header}>
          {expirations.map(exp => {
            const isWeekly = !isMonthlyExpiry(exp);
            return (
              <button
                key={exp}
                className={`${chainStyles.expiryTab} ${activeExpiry === exp ? chainStyles.expiryTabActive : ''}`}
                onClick={() => setActiveExpiry(exp)}
              >
                {exp}
                {isWeekly && <span className={styles.weeklyBadge}>W</span>}
              </button>
            );
          })}
        </div>
      )}

      <div className={styles.content}>
        {activeTab === 'chain' && (
          <ErrorBoundary label="Options Chain" fallback={
            <div style={{ padding: '2rem', color: '#ff6b6b', textAlign: 'center' }}>
              Options data unavailable — API limit may have been reached.
            </div>
          }>
            <OptionsChainTable
              symbol={symbol}
              activeExpiry={activeExpiry}
              underlyingPrice={underlyingPrice}
              highlightWhaleFlow={highlightWhaleFlow}
              strikeDesc={strikeDesc}
            />
          </ErrorBoundary>
        )}
        {activeTab === 'metrics' && (
          <ErrorBoundary label="Institutional Metrics" fallback={
            <div style={{ padding: '2rem', color: '#ff6b6b', textAlign: 'center' }}>
              Options metrics unavailable — API limit may have been reached.
            </div>
          }>
            <OptionsMetrics symbol={symbol} activeExpiry={activeExpiry} />
          </ErrorBoundary>
        )}
        {activeTab === 'predictor' && (
          <ErrorBoundary label="Outcome Predictor" fallback={
            <div style={{ padding: '2rem', color: '#ff6b6b', textAlign: 'center' }}>
              Outcome Predictor unavailable — API limit may have been reached.
            </div>
          }>
            <OptionsOutcome symbol={symbol} activeExpiry={activeExpiry} />
          </ErrorBoundary>
        )}
      </div>
    </div>
  );
};
