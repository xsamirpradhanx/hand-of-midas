import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import styles from './FundamentalScreener.module.css';
import dashStyles from './ScreenerDashboard.module.css'; // use shared tab styles

interface ValueScreenerResult {
  symbol: string;
  price: number;
  marketCap: number | null;
  trailingPE: number | null;
  priceToBook: number | null;
  priceToSales: number | null;
  returnOnEquity: number | null;
  profitMargin: number | null;
  operatingMargin: number | null;
  debtToEquity: number | null;
  freeCashflow: number | null;
  fcfYield: number | null;
  revenueGrowth: number | null;

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

function fmtMarketCap(cap: number | null): string {
  if (cap === null) return '—';
  if (cap >= 1e12) return `$${(cap / 1e12).toFixed(2)}T`;
  if (cap >= 1e9) return `$${(cap / 1e9).toFixed(1)}B`;
  if (cap >= 1e6) return `$${(cap / 1e6).toFixed(0)}M`;
  return `$${cap.toFixed(0)}`;
}

const ValueScreener: React.FC = () => {
  const navigate = useNavigate();
  const [results, setResults] = useState<ValueScreenerResult[]>([]);
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
      const { results: data, computedAt: at } = await api.getValueScreener();
      setResults(Array.isArray(data) ? data : []);
      setComputedAt(at);
      return at;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load value screener';
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
      await api.refreshValueScreener();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to start refresh';
      setError(msg);
      setRefreshing(false);
      return;
    }

    // Fundamentals scans run once a day and can take a while (Phase 1 + Phase
    // 2 quoteSummary calls across ~40 candidates) — poll rather than block.
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
          <h1 className={styles.title}>Value Scanner</h1>
          <p className={styles.subtitle}>
            Quality-value blend — cheap on P/E, P/B, P/S and FCF yield, AND fundamentally healthy on ROE, margins and leverage
          </p>
        </div>

        <div className={dashStyles.headerActions}>
          <div className={dashStyles.modeToggle} role="tablist" aria-label="Market session">
            <button type="button" role="tab" aria-selected={false} className={dashStyles.modeBtn} onClick={() => navigate('/screener', { state: { mode: 'premarket' } })}>
              Premarket (4A–9:30A)
            </button>
            <button type="button" role="tab" aria-selected={false} className={dashStyles.modeBtn} onClick={() => navigate('/screener', { state: { mode: 'open' } })}>
              Open Market
            </button>
            <button type="button" role="tab" aria-selected={false} className={dashStyles.modeBtn} onClick={() => navigate('/screener', { state: { mode: 'momentum' } })}>
              🔥 Momentum $2–$20
            </button>
            <button type="button" role="tab" aria-selected={false} className={dashStyles.modeBtn} onClick={() => navigate('/screener', { state: { mode: 'highdemand' } })}>
              🎯 Top Guns
            </button>
            <button type="button" role="tab" aria-selected={false} className={dashStyles.modeBtn} onClick={() => navigate('/screener/diagonal')}>
              📈 Diagonal Spreads
            </button>
            <button type="button" role="tab" aria-selected={true} className={`${dashStyles.modeBtn} ${styles.modeBtnActiveValue}`} onClick={() => {}}>
              💰 Value
            </button>
            <button type="button" role="tab" aria-selected={false} className={dashStyles.modeBtn} onClick={() => navigate('/screener/growth')}>
              🚀 Growth
            </button>
            <button type="button" role="tab" aria-selected={false} className={dashStyles.modeBtn} onClick={() => navigate('/screener/etf')}>
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

      <div className={styles.methodBar}>
        <span className={styles.methodChip}>P/E ≤ 22, P/B ≤ 2, P/S ≤ 2</span>
        <span className={styles.methodSep}>+</span>
        <span className={styles.methodChip}>Positive FCF, ROE ≥ 15%, Margin ≥ 10%</span>
        <span className={styles.methodSep}>+</span>
        <span className={styles.methodChip}>Value-trap guard: excludes negative ROE + heavy leverage</span>
        <span className={styles.methodSep}>→</span>
        <span className={styles.methodResult}>Cheap AND healthy, not cheap for a reason</span>
      </div>

      {error && <div className={styles.errorBanner}>{error}</div>}

      <div className={styles.panel}>
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead className={styles.thead}>
              <tr>
                <th className={styles.th}>Symbol</th>
                <th className={styles.th}>Price / Mkt Cap</th>
                <th className={styles.th}>Valuation (P/E, P/B, P/S)</th>
                <th className={styles.th}>FCF Yield</th>
                <th className={styles.th}>ROE / Margin</th>
                <th className={styles.th}>Debt/Equity</th>
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
                    <td className={styles.td}>
                      <div className={styles.symbolCell}>
                        <span className={`${styles.symbolAvatar} ${styles.avatarHighlight}`}>{r.symbol.charAt(0)}</span>
                        <div onClick={(e) => { e.stopPropagation(); handleRowClick(r.symbol); }} style={{ cursor: 'pointer' }}>
                          <div className={styles.symbolTicker} style={{ textDecoration: 'underline' }}>{r.symbol}</div>
                        </div>
                      </div>
                    </td>

                    <td className={styles.td}>
                      <div className={styles.priceStack}>
                        <span className={styles.priceVal}>${r.price.toFixed(2)}</span>
                        <span className={styles.naText}>{fmtMarketCap(r.marketCap)}</span>
                      </div>
                    </td>

                    <td className={styles.td}>
                      <div className={styles.metricStack}>
                        <span className={`${styles.metricPill} ${r.trailingPE !== null && r.trailingPE <= 15 ? styles.metricGood : ''}`}>
                          P/E {r.trailingPE !== null ? r.trailingPE.toFixed(1) : '—'}
                        </span>
                        <span className={styles.naText}>
                          P/B {r.priceToBook !== null ? r.priceToBook.toFixed(1) : '—'} · P/S {r.priceToSales !== null ? r.priceToSales.toFixed(1) : '—'}
                        </span>
                      </div>
                    </td>

                    <td className={styles.td}>
                      {r.fcfYield !== null ? (
                        <span className={`${styles.metricPill} ${r.fcfYield >= 0.05 ? styles.metricGood : ''}`}>
                          {(r.fcfYield * 100).toFixed(1)}%
                        </span>
                      ) : <span className={styles.naText}>—</span>}
                    </td>

                    <td className={styles.td}>
                      <div className={styles.metricStack}>
                        <span className={`${styles.metricPill} ${r.returnOnEquity !== null && r.returnOnEquity >= 0.15 ? styles.metricGood : ''}`}>
                          ROE {r.returnOnEquity !== null ? `${(r.returnOnEquity * 100).toFixed(0)}%` : '—'}
                        </span>
                        <span className={styles.naText}>
                          Margin {r.profitMargin !== null ? `${(r.profitMargin * 100).toFixed(0)}%` : '—'}
                        </span>
                      </div>
                    </td>

                    <td className={styles.td}>
                      {r.debtToEquity !== null ? (
                        <span className={`${styles.metricPill} ${r.debtToEquity > 200 ? styles.metricPoor : r.debtToEquity <= 100 ? styles.metricGood : ''}`}>
                          {r.debtToEquity.toFixed(0)}
                        </span>
                      ) : <span className={styles.naText}>—</span>}
                    </td>

                    <td className={styles.td}>
                      <ScoreBadge score={r.setupScore} />
                    </td>
                  </tr>

                  {expanded === r.symbol && (
                    <tr className={styles.detailRow}>
                      <td colSpan={7} className={styles.detailCell}>
                        <div className={styles.detailGrid}>
                          <div className={styles.detailSection}>
                            <h4 className={styles.detailLabel}>📋 Signal Reasons</h4>
                            <div className={styles.reasonList}>
                              {r.reasons.map((reason, i) => (
                                <span key={i} className={styles.reasonChip}>{reason}</span>
                              ))}
                            </div>
                          </div>
                          <div className={styles.detailSection}>
                            <h4 className={styles.detailLabel}>💵 Cash Flow</h4>
                            <div className={styles.reasonList}>
                              <span className={styles.reasonChip}>
                                FCF {r.freeCashflow !== null ? fmtMarketCap(r.freeCashflow) : '—'}
                              </span>
                              <span className={styles.reasonChip}>
                                Rev Growth {r.revenueGrowth !== null ? `${(r.revenueGrowth * 100).toFixed(0)}%` : '—'}
                              </span>
                              <span className={styles.reasonChip}>
                                Op Margin {r.operatingMargin !== null ? `${(r.operatingMargin * 100).toFixed(0)}%` : '—'}
                              </span>
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
                  <td colSpan={7}>
                    <p className={styles.emptyTitle}>No value setups found</p>
                    <p className={styles.emptyHint}>
                      No names currently clear the P/E, P/B, P/S and quality-guard thresholds. Try refreshing, or check back after the next daily scan.
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

export default ValueScreener;
