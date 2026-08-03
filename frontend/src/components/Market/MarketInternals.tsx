import React, { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { MarketInternalsResponse } from '../../types';
import styles from './MarketInternals.module.css';

export const MarketInternals: React.FC = () => {
  const [data, setData] = useState<MarketInternalsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    const fetchInternals = async () => {
      try {
        const res = await api.getMarketInternals();
        if (mounted) {
          setData(res);
        }
      } catch (err) {
        console.error('Failed to fetch market internals', err);
      } finally {
        if (mounted) setLoading(false);
      }
    };

    fetchInternals();
    const interval = setInterval(fetchInternals, 15000); // refresh every 15s

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  if (loading && !data) {
    return <div className={styles.container}><div className={styles.loading}>Loading Market Internals...</div></div>;
  }

  if (!data) {
    return null;
  }

  const formatPercent = (val: number) => `${val > 0 ? '+' : ''}${val.toFixed(2)}%`;
  const getColorClass = (val: number) => val > 0 ? styles.positive : val < 0 ? styles.negative : styles.neutral;

  return (
    <div className={styles.container}>
      <div className={styles.scrollWrapper}>
        <div className={`${styles.item} ${getColorClass(data.vix.changePercent)}`}>
          <span className={styles.symbol}>VIX</span>
          <span className={styles.price}>{data.vix.price.toFixed(2)}</span>
          <span className={styles.change}>
            {formatPercent(data.vix.changePercent)}
          </span>
        </div>
        <div className={styles.divider} />
        
        {data.indices.map((idx) => (
          <React.Fragment key={idx.symbol}>
            <div className={`${styles.item} ${getColorClass(idx.changePercent)}`}>
              <span className={styles.symbol}>{idx.symbol}</span>
              <span className={styles.price}>{idx.price.toFixed(2)}</span>
              <span className={styles.change}>
                {formatPercent(idx.changePercent)}
              </span>
            </div>
            <div className={styles.divider} />
          </React.Fragment>
        ))}

        {data.bonds?.map((item) => (
          <React.Fragment key={item.symbol}>
            <div className={`${styles.item} ${getColorClass(item.changePercent)}`}>
              <span className={styles.symbol}>{item.symbol === '^TNX' ? 'US 10Y' : item.symbol === '^TYX' ? 'US 30Y' : item.symbol === '^FVX' ? 'US 5Y' : item.symbol}</span>
              <span className={styles.price}>{item.price.toFixed(3)}</span>
              <span className={styles.change}>
                {formatPercent(item.changePercent)}
              </span>
            </div>
            <div className={styles.divider} />
          </React.Fragment>
        ))}

        {data.commodities.map((item) => (
          <React.Fragment key={item.symbol}>
            <div className={`${styles.item} ${getColorClass(item.changePercent)}`}>
              <span className={styles.symbol}>{item.name === 'Gold' || item.symbol === 'GC=F' ? 'Gold' : item.name === 'Silver' || item.symbol === 'SI=F' ? 'Silver' : item.name === 'Crude Oil' || item.symbol === 'CL=F' ? 'Oil' : item.symbol === 'KC=F' ? 'Coffee' : item.symbol}</span>
              <span className={styles.price}>{item.price.toFixed(2)}</span>
              <span className={styles.change}>
                {formatPercent(item.changePercent)}
              </span>
            </div>
            <div className={styles.divider} />
          </React.Fragment>
        ))}

        {data.crypto.map((item) => (
          <React.Fragment key={item.symbol}>
            <div className={`${styles.item} ${getColorClass(item.changePercent)}`}>
              <span className={styles.symbol}>{item.symbol.replace('-USD', '')}</span>
              <span className={styles.price}>{item.price.toFixed(2)}</span>
              <span className={styles.change}>
                {formatPercent(item.changePercent)}
              </span>
            </div>
            <div className={styles.divider} />
          </React.Fragment>
        ))}

        {data.forex?.map((item, i) => (
          <React.Fragment key={item.symbol}>
            <div className={`${styles.item} ${getColorClass(item.changePercent)}`}>
              <span className={styles.symbol}>{item.symbol === 'DX-Y.NYB' ? 'DXY' : item.symbol.replace('=X', '')}</span>
              <span className={styles.price}>{item.price.toFixed(4)}</span>
              <span className={styles.change}>
                {formatPercent(item.changePercent)}
              </span>
            </div>
            {i < data.forex.length - 1 && <div className={styles.divider} />}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
};
