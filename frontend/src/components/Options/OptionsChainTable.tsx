import React, { useState, useEffect, useMemo } from 'react';
import { api } from '../../lib/api';
import type { OptionsContract, OptionsChainResponse } from '../../types';
import { getWhaleTier, isWhaleFlow, computeWhaleScore, resolveContractPrice } from '../../lib/whaleFlow';
import styles from './OptionsChainTable.module.css';

interface OptionsChainTableProps {
  symbol: string | null;
  activeExpiry: string | null;
  underlyingPrice: number;
}

const formatNumber = (num: number) => {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
};

const getIvColorClass = (iv: number) => {
  if (iv < 0.3) return styles.ivLow;
  if (iv < 0.6) return styles.ivMed;
  return styles.ivHigh;
};

const getContractWhaleScore = (contract?: OptionsContract): number | null => {
  if (!contract) return null;
  if (contract.whaleScore != null) return contract.whaleScore;

  const price = resolveContractPrice(contract.bid, contract.ask, contract.mid, contract.last);
  return computeWhaleScore({
    volume: contract.volume,
    openInterest: contract.openInterest,
    price,
    dte: contract.dte,
  });
};

const getWhaleClass = (contract?: OptionsContract, side: 'call' | 'put' = 'call') => {
  const tier = getWhaleTier(getContractWhaleScore(contract));
  if (!tier) return '';
  if (side === 'call') {
    if (tier === 'extreme') return styles.whaleFlowCallExtreme;
    if (tier === 'high') return styles.whaleFlowCallHigh;
    return styles.whaleFlowCallElevated;
  }
  if (tier === 'extreme') return styles.whaleFlowPutExtreme;
  if (tier === 'high') return styles.whaleFlowPutHigh;
  return styles.whaleFlowPutElevated;
};

export const OptionsChainTable: React.FC<OptionsChainTableProps> = ({ symbol, activeExpiry, underlyingPrice: _underlyingPrice }) => {
  const [data, setData] = useState<OptionsChainResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [highlightWhaleFlow, setHighlightWhaleFlow] = useState<boolean>(false);

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

  const whaleCount = useMemo(() => {
    if (!data || !activeExpiry || !data.chain[activeExpiry]) return 0;
    return data.chain[activeExpiry].filter(c => isWhaleFlow(getContractWhaleScore(c))).length;
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
      <div className={styles.controlsBar}>
        <label className={styles.toggleLabel}>
          <input 
            type="checkbox" 
            checked={highlightWhaleFlow}
            onChange={e => setHighlightWhaleFlow(e.target.checked)}
          />
          Highlight Whale Flow 🐋
        </label>
        {whaleCount > 0 && (
          <span className={styles.whaleCount}>
            {whaleCount} whale contract{whaleCount === 1 ? '' : 's'} detected
          </span>
        )}
      </div>

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
                const callWhaleClass = highlightWhaleFlow && isWhaleFlow(getContractWhaleScore(call)) ? getWhaleClass(call, 'call') : '';
                const putWhaleClass = highlightWhaleFlow && isWhaleFlow(getContractWhaleScore(put)) ? getWhaleClass(put, 'put') : '';
                return (
                <tr key={strike}>
                  {/* Call Side */}
                  <td className={`${call?.itm ? styles.callItm : ''} ${callWhaleClass}`}>
                    {call && <button className={`${styles.addBtn} ${styles.callAdd}`} onClick={() => handleAddPosition(call)}>+</button>}
                    {call ? formatNumber(call.volume) : '-'}
                  </td>
                  <td className={`${call?.itm ? styles.callItm : ''} ${callWhaleClass}`}>{call ? formatNumber(call.openInterest) : '-'}</td>
                  <td className={`${call?.itm ? styles.callItm : ''} ${callWhaleClass} ${call ? getIvColorClass(call.impliedVolatility) : ''}`}>
                    {call ? (call.impliedVolatility * 100).toFixed(1) + '%' : '-'}
                  </td>
                  <td className={`${call?.itm ? styles.callItm : ''} ${callWhaleClass}`}>{call?.bid.toFixed(2) || '-'}</td>
                  <td className={`${call?.itm ? styles.callItm : ''} ${callWhaleClass}`}>{call?.ask.toFixed(2) || '-'}</td>
                  <td className={`${call?.itm ? styles.callItm : ''} ${callWhaleClass}`}>{call?.delta.toFixed(2) || '-'}</td>
                  <td className={`${call?.itm ? styles.callItm : ''} ${callWhaleClass}`}>{call?.gamma.toFixed(3) || '-'}</td>
                  <td className={`${call?.itm ? styles.callItm : ''} ${callWhaleClass}`}>{call?.theta.toFixed(3) || '-'}</td>
                  
                  {/* Strike */}
                  <td className={styles.strikeCell}>{strike.toFixed(2)}</td>

                  {/* Put Side */}
                  <td className={`${put?.itm ? styles.putItm : ''} ${putWhaleClass}`}>{put?.theta.toFixed(3) || '-'}</td>
                  <td className={`${put?.itm ? styles.putItm : ''} ${putWhaleClass}`}>{put?.gamma.toFixed(3) || '-'}</td>
                  <td className={`${put?.itm ? styles.putItm : ''} ${putWhaleClass}`}>{put?.delta.toFixed(2) || '-'}</td>
                  <td className={`${put?.itm ? styles.putItm : ''} ${putWhaleClass}`}>{put?.bid.toFixed(2) || '-'}</td>
                  <td className={`${put?.itm ? styles.putItm : ''} ${putWhaleClass}`}>{put?.ask.toFixed(2) || '-'}</td>
                  <td className={`${put?.itm ? styles.putItm : ''} ${putWhaleClass} ${put ? getIvColorClass(put.impliedVolatility) : ''}`}>
                    {put ? (put.impliedVolatility * 100).toFixed(1) + '%' : '-'}
                  </td>
                  <td className={`${put?.itm ? styles.putItm : ''} ${putWhaleClass}`}>{put ? formatNumber(put.openInterest) : '-'}</td>
                  <td className={`${put?.itm ? styles.putItm : ''} ${putWhaleClass}`}>
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
