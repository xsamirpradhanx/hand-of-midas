import React, { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import styles from './TradePlanPanel.module.css';

interface TradePlanPanelProps {
  symbol: string;
}

export const TradePlanPanel: React.FC<TradePlanPanelProps> = ({ symbol }) => {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!symbol) return;
    setLoading(true);
    setError(null);
    api.getPredictiveZones(symbol)
      .then(res => {
        setData(res);
        setLoading(false);
      })
      .catch(err => {
        console.error(err);
        setError('Failed to load trade plan');
        setLoading(false);
      });
  }, [symbol]);

  if (loading) {
    return <div className={styles.loading}>Generating AI Trade Plan...</div>;
  }
  if (error) {
    return <div className={styles.error}>{error}</div>;
  }
  if (!data || !data.aiThesis) {
    return <div className={styles.empty}>No Trade Plan available.</div>;
  }

  const thesis = data.aiThesis;
  const plan = thesis.tradePlan;

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <h3>AI Trade Plan for {symbol}</h3>
        <span className={`${styles.biasBadge} ${plan?.bias === 'LONG' ? styles.long : plan?.bias === 'SHORT' ? styles.short : styles.neutral}`}>
          {plan?.bias || thesis.bias.toUpperCase()}
        </span>
      </div>

      {plan && (
        <div className={styles.planGrid}>
          <div className={styles.card}>
            <span className={styles.label}>Archetype</span>
            <span className={styles.value}>{plan.archetype}</span>
          </div>
          <div className={styles.card}>
            <span className={styles.label}>Reward:Risk</span>
            <span className={styles.value}>{plan.rewardRisk}R</span>
          </div>
          <div className={styles.card}>
            <span className={styles.label}>Conviction</span>
            <span className={styles.value}>{plan.confidence}%</span>
          </div>
        </div>
      )}

      {plan && (
        <div className={styles.levelsSection}>
          <h4>Trade Parameters</h4>
          <div className={styles.levelRow}>
            <span className={styles.levelLabel}>Expected Move</span>
            <span className={styles.levelValueTarget}>{(plan.bias === 'SHORT' || thesis.bias === 'bearish') ? '-' : '+'}${Math.abs(plan.expectedMove)}</span>
          </div>
          <div className={styles.levelRow}>
            <span className={styles.levelLabel}>T1 (Major {(plan.bias === 'SHORT' || thesis.bias === 'bearish') ? 'Support' : 'Resistance'})</span>
            <span className={styles.levelValueTarget}>${plan.majorResistance}</span>
          </div>
          <div className={styles.levelRow}>
            <span className={styles.levelLabel}>T2 (Stretch Target)</span>
            <span className={styles.levelValueTarget}>${plan.stretchTarget}</span>
          </div>
          <hr className={styles.divider} />
          <div className={styles.levelRow}>
            <span className={styles.levelLabel}>Trigger Price</span>
            <span className={styles.levelValueEntry}>${plan.trigger}</span>
          </div>
          <div className={styles.levelRow}>
            <span className={styles.levelLabel}>Entry Zone</span>
            <span className={styles.levelValueEntry}>{plan.entryZone}</span>
          </div>
          <div className={styles.levelRow}>
            <span className={styles.levelLabel}>Chase Price (Max)</span>
            <span className={styles.levelValueEntry}>${plan.chasePrice}</span>
          </div>
          <hr className={styles.divider} />
          <div className={styles.levelRow}>
            <span className={styles.levelLabel}>Stop Loss</span>
            <span className={styles.levelValueStop}>${plan.stop}</span>
          </div>
        </div>
      )}

      {data.zones && (
        <div className={styles.zonesSection}>
          <h4>Structural Zones</h4>
          {data.zones.map((z: any, i: number) => (
            <div key={i} className={styles.zoneCard}>
              <div className={styles.zoneHeader}>
                <span className={z.type === 'buy' ? styles.zoneLabelBuy : styles.zoneLabelSell}>
                  {z.type === 'buy' ? '🟢 DEMAND ZONE' : '🔴 SUPPLY ZONE'}
                </span>
                <span className={styles.zonePrice}>${z.priceBottom} – ${z.priceTop}</span>
              </div>
              <div className={styles.zoneConfluence}>
                <strong>Confluence ({z.confluence?.length || 0}):</strong> {z.confluence?.join(', ')}
              </div>
            </div>
          ))}
        </div>
      )}

      {plan && (
        <div className={styles.triggersSection}>
          <h4>Execution Context</h4>
          <div className={styles.triggerItem}>
            <span className={styles.triggerIcon}>⚡</span>
            <div className={styles.triggerContent}>
              <span className={styles.triggerTitle}>Why Now?</span>
              <p>{plan.whyNow}</p>
            </div>
          </div>
          <div className={styles.triggerItem}>
            <span className={styles.triggerIcon}>✅</span>
            <div className={styles.triggerContent}>
              <span className={styles.triggerTitle}>Confirmation</span>
              <p>{plan.confirmation}</p>
            </div>
          </div>
          <div className={styles.triggerItem}>
            <span className={styles.triggerIcon}>❌</span>
            <div className={styles.triggerContent}>
              <span className={styles.triggerTitle}>Invalidation</span>
              <p>{plan.invalidation}</p>
            </div>
          </div>
        </div>
      )}

      {thesis.priceRationale && (
        <div className={styles.triggersSection}>
          <h4>Price Thesis</h4>
          <div className={styles.triggerItem}>
            <span className={styles.triggerIcon}>🎯</span>
            <div className={styles.triggerContent}>
              <span className={styles.triggerTitle}>Why this price?</span>
              <p>{thesis.priceRationale.explanation}</p>
            </div>
          </div>
          {thesis.priceRationale.targetSources?.length > 0 && (
            <div className={styles.triggerItem}>
              <span className={styles.triggerIcon}>🔎</span>
              <div className={styles.triggerContent}>
                <span className={styles.triggerTitle}>Supporting evidence</span>
                <p>{thesis.priceRationale.targetSources.join(', ')}</p>
              </div>
            </div>
          )}
        </div>
      )}

      {thesis.learning && (
        <div className={styles.triggersSection}>
          <h4>Self-Learning Calibration</h4>
          <div className={styles.triggerItem}>
            <span className={styles.triggerIcon}>🧠</span>
            <div className={styles.triggerContent}>
              <span className={styles.triggerTitle}>
                Calibrated scenario likelihood: {(thesis.learning.calibratedProbability * 100).toFixed(0)}% ({thesis.learning.reliability.toLowerCase()} evidence)
              </span>
              <p>{thesis.learning.explanation}</p>
            </div>
          </div>
        </div>
      )}

      {thesis.aiNarrative && (
        <div className={styles.synthesisSection}>
          <h4>AI Evidence Review</h4>
          <p className={styles.summaryText}>{thesis.aiNarrative}</p>
        </div>
      )}

      <div className={styles.synthesisSection}>
        <h4>AI Committee Synthesis</h4>
        <p className={styles.summaryText}>{thesis.summary}</p>
      </div>
    </div>
  );
};
