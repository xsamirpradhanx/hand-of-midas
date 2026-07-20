import React, { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import styles from './AiInsightsPanel.module.css';

interface Props {
  symbol: string;
  activeExpiry: string | null;
}

export const AiInsightsPanel: React.FC<Props> = ({ symbol, activeExpiry }) => {
  const [insight, setInsight] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!symbol || !activeExpiry) return;
    
    let isMounted = true;
    setLoading(true);
    setError(null);
    setInsight(null);

    api.getAiInsights(symbol, activeExpiry)
      .then(res => {
        if (isMounted) setInsight(res.insight);
      })
      .catch(err => {
        if (isMounted) setError(err.message || 'Failed to fetch AI insights');
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    return () => { isMounted = false; };
  }, [symbol, activeExpiry]);

  if (!symbol || !activeExpiry) return null;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.aiIcon}>✨</span>
        <h3>AI Market Watcher</h3>
        <span className={styles.badge}>{symbol} @ {activeExpiry}</span>
      </div>
      
      <div className={styles.content}>
        {loading ? (
          <div className={styles.loading}>
            <div className={styles.spinner} />
            Generating options chain insights...
          </div>
        ) : error ? (
          <div className={styles.error}>{error}</div>
        ) : insight ? (
          <div className={styles.insightText}>{insight}</div>
        ) : (
          <div className={styles.empty}>No insights available for this expiry.</div>
        )}
      </div>
    </div>
  );
};
