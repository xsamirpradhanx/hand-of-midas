import React, { useState, useEffect } from 'react';
import { OptionsChainTable } from './OptionsChainTable';
import { OptionsMetrics } from './OptionsMetrics';
import { ErrorBoundary } from '../ErrorBoundary';
import { api } from '../../lib/api';
import styles from './OptionsDashboard.module.css';
import chainStyles from './OptionsChainTable.module.css';

interface Props {
  symbol: string;
}

type Tab = 'chain' | 'metrics';

export const OptionsDashboard: React.FC<Props> = ({ symbol }) => {
  const [activeTab, setActiveTab] = useState<Tab>('chain');
  const [expirations, setExpirations] = useState<string[]>([]);
  const [activeExpiry, setActiveExpiry] = useState<string | null>(null);

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
            <OptionsChainTable symbol={symbol} activeExpiry={activeExpiry} underlyingPrice={0} />
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
      </div>
    </div>
  );
};
