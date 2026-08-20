import React, { useState, useEffect, useCallback, useRef } from 'react';
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
  /** Always null — candidate quality rank, not a win probability. */
  probability: null;
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

  // P1 Engine Updates
  tradeScore: number;
  opportunityScore: number;
  location: string;
  sentimentScore?: number;
  
  // Phase 1 Statistical Metrics
  eventRisk: 'HIGH' | 'MEDIUM' | 'LOW';
  eventRiskReasons?: string[];
  marketRegime: string;
  triggerStatus: string;
  expectedR: number;
  adjustedEV: number;

  modelPT1: number;
  modelPStop: number;
  modelPTimeout: number;
  modelSampleSize: number;

  tradePlan?: {
    bias: 'LONG' | 'SHORT' | 'NO TRADE';
    archetype: string;
    trigger: number;
    entryZone: string;
    chasePrice: number;
    expectedMove: number;
    majorResistance: number;
    stretchTarget: number;
    stop: number;
    rewardRisk: number;
    roomToResistance: number;
    roomToSupport: number;
    confirmation: string;
    invalidation: string;
    whyNow: string;
    confidence: number;
  };
}

export type ScreenerMode = 'premarket' | 'open' | 'momentum' | 'highdemand';





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

function isPremarketEastern(now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value ?? '';
  const weekday = value('weekday');
  const minutes = Number(value('hour')) * 60 + Number(value('minute'));
  return weekday !== 'Sat' && weekday !== 'Sun' && minutes >= 4 * 60 && minutes < 9 * 60 + 30;
}



const ScreenerDashboard: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [marketClock, setMarketClock] = useState(() => new Date());
  const premarketAvailable = isPremarketEastern(marketClock);
  const [mode, setMode] = useState<ScreenerMode>(
    location.state?.mode === 'premarket' && !premarketAvailable ? 'open' : (location.state?.mode || 'open'),
  );
  const [results, setResults] = useState<ScreenerResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [computedAt, setComputedAt] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const pollTimerRef = useRef<number | null>(null);
  const pollDeadlineRef = useRef<number>(0);

  // A tab can stay open through the bell. Refresh the session clock so a
  // previously valid premarket selection cannot remain active all afternoon.
  useEffect(() => {
    const updateClock = () => setMarketClock(new Date());
    const timer = window.setInterval(updateClock, 60_000);
    window.addEventListener('focus', updateClock);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', updateClock);
    };
  }, []);

  const fetchScreenerData = useCallback(async (selectedMode: ScreenerMode, opts?: { force?: boolean }) => {
    setLoading(true);
    setError(null);
    try {
      const { results: data, computedAt: at } = await api.getScreener(selectedMode, opts);
      setResults(Array.isArray(data) ? data : []);
      setComputedAt(at);
      return at;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load screener data';
      setError(message);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    setRefreshing(false);
  }, []);

  const handleRefreshScan = useCallback(async (selectedMode: ScreenerMode) => {
    const priorComputedAt = computedAt;
    setRefreshing(true);
    setError(null);
    try {
      await api.refreshScreener(selectedMode);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to start refresh';
      setError(message);
      setRefreshing(false);
      return;
    }

    // A full scan takes a few minutes; poll for the new result rather than
    // blocking, and give up gracefully if it runs unusually long.
    const POLL_INTERVAL_MS = 10_000;
    const POLL_TIMEOUT_MS = 5 * 60_000;
    pollDeadlineRef.current = Date.now() + POLL_TIMEOUT_MS;

    const poll = async () => {
      const at = await fetchScreenerData(selectedMode, { force: true });
      if (at && at !== priorComputedAt) {
        stopPolling();
        return;
      }
      if (Date.now() >= pollDeadlineRef.current) {
        setError('Refresh is taking longer than expected — showing the most recent scan.');
        stopPolling();
        return;
      }
      pollTimerRef.current = window.setTimeout(poll, POLL_INTERVAL_MS);
    };
    pollTimerRef.current = window.setTimeout(poll, POLL_INTERVAL_MS);
  }, [computedAt, fetchScreenerData, stopPolling]);

  useEffect(() => {
    stopPolling();
    fetchScreenerData(mode);
  }, [mode, fetchScreenerData, stopPolling]);

  useEffect(() => stopPolling, [stopPolling]);

  useEffect(() => {
    if (mode === 'premarket' && !premarketAvailable) setMode('open');
  }, [mode, premarketAvailable]);

  const handleRowClick = useCallback((symbol: string) => {
    window.localStorage.setItem('dashboard_selectedSymbol', JSON.stringify(symbol));
    window.dispatchEvent(new CustomEvent('TICKER_SELECTED', { detail: { symbol } }));
    navigate('/');
  }, [navigate]);

  const toggleRow = useCallback((symbol: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedRow(prev => prev === symbol ? null : symbol);
  }, []);

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
              disabled={!premarketAvailable}
              title={premarketAvailable ? 'Run the 4:00–9:30 AM ET premarket scan' : 'Premarket scan is available only from 4:00–9:30 AM ET'}
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
            <button
              type="button"
              role="tab"
              aria-selected={false}
              className={styles.modeBtn}
              onClick={() => navigate('/screener/value')}
            >
              💰 Value
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={false}
              className={styles.modeBtn}
              onClick={() => navigate('/screener/growth')}
            >
              🚀 Growth
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={false}
              className={styles.modeBtn}
              onClick={() => navigate('/screener/etf')}
            >
              📊 ETFs
            </button>
          </div>

          <button
            type="button"
            className={styles.refreshBtn}
            onClick={() => handleRefreshScan(mode)}
            disabled={loading || refreshing}
            title={refreshing ? 'Fetching latest prices and recalculating — this takes a few minutes' : undefined}
          >
            {refreshing ? (
              <>
                <span className={styles.spinner} aria-hidden />
                Refreshing…
              </>
            ) : loading ? (
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
            <h2 className={styles.sectionTitle}>🏆 A+ Setups (Active Triggers)</h2>
            <div className={styles.cardsGrid}>
              {results.filter(r => r.eventRisk !== 'HIGH' && r.adjustedEV >= 0.5 && r.triggerStatus === 'TRIGGER ACTIVE').slice(0, 3).map(result => (
                <div key={result.symbol} className={styles.tradeCard} onClick={() => handleRowClick(result.symbol)}>
                  <div className={styles.cardHeader}>
                    <span className={styles.cardRank}>🏆 {result.symbol}</span>
                    <span className={styles.cardScore}>+{result.adjustedEV.toFixed(2)}R EV</span>
                  </div>
                  <div className={styles.cardBody}>
                    <div>{result.setupType}</div>
                    {result.tradePlan?.bias !== 'NO TRADE' && result.tradePlan?.rewardRisk ? (
                      <div style={{ color: 'var(--color-bullish)' }}>{result.tradePlan.rewardRisk}R theoretical</div>
                    ) : null}
                    <div style={{ color: 'var(--color-text-dim)' }}>{result.tradePlan?.whyNow}</div>
                  </div>
                </div>
              ))}
            </div>
            {results.filter(r => r.eventRisk !== 'HIGH' && r.adjustedEV >= 0.5 && r.triggerStatus === 'TRIGGER ACTIVE').length === 0 && (
              <p style={{ color: 'var(--color-text-dim)', fontSize: '0.85rem' }}>No A+ setups currently active.</p>
            )}
          </div>
          <div className={styles.topTradesSection}>
            <h2 className={styles.sectionTitle}>🟢 A Setups (Wait For Trigger)</h2>
            <div className={styles.cardsGrid}>
              {results.filter(r => r.eventRisk !== 'HIGH' && r.adjustedEV >= 0.5 && r.triggerStatus !== 'TRIGGER ACTIVE').slice(0, 3).map(result => (
                <div key={result.symbol} className={styles.tradeCard} onClick={() => handleRowClick(result.symbol)}>
                  <div className={styles.cardHeader}>
                    <span className={styles.cardRank}>🟢 {result.symbol}</span>
                    <span className={styles.cardScore}>+{result.adjustedEV.toFixed(2)}R EV</span>
                  </div>
                  <div className={styles.cardBody}>
                    <div>{result.setupType}</div>
                    <div style={{ color: 'var(--accent-main)' }}>{result.triggerStatus}</div>
                    <div style={{ color: 'var(--color-text-dim)' }}>{result.tradePlan?.entryZone}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className={styles.avoidSection}>
            <h2 className={styles.sectionTitle}>🟠 Event Risk</h2>
            <div className={styles.avoidList}>
              {results.filter(r => r.eventRisk === 'HIGH').slice(0, 3).map(result => (
                <div key={result.symbol} className={styles.avoidItem}>
                  {/* The event-risk engine scores volume/volatility anomalies — it
                      does not read an earnings calendar, so it cannot attribute the
                      risk to earnings. Show the reasons it actually produced. */}
                  <strong>{result.symbol}</strong> — <span style={{ color: 'var(--color-text-dim)' }}>
                    {result.eventRiskReasons?.length
                      ? result.eventRiskReasons.join('; ')
                      : 'Unusual volume/volatility — cause unconfirmed.'}
                  </span>
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
              <col style={{ width: '40px' }} />
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
                <th className={styles.th}></th>
                <th className={styles.th}>Ticker</th>
                <th className={styles.th}>Setup</th>
                <th className={styles.th}>Model EV (R)</th>
                <th className={styles.thRight}>Entry</th>
                <th className={styles.thRight}>Stop</th>
                <th className={styles.thRight}>T1</th>
                <th className={styles.thRight}>R:R</th>
                <th className={styles.th}>Trigger Status</th>
                <th className={styles.thRight}>RVOL</th>
                <th className={styles.thRight}>RS (vs SPY)</th>
                <th className={styles.th}>Event Risk</th>
              </tr>
            </thead>
            <tbody className={styles.tbody}>
              {results.map(result => {
                const isNoTrade = result.tradePlan?.bias === 'NO TRADE';
                const isExpanded = expandedRow === result.symbol;
                return (
                <React.Fragment key={result.symbol}>
                <tr 
                  onClick={() => handleRowClick(result.symbol)}
                  style={{ cursor: 'pointer', opacity: isNoTrade ? 0.4 : 1.0 }}
                >
                  <td className={styles.td} onClick={(e) => toggleRow(result.symbol, e)} style={{ textAlign: 'center', cursor: 'pointer' }}>
                    {isExpanded ? '▼' : '▶'}
                  </td>
                  <td className={styles.td}>
                    <div className={styles.symbolCell}>
                      <span className={styles.symbolTicker} style={{ textDecoration: isNoTrade ? 'line-through' : 'none' }}>{result.symbol}</span>
                      {result.dataQuality !== 'VERIFIED' && (
                        <span
                          aria-label={result.dataQuality === 'SUSPICIOUS' ? 'Suspicious data' : 'Check data'}
                          title={
                            result.dataQuality === 'SUSPICIOUS'
                              ? 'RVOL or % change is far outside normal range — often a thin/stale average-volume baseline (e.g. a recent reverse split). Verify before trading.'
                              : 'RVOL or % change is elevated enough to double-check against another source before trading.'
                          }
                          style={{ marginLeft: '4px', color: result.dataQuality === 'SUSPICIOUS' ? 'var(--color-bearish)' : 'var(--color-text-dim)', cursor: 'help' }}
                        >
                          ⚠️
                        </span>
                      )}
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
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <span className={styles.confidencePct}>{result.adjustedEV > 0 ? `+${result.adjustedEV.toFixed(2)}R` : '-'}</span>
                      {result.adjustedEV > 0 && (
                        <span style={{ fontSize: '0.7rem', color: 'var(--color-text-dim)', marginTop: '2px' }}>
                          P(T1): {(result.modelPT1 * 100).toFixed(0)}% | N: {result.modelSampleSize}
                        </span>
                      )}
                    </div>
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
                      {!isNoTrade && result.tradePlan?.rewardRisk ? `${result.tradePlan.rewardRisk}R` : '-'}
                    </span>
                  </td>
                  <td className={styles.td}>
                    <span className={styles.locationText} style={{ 
                      color: result.triggerStatus === 'TRIGGER ACTIVE' ? 'var(--color-bullish)' : 
                             result.triggerStatus.includes('WAIT') ? 'var(--accent-main)' : 'var(--color-text-dim)' 
                    }}>{result.triggerStatus || '-'}</span>
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
                    <span className={styles.locationText} style={{ 
                      color: result.eventRisk === 'HIGH' ? 'var(--color-bearish)' : 
                             result.eventRisk === 'MEDIUM' ? 'var(--gold-mid)' : 'var(--color-bullish)'
                    }}>{result.eventRisk}</span>
                  </td>
                </tr>
                
                {isExpanded && !isNoTrade && result.tradePlan && (
                  <tr style={{ backgroundColor: 'rgba(255, 255, 255, 0.02)' }}>
                    <td colSpan={12} style={{ padding: '1rem', borderBottom: '1px solid var(--color-border)' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem', fontSize: '0.85rem' }}>
                        <div>
                          <strong style={{ color: 'var(--color-text)', display: 'block', marginBottom: '0.5rem' }}>
                            {result.triggerStatus} — {result.setupType}
                          </strong>
                          <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '0.5rem' }}>
                            <span style={{ color: 'var(--color-text-dim)' }}>Entry zone</span>
                            <span style={{ color: 'var(--color-text)' }}>{result.tradePlan.entryZone}</span>
                            
                            <span style={{ color: 'var(--color-text-dim)' }}>Trigger</span>
                            <span style={{ color: 'var(--accent-main)' }}>{result.tradePlan.trigger ? `Price hits $${result.tradePlan.trigger}` : 'N/A'}</span>
                            
                            <span style={{ color: 'var(--color-text-dim)' }}>Confirmation</span>
                            <span style={{ color: 'var(--color-text)' }}>{result.tradePlan.confirmation}</span>
                          </div>
                        </div>
                        <div>
                          <strong style={{ color: 'var(--color-text)', display: 'block', marginBottom: '0.5rem', opacity: 0 }}>
                            Risk Management
                          </strong>
                          <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '0.5rem' }}>
                            <span style={{ color: 'var(--color-text-dim)' }}>Invalidation</span>
                            <span style={{ color: 'var(--color-bearish)' }}>{result.tradePlan.invalidation}</span>
                            
                            <span style={{ color: 'var(--color-text-dim)' }}>Target</span>
                            <span style={{ color: 'var(--color-bullish)' }}>{result.tradePlan.bias === 'LONG' ? `$${result.tradePlan.majorResistance}` : `$${result.tradePlan.stretchTarget}`}</span>
                            
                            <span style={{ color: 'var(--color-text-dim)' }}>Expected Move</span>
                            <span style={{ color: 'var(--color-text)' }}>{result.tradePlan.expectedMove.toFixed(1)}%</span>
                          </div>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
                </React.Fragment>
              )})}

              {results.length === 0 && !loading && (
                <tr className={styles.emptyRow}>
                  <td colSpan={12}>
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
