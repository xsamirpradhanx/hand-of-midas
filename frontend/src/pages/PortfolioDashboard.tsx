import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import type { PortfolioSummary } from '../types';
import styles from './PortfolioDashboard.module.css';

const formatCurrency = (val: number) => 
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', signDisplay: 'auto' }).format(val);
const formatPercent = (val: number) => 
  new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: 'auto' }).format(val);

export const PortfolioDashboard: React.FC = () => {
  const [summary, setSummary] = useState<PortfolioSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Scenario state
  const [spotShock, setSpotShock] = useState<number>(0);
  const [ivShock, setIvShock] = useState<number>(0);
  const [scenarioPL, setScenarioPL] = useState<number | null>(null);

  // Modal state
  const [isModalOpen, setIsModalOpen] = useState(false);

  const fetchPortfolio = useCallback(async () => {
    try {
      setLoading(true);
      const data = await api.getPortfolioSummary();
      setSummary(data);
      setError(null);
    } catch (err) {
      console.error(err);
      setError('Failed to load portfolio');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPortfolio();
  }, [fetchPortfolio]);

  useEffect(() => {
    if (spotShock === 0 && ivShock === 0) {
      setScenarioPL(null);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const data = await api.runScenario(spotShock / 100, ivShock / 100);
        setScenarioPL(data.scenarioPL);
      } catch (err) {
        console.error('Scenario error', err);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [spotShock, ivShock]);

  const displaySummary = summary;

  if (loading && !summary) {
    return <div className={styles.container}>Loading portfolio...</div>;
  }
  if (error) {
    return <div className={styles.container}>{error}</div>;
  }
  if (!summary) return null;

  return (
    <div className={styles.container}>
      {/* A. Summary Cards Row */}
      <div className={styles.summaryCards}>
        <div className={styles.card}>
          <div className={styles.cardTitle}>Portfolio Value</div>
          <div className={styles.cardValue}>
            {formatCurrency(displaySummary?.totalValue || 0)}
            <span style={{ fontSize: '1rem', color: (displaySummary?.unrealizedPnL || 0) >= 0 ? '#00d4aa' : '#ff4d4d' }}>
              ({formatPercent(displaySummary?.unrealizedPnLPercent || 0)})
            </span>
          </div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardTitle}>Unrealized P/L</div>
          <div className={`${styles.cardValue} ${(displaySummary?.unrealizedPnL || 0) >= 0 ? styles.positive : styles.negative}`}>
            {formatCurrency(displaySummary?.unrealizedPnL || 0)}
          </div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardTitle}>Net Delta</div>
          <div className={styles.cardValue}>
            Δ {(displaySummary?.netDelta || 0).toFixed(2)}
          </div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardTitle}>Theta Decay / Day</div>
          <div className={`${styles.cardValue} styles.negative`}>
            Θ {formatCurrency(displaySummary?.netThetaPerDay || 0)}
          </div>
        </div>
      </div>

      {/* B. Positions Table */}
      <div className={styles.mainContent}>
        <div className={styles.tableHeader}>
          <h3>Positions</h3>
          <button className={styles.addButton} onClick={() => setIsModalOpen(true)}>+ Add Position</button>
        </div>
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Strategy</th>
                <th>Status</th>
                <th>P/L</th>
                <th>P/L %</th>
                <th>Δ</th>
                <th>Θ/day</th>
                <th>Current Value</th>
              </tr>
            </thead>
            <tbody>
              {displaySummary?.positions?.map(pos => {
                const isBullish = ['long_call', 'short_put'].includes(pos.strategy);
                const isBearish = ['long_put', 'short_call'].includes(pos.strategy);
                const strategyClass = isBullish ? styles.badgeBullish : isBearish ? styles.badgeBearish : styles.badgeNeutral;
                
                return (
                  <tr key={pos.id}>
                    <td><strong>{pos.symbol}</strong></td>
                    <td><span className={`${styles.badge} ${strategyClass}`}>{pos.strategy.replace('_', ' ')}</span></td>
                    <td>
                      <span className={`${styles.badge} ${pos.status === 'open' ? styles.badgeOpen : styles.badgeClosed}`}>
                        {pos.status}
                      </span>
                    </td>
                    <td className={pos.unrealizedPnL >= 0 ? styles.positive : styles.negative}>
                      {formatCurrency(pos.unrealizedPnL)}
                    </td>
                    <td className={pos.unrealizedPnL >= 0 ? styles.positive : styles.negative}>
                      {formatPercent(pos.currentValue && pos.currentValue !== pos.unrealizedPnL ? pos.unrealizedPnL / (pos.currentValue - pos.unrealizedPnL) : 0)}
                    </td>
                    <td>{pos.delta?.toFixed(2) || '0.00'}</td>
                    <td>{pos.theta?.toFixed(2) || '0.00'}</td>
                    <td>{formatCurrency(pos.currentValue)}</td>
                  </tr>
                );
              })}
              {(!displaySummary?.positions || displaySummary.positions.length === 0) && (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', padding: '32px' }}>
                    No positions found. Add one to get started.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* D. Scenario Simulator */}
      <div className={styles.scenarioPanel}>
        <h3>What-If Scenario</h3>
        <div className={styles.scenarioControls}>
          <div className={styles.sliderGroup}>
            <div className={styles.sliderHeader}>
              <span>Spot Price Shock</span>
              <span>{spotShock > 0 ? '+' : ''}{spotShock}%</span>
            </div>
            <input 
              type="range" 
              min="-50" max="50" step="1" 
              value={spotShock} 
              onChange={e => setSpotShock(Number(e.target.value))}
              className={styles.slider}
            />
          </div>
          <div className={styles.sliderGroup}>
            <div className={styles.sliderHeader}>
              <span>IV Shock</span>
              <span>{ivShock > 0 ? '+' : ''}{ivShock}%</span>
            </div>
            <input 
              type="range" 
              min="-50" max="50" step="5" 
              value={ivShock} 
              onChange={e => setIvShock(Number(e.target.value))}
              className={styles.slider}
            />
          </div>
          <div className={styles.scenarioResult}>
            <span className={styles.scenarioResultLabel}>Projected P/L Change</span>
            {scenarioPL !== null ? (
              <span className={`${styles.scenarioResultValue} ${scenarioPL >= 0 ? styles.positive : styles.negative}`}>
                {formatCurrency(scenarioPL)}
              </span>
            ) : (
              <span className={styles.scenarioResultValue}>$0.00</span>
            )}
          </div>
          <button className={styles.addButton} onClick={() => { setSpotShock(0); setIvShock(0); }}>Reset</button>
        </div>
      </div>

      {/* C. Add Position Modal */}
      {isModalOpen && (
        <div className={styles.modalOverlay}>
          <div className={styles.modal}>
            <div className={styles.modalHeader}>
              <h2>Add Position</h2>
              <button className={styles.closeButton} onClick={() => setIsModalOpen(false)}>&times;</button>
            </div>
            <div className={styles.modalBody}>
              <div className={styles.formRow}>
                <div className={styles.formGroup}>
                  <label>Symbol</label>
                  <input type="text" className={styles.input} placeholder="AAPL" style={{ textTransform: 'uppercase' }} />
                </div>
                <div className={styles.formGroup}>
                  <label>Type</label>
                  <select className={styles.select}>
                    <option value="option">Option</option>
                    <option value="stock">Stock</option>
                  </select>
                </div>
                <div className={styles.formGroup}>
                  <label>Strategy</label>
                  <select className={styles.select}>
                    <option value="long_call">Long Call</option>
                    <option value="long_put">Long Put</option>
                    <option value="short_call">Short Call</option>
                    <option value="short_put">Short Put</option>
                    <option value="vertical_spread">Vertical Spread</option>
                    <option value="straddle">Straddle</option>
                    <option value="strangle">Strangle</option>
                    <option value="iron_condor">Iron Condor</option>
                  </select>
                </div>
              </div>
              
              <div className={styles.legsContainer}>
                <div className={styles.legHeader}>
                  <span>Leg 1</span>
                </div>
                <div className={styles.formRow}>
                  <div className={styles.formGroup}>
                    <label>Strike</label>
                    <input type="number" className={styles.input} placeholder="150" />
                  </div>
                  <div className={styles.formGroup}>
                    <label>Expiry</label>
                    <input type="date" className={styles.input} />
                  </div>
                  <div className={styles.formGroup}>
                    <label>Type</label>
                    <select className={styles.select}>
                      <option value="call">Call</option>
                      <option value="put">Put</option>
                    </select>
                  </div>
                </div>
                <div className={styles.formRow}>
                  <div className={styles.formGroup}>
                    <label>Quantity (+/-)</label>
                    <input type="number" className={styles.input} placeholder="1" />
                  </div>
                  <div className={styles.formGroup}>
                    <label>Cost</label>
                    <input type="number" step="0.01" className={styles.input} placeholder="2.50" />
                  </div>
                </div>
                <button className={styles.addLegButton}>+ Add Another Leg</button>
              </div>

              <div className={styles.formRow}>
                <div className={styles.formGroup}>
                  <label>Open Date</label>
                  <input type="date" className={styles.input} />
                </div>
              </div>
              <div className={styles.formGroup}>
                <label>Notes</label>
                <textarea className={styles.textarea} rows={3} placeholder="Thesis or notes..." />
              </div>
            </div>
            <div className={styles.modalFooter}>
              <button className={styles.cancelButton} onClick={() => setIsModalOpen(false)}>Cancel</button>
              <button className={styles.submitButton} onClick={() => setIsModalOpen(false)}>Add Position</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
