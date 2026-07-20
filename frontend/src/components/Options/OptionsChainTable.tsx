import React, { useState, useEffect, useMemo } from 'react';
import { api } from '../../lib/api';
import type { OptionsContract, OptionsChainResponse } from '../../types';
import styles from './OptionsChainTable.module.css';

interface OptionsChainTableProps {
  symbol: string | null;
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

export const OptionsChainTable: React.FC<OptionsChainTableProps> = ({ symbol, underlyingPrice: _underlyingPrice }) => {
  const [data, setData] = useState<OptionsChainResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [activeExpiry, setActiveExpiry] = useState<string | null>(null);

  useEffect(() => {
    if (!symbol) {
      setData(null);
      setActiveExpiry(null);
      return;
    }

    let isMounted = true;
    setLoading(true);
    setError(null);

    api.getOptionsChain(symbol)
      .then(res => {
        if (!isMounted) return;
        setData(res);
        if (res.expirations.length > 0) {
          setActiveExpiry(res.expirations[0]);
        }
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
  }, [symbol]);

  const handleExpiryChange = async (expiry: string) => {
    if (!symbol) return;
    setActiveExpiry(expiry);
    setLoading(true);
    setError(null);
    try {
      const res = await api.getOptionsChain(symbol, expiry);
      setData(res);
    } catch (err: any) {
      console.error('Failed to load expiry:', err);
      if (err.message && err.message.includes('403 Forbidden')) {
        setError('Polygon Options API requires a premium subscription tier.');
      } else {
        setError(err.message || 'Failed to load options chain for this expiry.');
      }
    } finally {
      setLoading(false);
    }
  };

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
      <div className={styles.header}>
        {data?.expirations.map(exp => (
          <button
            key={exp}
            className={`${styles.expiryTab} ${activeExpiry === exp ? styles.expiryTabActive : ''}`}
            onClick={() => handleExpiryChange(exp)}
          >
            {exp}
          </button>
        ))}
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
              {rows.map(({ strike, call, put }) => (
                <tr key={strike}>
                  {/* Call Side */}
                  <td className={call?.itm ? styles.callItm : ''}>
                    {call && <button className={`${styles.addBtn} ${styles.callAdd}`} onClick={() => handleAddPosition(call)}>+</button>}
                    {call ? formatNumber(call.volume) : '-'}
                  </td>
                  <td className={call?.itm ? styles.callItm : ''}>{call ? formatNumber(call.openInterest) : '-'}</td>
                  <td className={`${call?.itm ? styles.callItm : ''} ${call ? getIvColorClass(call.impliedVolatility) : ''}`}>
                    {call ? (call.impliedVolatility * 100).toFixed(1) + '%' : '-'}
                  </td>
                  <td className={call?.itm ? styles.callItm : ''}>{call?.bid.toFixed(2) || '-'}</td>
                  <td className={call?.itm ? styles.callItm : ''}>{call?.ask.toFixed(2) || '-'}</td>
                  <td className={call?.itm ? styles.callItm : ''}>{call?.delta.toFixed(2) || '-'}</td>
                  <td className={call?.itm ? styles.callItm : ''}>{call?.gamma.toFixed(3) || '-'}</td>
                  <td className={call?.itm ? styles.callItm : ''}>{call?.theta.toFixed(3) || '-'}</td>
                  
                  {/* Strike */}
                  <td className={styles.strikeCell}>{strike.toFixed(2)}</td>

                  {/* Put Side */}
                  <td className={put?.itm ? styles.putItm : ''}>{put?.theta.toFixed(3) || '-'}</td>
                  <td className={put?.itm ? styles.putItm : ''}>{put?.gamma.toFixed(3) || '-'}</td>
                  <td className={put?.itm ? styles.putItm : ''}>{put?.delta.toFixed(2) || '-'}</td>
                  <td className={put?.itm ? styles.putItm : ''}>{put?.bid.toFixed(2) || '-'}</td>
                  <td className={put?.itm ? styles.putItm : ''}>{put?.ask.toFixed(2) || '-'}</td>
                  <td className={`${put?.itm ? styles.putItm : ''} ${put ? getIvColorClass(put.impliedVolatility) : ''}`}>
                    {put ? (put.impliedVolatility * 100).toFixed(1) + '%' : '-'}
                  </td>
                  <td className={put?.itm ? styles.putItm : ''}>{put ? formatNumber(put.openInterest) : '-'}</td>
                  <td className={put?.itm ? styles.putItm : ''}>
                    {put ? formatNumber(put.volume) : '-'}
                    {put && <button className={`${styles.addBtn} ${styles.putAdd}`} onClick={() => handleAddPosition(put)}>+</button>}
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
