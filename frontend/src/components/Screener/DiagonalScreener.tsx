import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import styles from './DiagonalScreener.module.css';
import dashStyles from './ScreenerDashboard.module.css'; // use shared tab styles

interface DiagonalScreenerResult {
  symbol: string;
  price: number;
  drawdownPct: number;
  rsi14: number | null;
  isOversold: boolean;
  selloffDepth5d: number;
  hasViableChain: boolean;
  expirations: string[];
  isBackwardation: boolean;
  nearTermIV: number | null;
  farTermIV: number | null;
  ivRatio: number | null;
  historicalVol1y: number | null;
  ivRankProxy: number | null;
  
  longLeg: { strike: number; expiry: string; delta: number; ask: number; dte: number } | null;
  shortLeg: { strike: number; expiry: string; iv: number; bid: number; dte: number } | null;
  netDebit: number | null;
  strikeWidth: number | null;
  debitWidthRatio: number | null;
  breakEven: number | null;
  
  setupScore: number;
  reasons: string[];
}

function ScoreBadge({ score }: { score: number }) {
  const cls =
    score >= 75 ? styles.scoreHigh :
    score >= 55 ? styles.scoreMid :
    styles.scoreLow;
  return (
    <div className={`${styles.scoreBadge} ${cls}`}>
      <span className={styles.scoreValue}>{score}</span>
      <span className={styles.scoreLabel}>{score >= 75 ? 'Strong' : score >= 55 ? 'Moderate' : 'Weak'}</span>
    </div>
  );
}

function IVBar({ near, far }: { near: number | null; far: number | null }) {
  if (near === null || far === null) return <span className={styles.naText}>—</span>;
  const nearPct = (near * 100).toFixed(0);
  const farPct = (far * 100).toFixed(0);
  const isBack = near > far * 1.05;
  return (
    <div className={styles.ivBarWrapper}>
      <div className={`${styles.ivPill} ${isBack ? styles.ivNearBack : styles.ivNear}`}>
        Near {nearPct}%
      </div>
      <span className={styles.ivArrow}>{isBack ? '↓' : '↑'}</span>
      <div className={`${styles.ivPill} ${styles.ivFar}`}>
        Far {farPct}%
      </div>
    </div>
  );
}

function RatioBadge({ ratio }: { ratio: number | null }) {
  if (ratio === null) return <span className={styles.naText}>—</span>;
  const isGood = ratio <= 0.8;
  const isPoor = ratio >= 1.0;
  return (
    <div className={`${styles.ratioBadge} ${isGood ? styles.ratioGood : isPoor ? styles.ratioPoor : styles.ratioMid}`}>
      {ratio.toFixed(2)}
    </div>
  );
}

const DiagonalScreener: React.FC = () => {
  const navigate = useNavigate();
  const [results, setResults] = useState<DiagonalScreenerResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [computedAt, setComputedAt] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const pollTimerRef = useRef<number | null>(null);
  const pollDeadlineRef = useRef<number>(0);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { results: data, computedAt: at } = await api.getDiagonalScreener();
      setResults(Array.isArray(data) ? data : []);
      setComputedAt(at);
      return at;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load diagonal screener';
      setError(msg);
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

  const handleRefreshScan = useCallback(async () => {
    const priorComputedAt = computedAt;
    setRefreshing(true);
    setError(null);
    try {
      await api.refreshDiagonalScreener();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to start refresh';
      setError(msg);
      setRefreshing(false);
      return;
    }

    // The scan takes about a minute; poll for the new result rather than
    // blocking, and give up gracefully if it runs unusually long.
    const POLL_INTERVAL_MS = 10_000;
    const POLL_TIMEOUT_MS = 3 * 60_000;
    pollDeadlineRef.current = Date.now() + POLL_TIMEOUT_MS;

    const poll = async () => {
      const at = await fetchData();
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
  }, [computedAt, fetchData, stopPolling]);

  const handleRowClick = useCallback((symbol: string) => {
    window.localStorage.setItem('dashboard_selectedSymbol', JSON.stringify(symbol));
    window.dispatchEvent(new CustomEvent('TICKER_SELECTED', { detail: { symbol } }));
    navigate('/');
  }, [navigate]);

  useEffect(() => {
    fetchData();
    return stopPolling;
  }, [fetchData, stopPolling]);

  return (
    <div className={styles.page}>
      <div className={styles.glowA} aria-hidden />
      <div className={styles.glowB} aria-hidden />

      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Diagonal Spread Scanner</h1>
          <p className={styles.subtitle}>
            Surfaces RSI-exhausted names with viable option chains &amp; vol backwardation — optimal for LEAP diagonal (BuCD) setups
          </p>
        </div>

        <div className={dashStyles.headerActions}>
          <div className={dashStyles.modeToggle} role="tablist" aria-label="Market session">
            <button
              type="button"
              role="tab"
              aria-selected={false}
              className={dashStyles.modeBtn}
              onClick={() => navigate('/screener', { state: { mode: 'premarket' } })}
            >
              Premarket (4A–9:30A)
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={false}
              className={dashStyles.modeBtn}
              onClick={() => navigate('/screener', { state: { mode: 'open' } })}
            >
              Open Market
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={false}
              className={dashStyles.modeBtn}
              onClick={() => navigate('/screener', { state: { mode: 'momentum' } })}
            >
              🔥 Momentum $2–$20
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={false}
              className={dashStyles.modeBtn}
              onClick={() => navigate('/screener', { state: { mode: 'highdemand' } })}
            >
              🎯 Top Guns
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={true}
              className={`${dashStyles.modeBtn} ${styles.modeBtnActiveDiagonal}`}
              onClick={() => {}}
            >
              📈 Diagonal Spreads
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={false}
              className={dashStyles.modeBtn}
              onClick={() => navigate('/screener/value')}
            >
              💰 Value
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={false}
              className={dashStyles.modeBtn}
              onClick={() => navigate('/screener/growth')}
            >
              🚀 Growth
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={false}
              className={dashStyles.modeBtn}
              onClick={() => navigate('/screener/etf')}
            >
              📊 ETFs
            </button>
          </div>

          <button
            type="button"
            className={styles.refreshBtn}
            onClick={handleRefreshScan}
            disabled={loading || refreshing}
            title={refreshing ? 'Recomputing — this takes about a minute' : undefined}
          >
            {refreshing ? (
              <><span className={styles.spinner} aria-hidden />Refreshing…</>
            ) : loading ? (
              <><span className={styles.spinner} aria-hidden />Scanning…</>
            ) : (
              <>↻ Refresh Scan</>
            )}
          </button>
        </div>
      </header>

      {/* Methodology bar */}
      <div className={styles.methodBar}>
        <span className={styles.methodChip}>RSI ≤ 35 or ≥15% 5-day drop</span>
        <span className={styles.methodSep}>+</span>
        <span className={styles.methodChip}>Liquid chain (≥2 expirations, OI &gt; 1000, tight spreads)</span>
        <span className={styles.methodSep}>+</span>
        <span className={styles.methodChip}>Backwardation preferred, not required</span>
        <span className={styles.methodSep}>→</span>
        <span className={styles.methodResult}>Long deep-ITM LEAP / Short near-term OTM call</span>
      </div>

      {error && <div className={styles.errorBanner}>{error}</div>}

      <div className={styles.panel}>
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead className={styles.thead}>
              <tr>
                <th className={styles.th}>Symbol</th>
                <th className={styles.th}>Price / Drawdown</th>
                <th className={styles.th}>RSI / 5d Move</th>
                <th className={styles.th}>IV Term Structure</th>
                <th className={styles.th}>Long Leg (LEAP)</th>
                <th className={styles.th}>Short Leg (Near)</th>
                <th className={styles.th}>Debit/Width</th>
                <th className={styles.th}>B/E</th>
                <th className={styles.th}>Score</th>
              </tr>
            </thead>
            <tbody className={styles.tbody}>
              {results.map(r => (
                <React.Fragment key={r.symbol}>
                  <tr
                    className={`${styles.row} ${expanded === r.symbol ? styles.rowExpanded : ''}`}
                    onClick={() => setExpanded(prev => prev === r.symbol ? null : r.symbol)}
                  >
                    {/* Symbol */}
                    <td className={styles.td}>
                      <div className={styles.symbolCell}>
                        <span className={`${styles.symbolAvatar} ${r.isOversold ? styles.avatarOversold : ''}`}>
                          {r.symbol.charAt(0)}
                        </span>
                        <div onClick={(e) => { e.stopPropagation(); handleRowClick(r.symbol); }} style={{ cursor: 'pointer' }}>
                          <div className={styles.symbolTicker} style={{ textDecoration: 'underline' }}>{r.symbol}</div>
                          {r.isBackwardation && (
                            <span className={styles.backwardationBadge}>⚡ Backwardation</span>
                          )}
                        </div>
                      </div>
                    </td>

                    {/* Price / Drawdown */}
                    <td className={styles.td}>
                      <div className={styles.priceStack}>
                        <span className={styles.priceVal}>${r.price.toFixed(2)}</span>
                        <span className={`${styles.drawdownPill} ${r.drawdownPct >= 30 ? styles.drawdownHigh : styles.drawdownMid}`}>
                          ↓{r.drawdownPct.toFixed(0)}% from 52w
                        </span>
                      </div>
                    </td>

                    {/* RSI / 5d */}
                    <td className={styles.td}>
                      <div className={styles.rsiStack}>
                        {r.rsi14 !== null ? (
                          <span className={`${styles.rsiPill} ${r.rsi14 <= 30 ? styles.rsiExtreme : r.rsi14 <= 40 ? styles.rsiOversold : ''}`}>
                            RSI {r.rsi14}
                          </span>
                        ) : (
                          <span className={styles.naText}>RSI —</span>
                        )}
                        <span className={`${styles.movePill} ${r.selloffDepth5d < -10 ? styles.moveDown : ''}`}>
                          {r.selloffDepth5d >= 0 ? '+' : ''}{r.selloffDepth5d.toFixed(1)}% 5d
                        </span>
                      </div>
                    </td>

                    {/* IV Term Structure */}
                    <td className={styles.td}>
                      <IVBar near={r.nearTermIV} far={r.farTermIV} />
                    </td>

                    {/* Long Leg */}
                    <td className={styles.td}>
                      {r.longLeg ? (
                        <div className={styles.legStack}>
                          <span className={styles.legPrimary}>{r.longLeg.expiry} ${r.longLeg.strike}c</span>
                          <span className={styles.legSecondary}>Ask ${r.longLeg.ask} | Δ {r.longLeg.delta}</span>
                        </div>
                      ) : <span className={styles.naText}>—</span>}
                    </td>

                    {/* Short Leg */}
                    <td className={styles.td}>
                      {r.shortLeg ? (
                        <div className={styles.legStack}>
                          <span className={styles.legPrimary}>{r.shortLeg.expiry} ${r.shortLeg.strike}c</span>
                          <span className={styles.legSecondary}>Bid ${r.shortLeg.bid} | {r.shortLeg.dte} DTE</span>
                        </div>
                      ) : <span className={styles.naText}>—</span>}
                    </td>

                    {/* Debit / Width Ratio */}
                    <td className={styles.td}>
                      <RatioBadge ratio={r.debitWidthRatio} />
                    </td>

                    {/* B/E */}
                    <td className={styles.td}>
                      {r.breakEven !== null ? (
                        <span className={`${styles.bePill} ${r.breakEven <= 90 ? styles.beGood : r.breakEven <= 95 ? styles.beMid : styles.bePoor}`}>
                          {r.breakEven}% of price
                        </span>
                      ) : (
                        <span className={styles.naText}>—</span>
                      )}
                    </td>

                    {/* Score */}
                    <td className={styles.td}>
                      <ScoreBadge score={r.setupScore} />
                    </td>
                  </tr>

                  {/* Expanded detail row */}
                  {expanded === r.symbol && (
                    <tr className={styles.detailRow}>
                      <td colSpan={8} className={styles.detailCell}>
                        <div className={styles.detailGrid}>
                          <div className={styles.detailSection}>
                            <h4 className={styles.detailLabel}>📋 Signal Reasons</h4>
                            <div className={styles.reasonList}>
                              {r.reasons.map((reason, i) => (
                                <span key={i} className={styles.reasonChip}>{reason}</span>
                              ))}
                            </div>
                          </div>

                          {r.longLeg && (
                            <div className={styles.detailSection}>
                              <h4 className={styles.detailLabel}>📈 Long Leg (LEAP)</h4>
                              <div className={styles.legDetail}>
                                <span className={styles.legBadge}>Strike ${r.longLeg.strike}</span>
                                <span className={styles.legBadge}>Exp {r.longLeg.expiry}</span>
                                <span className={styles.legBadge}>Ask ${r.longLeg.ask}</span>
                                <span className={styles.legBadge}>Δ ≈ {r.longLeg.delta}</span>
                              </div>
                            </div>
                          )}

                          {r.shortLeg && (
                            <div className={styles.detailSection}>
                              <h4 className={styles.detailLabel}>📉 Short Leg (Near-term)</h4>
                              <div className={styles.legDetail}>
                                <span className={styles.legBadge}>Strike ${r.shortLeg.strike}</span>
                                <span className={styles.legBadge}>Exp {r.shortLeg.expiry}</span>
                                <span className={styles.legBadge}>Bid ${r.shortLeg.bid}</span>
                                <span className={styles.legBadge}>IV {r.shortLeg.iv}%</span>
                              </div>
                            </div>
                          )}

                          <div className={styles.detailSection}>
                            <h4 className={styles.detailLabel}>📅 Expirations Available</h4>
                            <div className={styles.legDetail}>
                              {r.expirations.map(exp => (
                                <span key={exp} className={styles.expChip}>{exp}</span>
                              ))}
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}

              {results.length === 0 && !loading && (
                <tr className={styles.emptyRow}>
                  <td colSpan={8}>
                    <p className={styles.emptyTitle}>No diagonal setups found</p>
                    <p className={styles.emptyHint}>
                      No names currently meet the RSI exhaustion + viable chain + backwardation criteria. Markets may be extended or chains are illiquid. Try refreshing during a market correction.
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

export default DiagonalScreener;
