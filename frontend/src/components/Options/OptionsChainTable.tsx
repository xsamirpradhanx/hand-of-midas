import React, { useState, useEffect, useMemo } from 'react';
import { api } from '../../lib/api';
import type { OptionsContract, OptionsChainResponse } from '../../types';
import styles from './OptionsChainTable.module.css';

interface OptionsChainTableProps {
  symbol: string | null;
  activeExpiry: string | null;
  underlyingPrice: number;
  highlightWhaleFlow?: boolean;
}

const formatNumber = (num: number) => {
  return num.toLocaleString();
};

const getIvColorClass = (iv: number) => {
  if (iv < 0.3) return styles.ivLow;
  if (iv < 0.6) return styles.ivMed;
  return styles.ivHigh;
};

export const OptionsChainTable: React.FC<OptionsChainTableProps> = ({
  symbol,
  activeExpiry,
  underlyingPrice: _underlyingPrice,
  highlightWhaleFlow = false,
}) => {
  const [data, setData] = useState<OptionsChainResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!symbol || !activeExpiry) {
      setData(null);
      return;
    }

    let isMounted = true;
    setLoading(true);
    setError(null);

    api.getOptionsChain(symbol, activeExpiry)
      .then(res => {
        if (!isMounted) return;
        setData(res);
        setLoading(false);
      })
      .catch(err => {
        console.error('Failed to load options chain:', err);
        if (isMounted) {
          if (err.message && err.message.includes('403 Forbidden')) {
             setError('Polygon Options API requires a premium subscription tier. Your current API key does not have access.');
          } else {
             setError(err.message || 'Failed to load options chain');
          }
          setLoading(false);
        }
      });

    return () => { isMounted = false; };
  }, [symbol, activeExpiry]);

  const handleAddPosition = (contract: OptionsContract) => {
    api.addPosition({
      symbol: contract.symbol,
      type: 'option',
      strategy: 'Long Option',
      legs: [{
        ticker: contract.ticker,
        quantity: 1,
        costBasis: contract.ask * 100,
        optionDetails: {
          strike: contract.strike,
          expiry: contract.expiry,
          type: contract.type,
          multiplier: 100,
        }
      }],
      openDate: new Date().toISOString()
    }).catch(console.error);
  };

  const rows = useMemo(() => {
    if (!data || !activeExpiry || !data.chain[activeExpiry]) return [];
    
    const contracts = data.chain[activeExpiry];
    const strikes = Array.from(new Set(contracts.map(c => c.strike))).sort((a, b) => a - b);
    
    return strikes.map(strike => {
      const call = contracts.find(c => c.strike === strike && c.type === 'call');
      const put = contracts.find(c => c.strike === strike && c.type === 'put');
      return { strike, call, put };
    });
  }, [data, activeExpiry]);

  const topVolumes = useMemo(() => {
    if (!data || !activeExpiry || !data.chain[activeExpiry]) return { call: new Map<number, number>(), put: new Map<number, number>() };
    const contracts = data.chain[activeExpiry];
    
    // Sort calls and puts by volume descending
    const calls = contracts.filter(c => c.type === 'call' && c.volume > 0).sort((a, b) => b.volume - a.volume);
    const puts = contracts.filter(c => c.type === 'put' && c.volume > 0).sort((a, b) => b.volume - a.volume);
    
    const callMap = new Map<number, number>();
    calls.slice(0, 7).forEach((c, index) => callMap.set(c.strike, index));
    
    const putMap = new Map<number, number>();
    puts.slice(0, 7).forEach((c, index) => putMap.set(c.strike, index));
    
    return { call: callMap, put: putMap };
  }, [data, activeExpiry]);

  if (!symbol) {
    return (
      <div className={styles.container}>
        <div className={styles.emptyState}>Select a ticker to view options chain</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.container}>
        <div className={styles.emptyState} style={{ color: '#ff4d4d', maxWidth: '600px', margin: '0 auto', padding: '2rem' }}>
          <h3>Access Denied</h3>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.tableWrapper}>
        {loading ? (
          <div className={styles.tableWrapper} style={{ padding: 'var(--space-md)' }}>
            {[...Array(15)].map((_, i) => (
              <div key={i} className={`skeleton ${styles.skeletonRow}`} />
            ))}
          </div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Vol</th>
                <th>OI</th>
                <th>IV%</th>
                <th>Bid</th>
                <th>Ask</th>
                <th>Δ</th>
                <th>Γ</th>
                <th>Θ</th>
                <th className={styles.strikeCol}>Strike</th>
                <th>Θ</th>
                <th>Γ</th>
                <th>Δ</th>
                <th>Bid</th>
                <th>Ask</th>
                <th>IV%</th>
                <th>OI</th>
                <th>Vol</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ strike, call, put }) => {
                const callRank = highlightWhaleFlow ? topVolumes.call.get(strike) : undefined;
                const putRank = highlightWhaleFlow ? topVolumes.put.get(strike) : undefined;

                const getOpacity = (rank?: number) => {
                  if (rank === undefined) return 0;
                  return 0.5 - (rank * 0.06); // 0.50 down to 0.14
                };

                const callOpacity = getOpacity(callRank);
                const putOpacity = getOpacity(putRank);

                const callStyle = callOpacity > 0 ? { background: `rgba(0, 230, 118, ${callOpacity})` } : {};
                const putStyle = putOpacity > 0 ? { background: `rgba(255, 23, 68, ${putOpacity})` } : {};
                
                return (
                <tr key={strike}>
                  {/* Call Side */}
                  <td className={call?.itm ? styles.callItm : ''} style={callStyle}>
                    {call && <button className={`${styles.addBtn} ${styles.callAdd}`} onClick={() => handleAddPosition(call)}>+</button>}
                    {call ? formatNumber(call.volume) : '-'}
                  </td>
                  <td className={call?.itm ? styles.callItm : ''} style={callStyle}>{call ? formatNumber(call.openInterest) : '-'}</td>
                  <td className={`${call?.itm ? styles.callItm : ''} ${call ? getIvColorClass(call.impliedVolatility) : ''}`} style={callStyle}>
                    {call ? (call.impliedVolatility * 100).toFixed(1) + '%' : '-'}
                  </td>
                  <td className={call?.itm ? styles.callItm : ''} style={callStyle}>{call?.bid.toFixed(2) || '-'}</td>
                  <td className={call?.itm ? styles.callItm : ''} style={callStyle}>{call?.ask.toFixed(2) || '-'}</td>
                  <td className={call?.itm ? styles.callItm : ''} style={callStyle}>{call?.delta.toFixed(2) || '-'}</td>
                  <td className={call?.itm ? styles.callItm : ''} style={callStyle}>{call?.gamma.toFixed(3) || '-'}</td>
                  <td className={call?.itm ? styles.callItm : ''} style={callStyle}>{call?.theta.toFixed(3) || '-'}</td>
                  
                  {/* Strike */}
                  <td className={styles.strikeCell}>{strike.toFixed(2)}</td>

                  {/* Put Side */}
                  <td className={put?.itm ? styles.putItm : ''} style={putStyle}>{put?.theta.toFixed(3) || '-'}</td>
                  <td className={put?.itm ? styles.putItm : ''} style={putStyle}>{put?.gamma.toFixed(3) || '-'}</td>
                  <td className={put?.itm ? styles.putItm : ''} style={putStyle}>{put?.delta.toFixed(2) || '-'}</td>
                  <td className={put?.itm ? styles.putItm : ''} style={putStyle}>{put?.bid.toFixed(2) || '-'}</td>
                  <td className={put?.itm ? styles.putItm : ''} style={putStyle}>{put?.ask.toFixed(2) || '-'}</td>
                  <td className={`${put?.itm ? styles.putItm : ''} ${put ? getIvColorClass(put.impliedVolatility) : ''}`} style={putStyle}>
                    {put ? (put.impliedVolatility * 100).toFixed(1) + '%' : '-'}
                  </td>
                  <td className={put?.itm ? styles.putItm : ''} style={putStyle}>{put ? formatNumber(put.openInterest) : '-'}</td>
                  <td className={put?.itm ? styles.putItm : ''} style={putStyle}>
                    {put ? formatNumber(put.volume) : '-'}
                    {put && <button className={`${styles.addBtn} ${styles.putAdd}`} onClick={() => handleAddPosition(put)}>+</button>}
                  </td>
                </tr>
              )})}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};
