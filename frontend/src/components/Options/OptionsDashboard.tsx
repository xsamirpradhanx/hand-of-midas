import React, { useState, useEffect } from 'react';
import { OptionsChainTable } from './OptionsChainTable';
import { OptionsMetrics } from './OptionsMetrics';
import { OptionsOutcome } from './OptionsOutcome';
import { ErrorBoundary } from '../ErrorBoundary';
import { api } from '../../lib/api';
import styles from './OptionsDashboard.module.css';
import chainStyles from './OptionsChainTable.module.css';

interface Props {
  symbol: string;
}

type Tab = 'chain' | 'metrics' | 'predictor';

export const OptionsDashboard: React.FC<Props> = ({ symbol }) => {
  const [activeTab, setActiveTab] = useState<Tab>('chain');
  const [expirations, setExpirations] = useState<string[]>([]);
  const [activeExpiry, setActiveExpiry] = useState<string | null>(null);
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

  useEffect(() => {
    let isMounted = true;
    api.getOptionsChain(symbol)
      .then(res => {
        if (!isMounted) return;
        setExpirations(res.expirations);
        if (res.expirations.length > 0) {
          setActiveExpiry(res.expirations[0]);
        }
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
            Options Chain
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
      </div>

      {expirations.length > 0 && (
        <div className={chainStyles.header}>
          {expirations.map(exp => (
            <button
              key={exp}
              className={`${chainStyles.expiryTab} ${activeExpiry === exp ? chainStyles.expiryTabActive : ''}`}
              onClick={() => setActiveExpiry(exp)}
            >
              {exp}
            </button>
          ))}
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
              underlyingPrice={0}
              highlightWhaleFlow={highlightWhaleFlow}
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
