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
  const [showFactors, setShowFactors] = useState(false);

  useEffect(() => {
    if (!symbol) return;
    // Ignore a response that arrives after the user has moved to another symbol.
    //
    // Without this, switching tickers while a request is still in flight renders one
    // symbol's plan under another's name: the heading reads from the `symbol` prop
    // (already updated) while `data` holds whichever response resolved last. An
    // uncached plan takes ~1s to build, so clicking B while A is loading reliably
    // lets A land second and overwrite B. It reads as the engine inventing numbers,
    // but every value is real — just for the previous ticker.
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Drop the previous symbol's plan immediately so nothing stale is on screen
    // while the new one loads.
    setData(null);
    api.getPredictiveZones(symbol)
      .then(res => {
        if (cancelled) return;
        setData(res);
        setLoading(false);
      })
      .catch(err => {
        if (cancelled) return;
        console.error(err);
        setError('Failed to load trade plan');
        setLoading(false);
      });
    return () => { cancelled = true; };
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
        {/* A sound setup waiting on a pullback is not the same as no setup, so the
            badge reports readiness rather than collapsing both into "NO TRADE". */}
        <span
          className={`${styles.biasBadge} ${
            plan?.readiness === 'ACTIONABLE'
              ? (plan.bias === 'LONG' ? styles.long : styles.short)
              : plan?.readiness === 'WAITING' ? styles.waiting : styles.neutral
          }`}
          title={plan?.readiness === 'WAITING' ? `Valid setup at $${plan.trigger} — not actionable at the current price.` : undefined}
        >
          {plan?.readiness === 'WAITING'
            ? `WAITING · ${plan.potentialRewardRisk}R @ $${plan.trigger}`
            : plan?.readiness === 'NO SETUP'
              ? 'NO SETUP'
              : plan?.bias || thesis.bias.toUpperCase()}
        </span>
      </div>

      {plan && (
        <div className={styles.planGrid}>
          <div className={styles.card}>
            <span className={styles.label}>Archetype</span>
            <span className={styles.value}>{plan.archetype}</span>
          </div>
          <div
            className={styles.card}
            title={
              plan.bias === 'NO TRADE'
                ? 'The plan’s geometry if price reaches the trigger. Not actionable at the current price — see Why Now.'
                : undefined
            }
          >
            <span className={styles.label}>
              {plan.bias === 'NO TRADE' ? 'Reward:Risk (if triggered)' : 'Reward:Risk'}
            </span>
            <span className={styles.value}>
              {plan.bias === 'NO TRADE'
                ? `${plan.potentialRewardRisk ?? 0}R`
                : `${plan.rewardRisk}R`}
            </span>
          </div>
          <div
            className={styles.card}
            title="Composite evidence strength (bucket-weighted netBias with agreement penalty). This is NOT a win probability. See the Learning section for calibrated probability once sample size ≥ 5."
          >
            <span className={styles.label}>Signal Strength</span>
            <span className={styles.value}>{plan.confidence}%</span>
          </div>
        </div>
      )}

      {/*
        A plan whose levels came from a placeholder zone shows no levels.
        `geometryAnchored` is false when no structural demand (or supply) was
        found within reach, so trigger/entry/stop/targets were all derived from
        a fabricated band around spot. The prose already refused the trade
        ("an entry and a stop would have to be invented, so none are offered")
        while this panel rendered the invented numbers in the same style as
        real ones — and two external reviewers duly reasoned about them as if
        they were measured levels.
      */}
      {plan && plan.geometryAnchored === false && (
        <div className={styles.levelsSection}>
          <h4>Trade Parameters</h4>
          <p className={styles.levelLabel}>
            No levels are offered. There is no structural {plan.bias === 'SHORT' ? 'supply' : 'demand'} within
            reach to anchor an entry or an invalidation to, so any trigger, stop or target here
            would be invented rather than measured.
          </p>
        </div>
      )}

      {plan && plan.geometryAnchored !== false && (
        <div className={styles.levelsSection}>
          <h4>Trade Parameters</h4>
          {/*
            Both horizons are shown because only one of them is comparable to
            the target below it. `expectedMove` is a ONE-DAY figure; the target
            is a 20-bar structural level. Displaying the daily number alone
            directly above T1 reads as a contradiction — an $8 expected move
            beside a target $35 away — and it was read that way in review. The
            plan is consistent once the horizon is stated: over 20 bars a
            diffusive path covers ~sqrt(20)x the daily move.
          */}
          <div className={styles.levelRow}>
            <span className={styles.levelLabel}>Expected Move (1 day)</span>
            <span className={styles.levelValueTarget}>{(plan.bias === 'SHORT' || thesis.bias === 'bearish') ? '-' : '+'}${Math.abs(plan.expectedMove)}</span>
          </div>
          {plan.expectedMoveHorizon !== undefined && (
            <div className={styles.levelRow}>
              <span className={styles.levelLabel}>Expected Move (20-bar horizon)</span>
              <span className={styles.levelValueTarget}>{(plan.bias === 'SHORT' || thesis.bias === 'bearish') ? '-' : '+'}${Math.abs(plan.expectedMoveHorizon)}</span>
            </div>
          )}
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

      {thesis.factors?.length > 0 && (
        <div className={styles.factorsSection}>
          <button
            type="button"
            className={styles.factorsToggle}
            onClick={() => setShowFactors(prev => !prev)}
          >
            <h4 className={styles.factorsToggleHeading}>Active Factors ({thesis.factors.length})</h4>
            <span className={styles.factorsToggleIcon}>{showFactors ? '▲' : '▼'}</span>
          </button>
          {showFactors && (
            <div className={styles.factorsList}>
              {[...thesis.factors]
                .sort((a: any, b: any) => (b.weight || 0) - (a.weight || 0))
                .map((f: any, i: number) => (
                  <div key={`${f.factorName}-${i}`} className={styles.factorCard}>
                    <div className={styles.factorHeader}>
                      <span className={styles.factorName}>{f.factorName}</span>
                      <span
                        className={`${styles.factorBias} ${
                          f.bias === 'bullish' ? styles.factorBiasBull
                            : f.bias === 'bearish' ? styles.factorBiasBear
                            : styles.factorBiasNeutral
                        }`}
                      >
                        {f.bias} · {Math.round((f.weight || 0) * 100)}%
                      </span>
                    </div>
                    <p className={styles.factorReasoning}>{f.reasoning}</p>
                  </div>
                ))}
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
