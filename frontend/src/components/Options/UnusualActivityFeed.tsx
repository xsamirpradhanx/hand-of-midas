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

type SortKey = keyof UnusualActivityItem;

export const UnusualActivityFeed: React.FC<UnusualActivityFeedProps> = ({ initialSymbol = '' }) => {
  const [data, setData] = useState<UnusualActivityItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [countdown, setCountdown] = useState(60);

  // Filters
  const [symbolFilter, setSymbolFilter] = useState(initialSymbol);
  const [minSigma, setMinSigma] = useState(50);
  const [sideFilter, setSideFilter] = useState('all');
  const [dteMax, setDteMax] = useState(30);

  // Sorting
  const [sortKey, setSortKey] = useState<SortKey>('compositeSigma');
  const [sortDesc, setSortDesc] = useState(true);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await api.getUnusualActivity({
        symbol: symbolFilter || undefined,
        minSigma,
        side: sideFilter,
        dteMax
      });
      setData(res || []);
    } catch (err) {
      console.error('Failed to load unusual activity:', err);
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

  return (
    <div className={styles.container}>
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
          <span className={styles.filterLabel}>Min Score</span>
          <input
            type="range"
            min="10"
            max="1000"
            step="10"
            value={minSigma}
            onChange={(e) => setMinSigma(parseFloat(e.target.value))}
          />
          <span className={styles.filterLabel}>{minSigma.toFixed(1)}</span>
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
          {loading ? 'Refreshing...' : `Refreshes in ${countdown}s`}
        </div>
      </div>

      <div className={styles.tableWrapper}>
        {data.length === 0 && !loading ? (
          <div className={styles.emptyState}>No unusual activity detected matching your filters</div>
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
                <th onClick={() => handleSort('compositeSigma')}>Whale Score</th>
                <th className={styles.leftAlign}>Flags</th>
              </tr>
            </thead>
            <tbody>
              {sortedData.map((item, i) => (
                <tr key={i}>
                  <td className={`${styles.leftAlign} ${styles.symbol}`}>
                    {item.isSweep && <span className={styles.sweepIcon}>⚡</span>}
                    {item.symbol}
                  </td>
                  <td>{item.strike}</td>
                  <td>{item.expiry}</td>
                  <td>{item.dte}</td>
                  <td>
                    <span className={`${styles.sideBadge} ${item.side === 'call' ? styles.sideCall : styles.sidePut}`}>
                      {item.side.toUpperCase()}
                    </span>
                  </td>
                  <td>{formatPremium(item.premium)}</td>
                  <td>{formatNumber(item.volume)}</td>
                  <td>{formatNumber(item.openInterest)}</td>
                  <td>{item.volumeOIRatio.toFixed(2)}x</td>
                  <td>
                    <div className={`${styles.sigmaBadge} ${getSigmaClass(item.compositeSigma)}`}>
                      {item.compositeSigma.toFixed(2)}
                      {item.flagReasons.length > 0 && (
                        <div className={styles.tooltip}>
                          {item.flagReasons.map((reason, idx) => (
                            <div key={idx}>• {reason}</div>
                          ))}
                        </div>
                      )}
                    </div>
                  </td>
                  <td className={styles.leftAlign}>{item.flagReasons.length} Flags</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};
