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

      <div className={styles.panel}>
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <colgroup>
              <col className={styles.colSymbol} />
              <col className={styles.colDirection} />
              <col className={styles.colSetup} />
              <col className={styles.colConfidence} />
              <col className={styles.colChange} />
              <col className={styles.colVolume} />
              <col className={styles.colVolume} />
              <col className={styles.colPrice} />
              <col className={styles.colPrice} />
              <col className={styles.colCatalysts} />
              <col className={styles.colConfidence} />
            </colgroup>
            <thead className={styles.thead}>
              <tr>
                <th className={styles.th}>Symbol</th>
                <th className={styles.th}>Direction</th>
                <th className={styles.th}>Setup</th>
                <th className={styles.th}>Midas</th>
                <th className={styles.thRight}>PM Gap</th>
                <th className={styles.thRight}>PM RVOL</th>
                <th className={styles.thRight}>$Vol</th>
                <th className={styles.thRight}>PM VWAP</th>
                <th className={styles.thRight}>PM High</th>
                <th className={styles.th}>Catalyst</th>
                <th className={styles.th}>Risk</th>
              </tr>
            </thead>
            <tbody className={styles.tbody}>
              {results.map(result => (
                <tr 
                  key={result.symbol} 
                  onClick={() => handleRowClick(result.symbol)}
                  style={{ cursor: 'pointer' }}
                >
                  <td className={styles.td}>
                    <div className={styles.symbolCell}>
                      <span className={styles.symbolTicker}>{result.symbol}</span>
                    </div>
                  </td>
                  <td className={styles.td}>
                    <span className={`${styles.directionBadge} ${result.direction === 'LONG' ? styles.directionLong : result.direction === 'SHORT' ? styles.directionShort : styles.directionNeutral}`}>
                      {result.direction === 'LONG' ? '🟢 LONG' : result.direction === 'SHORT' ? '🔴 SHORT' : '⚪ NEUTRAL'}
                    </span>
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
                    <div className={styles.confidenceCell} title={`Probability: ${result.probability}%\nMom. Quality: ${result.subScores.momentumQuality}\nVol. Conf: ${result.subScores.volumeConfirmation}\nExt. Penalty: ${result.subScores.extensionPenalty}\nCat. Quality: ${result.subScores.catalystQuality}\nLiquidity: ${result.subScores.liquidity}\nRisk Inverse: ${result.subScores.riskInverse}`}>
                      <span className={styles.confidencePct}>{result.midasScore}</span>
                      <div className={styles.confidenceBar}>
                        <div
                          className={`${styles.confidenceFill} ${confidenceFillClass(result.midasScore)}`}
                          style={{ width: `${result.midasScore}%` }}
                        />
                      </div>
                    </div>
                  </td>
                  <td className={styles.tdRight}>
                    <div className={styles.changeStack}>
                      <span
                        className={`${styles.changePill} ${
                          result.changePercent >= 0 ? styles.changeUp : styles.changeDown
                        }`}
                      >
                        {result.changePercent >= 0 ? '+' : ''}
                        {result.changePercent.toFixed(2)}%
                      </span>
                    </div>
                  </td>
                  <td className={styles.tdRight}>
                    <span className={styles.volumeRvol}>{result.rvol.toFixed(1)}x</span>
                  </td>
                  <td className={styles.tdRight}>
                    <span className={styles.volumeMain}>{formatCurrency(result.dollarVolume)}</span>
                  </td>
                  <td className={styles.tdRight}>
                    <div className={styles.vwapStack}>
                      <span className={styles.priceValue}>{result.pmVwap ? `$${result.pmVwap.toFixed(2)}` : '-'}</span>
                      {result.pmVwap && (
                        <span className={styles.vwapStatus}>
                          {result.price > result.pmVwap ? '(Above)' : '(Below)'}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className={styles.tdRight}>
                    <span className={styles.priceValue}>{result.pmHigh ? `$${result.pmHigh.toFixed(2)}` : '-'}</span>
                  </td>
                  <td className={`${styles.td} ${styles.catalystCell}`}>
                    <div className={styles.catalystList}>
                      {result.dataQuality === 'SUSPICIOUS' && (
                        <span className={`${styles.catalystTag} ${styles.catalystWarning}`}>
                          <span className={styles.catalystCheck} aria-hidden>🔴</span>
                          Data: SUSPICIOUS
                        </span>
                      )}
                      {result.yahooSources.length > 0 && result.yahooConsensus > 0 && (
                        <span className={`${styles.catalystTag} ${styles.catalystConsensus}`}
                          title={`Yahoo Consensus: ${result.yahooSources.length}\n${result.yahooSources.join('\n')}`}
                        >
                          <span className={styles.catalystCheck} aria-hidden>📊</span>
                          {result.yahooSources.filter(s => s !== 'essential_etf').length} Lists
                        </span>
                      )}
                      {result.isGapUp && (
                        <span className={`${styles.catalystTag} ${styles.catalystGap}`}>
                          <span className={styles.catalystCheck} aria-hidden>⚡</span>
                          Gap &amp; Go
                        </span>
                      )}
                      {result.reasons.map((reason, idx) => (
                        <span key={`${result.symbol}-${idx}`} className={styles.catalystTag}>
                          <span className={styles.catalystCheck} aria-hidden>
                            ✓
                          </span>
                          {reason}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className={styles.td}>
                    <div className={`${styles.riskCell} ${result.riskScore > 80 ? styles.riskHigh : result.riskScore > 50 ? styles.riskMed : styles.riskLow}`}>
                      <span className={styles.riskValue}>{result.riskScore}</span>
                      {result.riskScore > 80 && <span title="Extreme Risk">🔴</span>}
                      {result.riskScore <= 80 && result.riskScore > 50 && <span title="Elevated Risk">🟡</span>}
                    </div>
                  </td>
                </tr>
              ))}

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
