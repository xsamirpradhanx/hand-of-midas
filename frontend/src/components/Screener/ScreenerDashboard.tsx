import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { api } from '../../lib/api';
import styles from './ScreenerDashboard.module.css';

export interface ScreenerResult {
  symbol: string;
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  setupType: string;
  setupStage: 'EARLY' | 'DEVELOPING' | 'BREAKOUT' | 'EXTENDED' | 'BREAKDOWN';
  midasScore: number;
  longMomentum: number;
  shortMomentum: number;
  probability: number;
  riskScore: number;
  subScores: {
    momentumQuality: number;
    volumeConfirmation: number;
    extensionPenalty: number;
    catalystQuality: number;
    liquidity: number;
    riskInverse: number;
  };
  price: number;
  changePercent: number;
  relativeStrength?: number;
  volume: number;
  dollarVolume: number;
  rvol: number;
  pmVwap?: number | null;
  pmHigh?: number | null;
  pmLow?: number | null;
  floatTurnover?: number;
  rsi14?: number;
  shortFloatPct?: number;
  isGapUp?: boolean;
  isExtremeMover?: boolean;
  dataQuality: 'VERIFIED' | 'CHECK' | 'SUSPICIOUS';
  yahooSources: string[];
  yahooConsensus: number;
  reasons: string[];

  // P0 Engine Updates
  tradeScore: number;
  location: string;
  tradePlan?: {
    bias: 'LONG' | 'SHORT' | 'NO TRADE';
    archetype: string;
    entryZone: string;
    target1: number;
    target2?: number;
    stop: number;
    rewardRisk: number;
    confirmation: string;
    avoidIf: string;
    confidence: number;
  };
}

export type ScreenerMode = 'premarket' | 'open' | 'momentum' | 'highdemand';



function formatCurrency(val: number): string {
  if (val >= 1e9) return `$${(val / 1e9).toFixed(2)}B`;
  if (val >= 1e6) return `$${(val / 1e6).toFixed(2)}M`;
  if (val >= 1e3) return `$${(val / 1e3).toFixed(1)}K`;
  return `$${val.toFixed(0)}`;
}

function setupBadgeClass(setup: string): string {
  if (setup.includes('Breakout') || setup.includes('Gap')) return styles.setupBreakout!;
  if (setup.includes('Breakdown')) return styles.setupBreakdown!;
  if (setup.includes('Trend') || setup.includes('Momentum') || setup.includes('High RVOL') || setup.includes('Continuation')) return styles.setupTrend!;
  if (setup.includes('Volatility') || setup.includes('Squeeze')) return styles.setupVolatility!;
  if (setup.includes('Reversion') || setup.includes('Bounce') || setup.includes('Base')) return styles.setupReversion!;
  if (setup.includes('Gamma')) return styles.setupGamma!;
  return styles.setupDefault!;
}

function setupIcon(setup: string): string {
  if (setup.includes('Breakout') || setup.includes('Gap')) return '⚡';
  if (setup.includes('Breakdown')) return '📉';
  if (setup.includes('Trend') || setup.includes('High RVOL') || setup.includes('Continuation')) return '🌊';
  if (setup.includes('Volatility') || setup.includes('Squeeze')) return '🚀';
  if (setup.includes('Reversion') || setup.includes('Bounce') || setup.includes('Base')) return '🔄';
  if (setup.includes('Gamma')) return '🔮';
  if (setup.includes('Catalyst') || setup.includes('News')) return '📎';
  if (setup.includes('Momentum')) return '🔥';
  return '⭐';
}

function confidenceFillClass(score: number): string {
  if (score >= 90) return styles.midasGold!;
  if (score >= 70) return styles.midasSilver!;
  if (score >= 50) return styles.midasBronze!;
  if (score >= 30) return styles.midasRedLight!;
  if (score >= 15) return styles.midasRedMedium!;
  return styles.midasRedDeep!;
}

const ScreenerDashboard: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [mode, setMode] = useState<ScreenerMode>(location.state?.mode || 'open');
  const [results, setResults] = useState<ScreenerResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchScreenerData = useCallback(async (selectedMode: ScreenerMode) => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getScreener(selectedMode);
      setResults(Array.isArray(data) ? data : []);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load screener data';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchScreenerData(mode);
  }, [mode, fetchScreenerData]);

  const handleRowClick = useCallback((symbol: string) => {
    window.localStorage.setItem('dashboard_selectedSymbol', JSON.stringify(symbol));
    window.dispatchEvent(new CustomEvent('TICKER_SELECTED', { detail: { symbol } }));
    navigate('/');
  }, [navigate]);

  return (
    <div className={styles.page}>
      <div className={styles.glowA} aria-hidden />
      <div className={styles.glowB} aria-hidden />

      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Quantitative Screener</h1>
          <p className={styles.subtitle}>AI-driven real-time market setups</p>
        </div>

        <div className={styles.headerActions}>
          <div className={styles.modeToggle} role="tablist" aria-label="Market session">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'premarket'}
              className={`${styles.modeBtn} ${mode === 'premarket' ? styles.modeBtnActivePremarket : ''}`}
              onClick={() => setMode('premarket')}
            >
              Premarket (4A–9:30A)
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'open'}
              className={`${styles.modeBtn} ${mode === 'open' ? styles.modeBtnActiveOpen : ''}`}
              onClick={() => setMode('open')}
            >
              Open Market
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'momentum'}
              className={`${styles.modeBtn} ${mode === 'momentum' ? styles.modeBtnActiveMomentum : ''}`}
              onClick={() => setMode('momentum')}
            >
              🔥 Momentum $2–$20
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'highdemand'}
              className={`${styles.modeBtn} ${mode === 'highdemand' ? styles.modeBtnActiveHighDemand : ''}`}
              onClick={() => setMode('highdemand')}
            >
              🎯 Top Guns
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={false}
              className={styles.modeBtn}
              onClick={() => navigate('/screener/diagonal')}
            >
              📈 Diagonal Spreads
            </button>
          </div>

          <button
            type="button"
            className={styles.refreshBtn}
            onClick={() => fetchScreenerData(mode)}
            disabled={loading}
          >
            {loading ? (
              <>
                <span className={styles.spinner} aria-hidden />
                Scanning…
              </>
            ) : (
              <>↻ Refresh Scan</>
            )}
          </button>
        </div>
      </header>

      {error && <div className={styles.errorBanner}>{error}</div>}

      {!loading && results.length > 0 && (
        <div className={styles.topTradesContainer}>
          <div className={styles.topTradesSection}>
            <h2 className={styles.sectionTitle}>🏆 Today's Best Risk-Adjusted Setups</h2>
            <div className={styles.cardsGrid}>
              {results.filter(r => r.tradePlan && r.tradePlan.bias !== 'NO TRADE').slice(0, 3).map((result, idx) => (
                <div key={result.symbol} className={styles.tradeCard} onClick={() => handleRowClick(result.symbol)}>
                  <div className={styles.cardHeader}>
                    <span className={styles.cardRank}>{['🥇', '🥈', '🥉'][idx]} {result.symbol}</span>
                    <span className={styles.cardScore}>{result.opportunityScore} Opportunity</span>
                  </div>
                  <div className={styles.cardBody}>
                    <div>{result.setupType}</div>
                    <div style={{ color: 'var(--color-bullish)' }}>{result.tradePlan?.rewardRisk}R theoretical</div>
                    <div style={{ color: 'var(--color-text-dim)' }}>{result.tradePlan?.whyNow}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className={styles.avoidSection}>
            <h2 className={styles.sectionTitle}>🚫 Avoid</h2>
            <div className={styles.avoidList}>
              {results.filter(r => r.tradePlan && r.tradePlan.bias === 'NO TRADE').slice(0, 3).map(result => (
                <div key={result.symbol} className={styles.avoidItem}>
                  <strong>{result.symbol}</strong> — <span style={{ color: 'var(--color-text-dim)' }}>{result.tradePlan?.whyNow || 'No trade condition met.'}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      <div className={styles.panel}>
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <colgroup>
              <col className={styles.colSymbol} />
              <col className={styles.colSetup} />
              <col className={styles.colConfidence} />
              <col className={styles.colSetup} />
              <col className={styles.colPrice} />
              <col className={styles.colPrice} />
              <col className={styles.colPrice} />
              <col className={styles.colConfidence} />
              <col className={styles.colVolume} />
              <col className={styles.colChange} />
              <col className={styles.colDirection} />
            </colgroup>
            <thead className={styles.thead}>
              <tr>
                <th className={styles.th}>Ticker</th>
                <th className={styles.th}>Setup</th>
                <th className={styles.th}>Opportunity</th>
                <th className={styles.thRight}>Entry</th>
                <th className={styles.thRight}>Stop</th>
                <th className={styles.thRight}>T1</th>
                <th className={styles.thRight}>R:R</th>
                <th className={styles.th}>Location</th>
                <th className={styles.thRight}>RVOL</th>
                <th className={styles.thRight}>RS (vs SPY)</th>
                <th className={styles.th}>Sentiment</th>
              </tr>
            </thead>
            <tbody className={styles.tbody}>
              {results.map(result => {
                const isNoTrade = result.tradePlan?.bias === 'NO TRADE';
                return (
                <tr 
                  key={result.symbol} 
                  onClick={() => handleRowClick(result.symbol)}
                  style={{ cursor: 'pointer', opacity: isNoTrade ? 0.4 : 1.0 }}
                >
                  <td className={styles.td}>
                    <div className={styles.symbolCell}>
                      <span className={styles.symbolTicker} style={{ textDecoration: isNoTrade ? 'line-through' : 'none' }}>{result.symbol}</span>
                    </div>
                  </td>
                  <td className={styles.td}>
                    <span
                      className={`${styles.setupBadge} ${setupBadgeClass(result.setupType)}`}
                      title={result.setupStage}
                    >
                      <span aria-hidden>{setupIcon(result.setupType)}</span>
                      {result.setupType}
                    </span>
                  </td>
                  <td className={styles.td}>
                    <span className={styles.confidencePct}>{result.opportunityScore || '-'}</span>
                  </td>
                  <td className={styles.tdRight}>
                    <span className={styles.priceValue}>{isNoTrade ? '—' : result.tradePlan ? result.tradePlan.entryZone : '-'}</span>
                  </td>
                  <td className={styles.tdRight}>
                    <span className={styles.priceValue} style={{ color: 'var(--color-bearish)' }}>
                      {isNoTrade ? '—' : result.tradePlan?.stop ? `$${result.tradePlan.stop}` : '-'}
                    </span>
                  </td>
                  <td className={styles.tdRight}>
                    <span className={styles.priceValue} style={{ color: 'var(--color-bullish)' }}>
                      {isNoTrade ? '—' : result.tradePlan?.majorResistance ? `$${result.tradePlan.majorResistance}` : '-'}
                    </span>
                  </td>
                  <td className={styles.tdRight}>
                    <span className={styles.volumeMain}>
                      {result.tradePlan?.rewardRisk ? `${result.tradePlan.rewardRisk}R` : '-'}
                    </span>
                  </td>
                  <td className={styles.td}>
                    <span className={styles.locationText}>{result.location || '-'}</span>
                  </td>
                  <td className={styles.tdRight}>
                    <span className={styles.volumeRvol}>{result.rvol.toFixed(1)}x</span>
                  </td>
                  <td className={styles.tdRight}>
                    <span className={`${styles.changeMain} ${result.relativeStrength && result.relativeStrength >= 0 ? styles.positive : styles.negative}`}>
                      {result.relativeStrength !== undefined 
                        ? `${result.relativeStrength > 0 ? '+' : ''}${result.relativeStrength.toFixed(1)}%` 
                        : '-'}
                    </span>
                  </td>
                  <td className={styles.td}>
                    <span className={styles.locationText}>{result.sentimentScore ? `🟢 ${result.sentimentScore}` : '-'}</span>
                  </td>
                </tr>
              )})}

              {results.length === 0 && !loading && (
                <tr className={styles.emptyRow}>
                  <td colSpan={11}>
                    <p className={styles.emptyTitle}>No setups found</p>
                    <p className={styles.emptyHint}>
                      No names met the confidence threshold for this session. Try premarket mode or refresh
                      after the next scan cycle.
                    </p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default ScreenerDashboard;
