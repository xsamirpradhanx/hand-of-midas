import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import styles from './FundamentalScreener.module.css';
import dashStyles from './ScreenerDashboard.module.css'; // use shared tab styles

interface EtfScreenerResult {
  symbol: string;
  price: number;
  return3mo: number | null;
  return1yr: number | null;
  benchmarkReturn3mo: number | null;
  benchmarkReturn1yr: number | null;
  outperformance3mo: number | null;
  outperformance1yr: number | null;
  expenseRatio: number | null;

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

function pct(v: number | null): string {
  return v !== null ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%` : '—';
}

const EtfScreener: React.FC = () => {
  const navigate = useNavigate();
  const [results, setResults] = useState<EtfScreenerResult[]>([]);
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
      const { results: data, computedAt: at } = await api.getEtfScreener();
      setResults(Array.isArray(data) ? data : []);
      setComputedAt(at);
      return at;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load ETF screener';
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
      await api.refreshEtfScreener();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to start refresh';
      setError(msg);
      setRefreshing(false);
      return;
    }

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
          <h1 className={styles.title}>ETF Scanner</h1>
          <p className={styles.subtitle}>
            ETFs outperforming SPY over BOTH the last 3 months and the last year, ranked with expense ratio as the "cheapest" tiebreaker
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
            <button type="button" role="tab" aria-selected={false} className={dashStyles.modeBtn} onClick={() => navigate('/screener/value')}>
              💰 Value
            </button>
            <button type="button" role="tab" aria-selected={false} className={dashStyles.modeBtn} onClick={() => navigate('/screener/growth')}>
              🚀 Growth
            </button>
            <button type="button" role="tab" aria-selected={true} className={`${dashStyles.modeBtn} ${styles.modeBtnActiveEtf}`} onClick={() => {}}>
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
        <span className={styles.methodChip}>Return &gt; SPY (3mo)</span>
        <span className={styles.methodSep}>+</span>
        <span className={styles.methodChip}>Return &gt; SPY (1yr)</span>
        <span className={styles.methodSep}>+</span>
        <span className={styles.methodChip}>Excludes leveraged/inverse funds</span>
        <span className={styles.methodSep}>→</span>
        <span className={styles.methodResult}>Durable outperformance, ranked cheapest-first</span>
      </div>

      {error && <div className={styles.errorBanner}>{error}</div>}

      <div className={styles.panel}>
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead className={styles.thead}>
              <tr>
                <th className={styles.th}>Symbol</th>
                <th className={styles.th}>Price</th>
                <th className={styles.th}>3mo Return (vs SPY)</th>
                <th className={styles.th}>1yr Return (vs SPY)</th>
                <th className={styles.th}>Expense Ratio</th>
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
                      <span className={styles.priceVal}>${r.price.toFixed(2)}</span>
                    </td>

                    <td className={styles.td}>
                      <div className={styles.metricStack}>
                        {/* Green signals a positive absolute return, not just beating SPY — the
                            hard filter only guarantees outperformance, which in a down market
                            (SPY -10%, ETF -5%) can still be a negative number. */}
                        <span className={`${styles.metricPill} ${r.return3mo !== null && r.return3mo > 0 ? styles.metricGood : ''}`}>{pct(r.return3mo)}</span>
                        <span className={styles.naText}>vs SPY {pct(r.benchmarkReturn3mo)} ({pct(r.outperformance3mo)} edge)</span>
                      </div>
                    </td>

                    <td className={styles.td}>
                      <div className={styles.metricStack}>
                        <span className={`${styles.metricPill} ${r.return1yr !== null && r.return1yr > 0 ? styles.metricGood : ''}`}>{pct(r.return1yr)}</span>
                        <span className={styles.naText}>vs SPY {pct(r.benchmarkReturn1yr)} ({pct(r.outperformance1yr)} edge)</span>
                      </div>
                    </td>

                    <td className={styles.td}>
                      {r.expenseRatio !== null ? (
                        <span className={`${styles.metricPill} ${r.expenseRatio <= 0.001 ? styles.metricGood : r.expenseRatio > 0.01 ? styles.metricPoor : ''}`}>
                          {(r.expenseRatio * 100).toFixed(2)}%
                        </span>
                      ) : <span className={styles.naText}>—</span>}
                    </td>

                    <td className={styles.td}>
                      <ScoreBadge score={r.setupScore} />
                    </td>
                  </tr>

                  {expanded === r.symbol && (
                    <tr className={styles.detailRow}>
                      <td colSpan={6} className={styles.detailCell}>
                        <div className={styles.detailGrid}>
                          <div className={styles.detailSection}>
                            <h4 className={styles.detailLabel}>📋 Signal Reasons</h4>
                            <div className={styles.reasonList}>
                              {r.reasons.map((reason, i) => (
                                <span key={i} className={styles.reasonChip}>{reason}</span>
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
                  <td colSpan={6}>
                    <p className={styles.emptyTitle}>No outperforming ETFs found</p>
                    <p className={styles.emptyHint}>
                      No ETF in the curated universe currently beats SPY in both the 3-month and 1-year windows. Try refreshing, or check back after the next daily scan.
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

export default EtfScreener;
