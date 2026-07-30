import React, { useState, useEffect, useMemo } from 'react';
import { api } from '../../lib/api';
import type { UnusualActivityItem } from '../../types';
import styles from './UnusualActivityFeed.module.css';

interface UnusualActivityFeedProps {
  initialSymbol?: string;
}

const formatPremium = (num: number) => {
  if (num >= 1000000) return '$' + (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return '$' + (num / 1000).toFixed(1) + 'K';
  return '$' + num.toString();
};

const formatNumber = (num: number) => {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
};

const formatIV = (iv: number | null | undefined): string => {
  if (iv == null) return '—';
  return (iv * 100).toFixed(1) + '%';
};

const formatIVDelta = (delta: number | null | undefined): string => {
  if (delta == null) return '—';
  const sign = delta >= 0 ? '+' : '';
  return `${sign}${(delta * 100).toFixed(1)}pp`;
};

const formatStockChange = (pct: number | null | undefined): string => {
  if (pct == null) return '—';
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${(pct * 100).toFixed(2)}%`;
};

type SortKey = keyof UnusualActivityItem;

const METRIC_DEFINITIONS = [
  {
    name: 'Whale Score',
    formula: '(Vol ÷ OI) × log₁₀(Premium) × (30 ÷ DTE)',
    description: 'Composite conviction score weighting volume-to-OI ratio, notional premium size, and urgency (shorter DTE = higher score). Scores above 250 indicate significant institutional positioning.',
  },
  {
    name: 'Vol/OI Ratio',
    formula: 'Daily Volume ÷ Open Interest',
    description: 'When volume exceeds open interest (≥3×), it signals new positions being opened rather than existing holders closing — a hallmark of fresh whale entries.',
  },
  {
    name: 'Premium Notional',
    formula: 'Volume × Mid-Price × 100',
    description: 'Total dollar value of the trade flow. Only contracts with ≥$100K notional and ≥500 contracts traded are surfaced to filter retail noise.',
  },
  {
    name: 'DTE (Days to Expiry)',
    formula: 'Calendar days until expiration',
    description: 'Short-dated options (≤14 DTE) carry higher urgency and are flagged as aggressive positioning. Scans the nearest 4 expiration cycles.',
  },
  {
    name: 'IV & ΔIV (Implied Vol)',
    formula: 'Exchange-reported IV | ΔIV = Today IV − Yesterday IV',
    description: 'IV shows the market-implied annualised volatility for the contract. ΔIV shows the intraday change vs prior day snapshot — a spike of +10pp or more is flagged as a signal of aggressive new positioning.',
  },
  {
    name: 'Stock Δ',
    formula: 'Underlying % change today',
    description: 'The stock\'s current day price change. Contextualises whether the options flow is directional (e.g. buying puts while stock is falling 10% signals conviction, not hedging).',
  },
];

export const UnusualActivityFeed: React.FC<UnusualActivityFeedProps> = ({ initialSymbol = '' }) => {
  const [data, setData] = useState<UnusualActivityItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(60);
  const [showMethodology, setShowMethodology] = useState(true);
  const [isMarqueePaused, setIsMarqueePaused] = useState(false);

  const [symbolFilter, setSymbolFilter] = useState(initialSymbol);

  useEffect(() => {
    setSymbolFilter(initialSymbol);
  }, [initialSymbol]);

  const [minSigma, setMinSigma] = useState(100);
  const [sideFilter, setSideFilter] = useState('all');
  const [dteMax, setDteMax] = useState(30);

  const [sortKey, setSortKey] = useState<SortKey>('compositeSigma');
  const [sortDesc, setSortDesc] = useState(true);

  const fetchData = async () => {
    if (!symbolFilter.trim()) {
      setData([]);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await api.getUnusualActivity({
        symbol: symbolFilter.trim(),
        minSigma,
        side: sideFilter,
        dteMax
      });
      setData(res || []);
    } catch (err) {
      console.error('Failed to load unusual activity:', err);
      setError(err instanceof Error ? err.message : 'Failed to load whale flow data');
      setData([]);
    } finally {
      setLoading(false);
      setCountdown(60);
    }
  };

  useEffect(() => {
    fetchData();
  }, [symbolFilter, minSigma, sideFilter, dteMax]);

  useEffect(() => {
    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          fetchData();
          return 60;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [symbolFilter, minSigma, sideFilter, dteMax]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDesc(!sortDesc);
    } else {
      setSortKey(key);
      setSortDesc(true);
    }
  };

  const sortedData = useMemo(() => {
    return [...data].sort((a, b) => {
      const valA = a[sortKey];
      const valB = b[sortKey];
      if (valA < valB) return sortDesc ? 1 : -1;
      if (valA > valB) return sortDesc ? -1 : 1;
      return 0;
    });
  }, [data, sortKey, sortDesc]);

  const getSigmaClass = (score: number) => {
    if (score >= 1000) return styles.sigmaRed;
    if (score >= 250) return styles.sigmaAmber;
    return styles.sigmaGreen;
  };

  const getSigmaLabel = (score: number) => {
    if (score >= 1000) return 'Extreme';
    if (score >= 250) return 'High';
    return 'Elevated';
  };

  return (
    <div className={styles.container}>
      <div className={styles.pageHeader}>
        <div className={styles.pageHeaderLeft}>
          <h2 className={styles.pageTitle}>Whale Flow Scanner</h2>
          <p className={styles.pageSubtitle}>
            Detects institutional-sized options activity using volume, open interest, and premium analysis
          </p>
        </div>
        <button
          className={styles.methodologyToggle}
          onClick={() => setShowMethodology(!showMethodology)}
        >
          {showMethodology ? 'Hide Methodology' : 'Show Methodology'}
        </button>
      </div>

      {showMethodology && (
        <div className={styles.methodologyPanel}>
          <div 
            className={`${styles.methodologyGrid} ${isMarqueePaused ? styles.paused : ''}`}
            onClick={() => setIsMarqueePaused(prev => !prev)}
          >
            {METRIC_DEFINITIONS.map((m) => (
              <div key={m.name} className={styles.metricCard}>
                <div className={styles.metricCardHeader}>
                  <span className={styles.metricName}>{m.name}</span>
                  <code className={styles.metricFormula}>{m.formula}</code>
                </div>
                <p className={styles.metricDesc}>{m.description}</p>
              </div>
            ))}
          </div>

          <div className={styles.sourcesBar}>
            <span className={styles.sourcesLabel}>Data Sources</span>
            <div className={styles.sourcesList}>
              <a
                href="https://finance.yahoo.com"
                target="_blank"
                rel="noopener noreferrer"
                className={styles.sourceLink}
              >
                Yahoo Finance
              </a>
              <span className={styles.sourceSep}>·</span>
              <span className={styles.sourceDetail}>Options chains, volume, OI, IV, bid/ask quotes</span>
              <span className={styles.sourceSep}>·</span>
              <span className={styles.sourceDetail}>Refreshed every 60s · Nearest 4 expirations scanned</span>
            </div>
          </div>
        </div>
      )}

      <div className={styles.filters}>
        <div className={styles.filterGroup}>
          <span className={styles.filterLabel}>Symbol</span>
          <input
            className={styles.filterInput}
            value={symbolFilter}
            onChange={(e) => setSymbolFilter(e.target.value.toUpperCase())}
            placeholder="e.g. TSLA"
          />
        </div>

        <div className={styles.filterGroup}>
          <span className={styles.filterLabel}>Min Whale Score</span>
          <input
            type="range"
            min="10"
            max="1000"
            step="10"
            value={minSigma}
            onChange={(e) => setMinSigma(parseFloat(e.target.value))}
            className={styles.rangeInput}
          />
          <span className={styles.filterValue}>{minSigma.toFixed(0)}</span>
        </div>

        <div className={styles.filterGroup}>
          <span className={styles.filterLabel}>Side</span>
          <select className={styles.filterSelect} value={sideFilter} onChange={(e) => setSideFilter(e.target.value)}>
            <option value="all">All</option>
            <option value="call">Calls</option>
            <option value="put">Puts</option>
          </select>
        </div>

        <div className={styles.filterGroup}>
          <span className={styles.filterLabel}>Max DTE</span>
          <select className={styles.filterSelect} value={dteMax} onChange={(e) => setDteMax(parseInt(e.target.value))}>
            <option value="7">7 Days</option>
            <option value="30">30 Days</option>
            <option value="90">90 Days</option>
            <option value="365">1 Year</option>
          </select>
        </div>

        <div className={styles.refreshGroup}>
          <span className={styles.refreshDot} />
          {loading ? 'Scanning...' : `Next scan in ${countdown}s`}
        </div>
      </div>

      <div className={styles.tableWrapper}>
        {error ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyIcon}>⚠️</div>
            <p>{error}</p>
            <span className={styles.emptyHint}>Check that the backend is running and VITE_API_URL includes /api</span>
          </div>
        ) : data.length === 0 && !loading ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyIcon}>🐋</div>
            <p>No whale activity detected matching your filters</p>
            <span className={styles.emptyHint}>Enter a symbol above to scan for institutional options flow</span>
          </div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.leftAlign} onClick={() => handleSort('symbol')}>Symbol</th>
                <th onClick={() => handleSort('strike')}>Strike</th>
                <th onClick={() => handleSort('expiry')}>Expiry</th>
                <th onClick={() => handleSort('dte')}>DTE</th>
                <th onClick={() => handleSort('side')}>Side</th>
                <th onClick={() => handleSort('premium')}>Premium</th>
                <th onClick={() => handleSort('volume')}>Vol</th>
                <th onClick={() => handleSort('openInterest')}>OI</th>
                <th onClick={() => handleSort('volumeOIRatio')}>Vol/OI</th>
                <th onClick={() => handleSort('rawIV')}>IV</th>
                <th onClick={() => handleSort('ivDelta')}>ΔIV</th>
                <th onClick={() => handleSort('stockChangePercent')}>Stock Δ</th>
                <th onClick={() => handleSort('compositeSigma')}>Whale Score</th>
                <th className={styles.leftAlign}>Signals</th>
              </tr>
            </thead>
            <tbody>
              {sortedData.map((item, i) => (
                <tr key={i}>
                  <td className={`${styles.leftAlign} ${styles.symbol}`}>
                    {item.isSweep && <span className={styles.sweepIcon} title="Sweep order detected">⚡</span>}
                    {item.symbol}
                  </td>
                  <td className={styles.mono}>${item.strike}</td>
                  <td>{item.expiry}</td>
                  <td className={item.dte <= 14 ? styles.dteUrgent : ''}>{item.dte}d</td>
                  <td>
                    <span className={`${styles.sideBadge} ${item.side === 'call' ? styles.sideCall : styles.sidePut}`}>
                      {item.side.toUpperCase()}
                    </span>
                  </td>
                  <td className={styles.mono}>{formatPremium(item.premium)}</td>
                  <td className={styles.mono}>{formatNumber(item.volume)}</td>
                  <td className={styles.mono}>{formatNumber(item.openInterest)}</td>
                  <td className={styles.mono}>{item.volumeOIRatio.toFixed(1)}×</td>
                  {/* IV column */}
                  <td className={styles.mono}>{formatIV(item.rawIV ?? item.ivZScore)}</td>
                  {/* ΔIV column */}
                  <td
                    className={`${styles.mono} ${
                      item.ivDelta == null
                        ? ''
                        : item.ivDelta >= 0.10
                        ? styles.ivSpikeUp
                        : item.ivDelta <= -0.05
                        ? styles.ivSpikeDown
                        : ''
                    }`}
                  >
                    {item.ivDelta != null
                      ? (item.ivDelta >= 0 ? '▲' : '▼') + ' ' + formatIVDelta(item.ivDelta)
                      : '—'}
                  </td>
                  {/* Stock Δ column */}
                  <td
                    className={`${styles.mono} ${
                      item.stockChangePercent == null
                        ? ''
                        : item.stockChangePercent >= 0
                        ? styles.stockUp
                        : styles.stockDown
                    }`}
                  >
                    {formatStockChange(item.stockChangePercent)}
                  </td>
                  <td>
                    <div className={`${styles.sigmaBadge} ${getSigmaClass(item.compositeSigma)}`}>
                      <span className={styles.sigmaValue}>{item.compositeSigma.toFixed(0)}</span>
                      <span className={styles.sigmaLabel}>{getSigmaLabel(item.compositeSigma)}</span>
                      {item.flagReasons.length > 0 && (
                        <div className={styles.tooltip}>
                          {item.flagReasons.map((reason, idx) => (
                            <div key={idx}>• {reason}</div>
                          ))}
                        </div>
                      )}
                    </div>
                  </td>
                  <td className={styles.leftAlign}>
                    <div className={styles.flagList}>
                      {item.earningsBeforeExpiry && (
                        <span className={styles.earningsChip} title="Earnings before expiry — event-driven flow">🗓 Earnings</span>
                      )}
                      {item.flagReasons.slice(0, 2).map((reason, idx) => (
                        <span key={idx} className={styles.flagChip}>{reason}</span>
                      ))}
                      {item.flagReasons.length > 2 && (
                        <span className={styles.flagMore}>+{item.flagReasons.length - 2} more</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};
