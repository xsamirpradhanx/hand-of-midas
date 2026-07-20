import React, { useState } from 'react';
import { OptionsChainTable } from './OptionsChainTable';
import { OptionsMetrics } from './OptionsMetrics';
import styles from './OptionsDashboard.module.css';

interface Props {
  symbol: string;
}

type Tab = 'chain' | 'metrics';

export const OptionsDashboard: React.FC<Props> = ({ symbol }) => {
  const [activeTab, setActiveTab] = useState<Tab>('chain');

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
        </button>      </div>

      <div className={styles.content}>
        {activeTab === 'chain' && (
          <OptionsChainTable symbol={symbol} underlyingPrice={0} />
        )}
        {activeTab === 'metrics' && (
          <OptionsMetrics symbol={symbol} />
        )}
      </div>
    </div>
  );
};
