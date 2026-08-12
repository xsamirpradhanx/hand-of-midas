import React, { useState } from 'react';
import { MarketInternals } from './MarketInternals';
import { SectorHeatmap } from './SectorHeatmap';
import styles from './MarketOverview.module.css';

function useLocalStorage<T>(key: string, initialValue: T): [T, (value: T | ((val: T) => T)) => void] {
  const [storedValue, setStoredValue] = useState<T>(() => {
    try {
      const item = window.localStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
    } catch (error) {
      console.warn(error);
      return initialValue;
    }
  });

  const setValue = (value: T | ((val: T) => T)) => {
    try {
      const valueToStore = value instanceof Function ? value(storedValue) : value;
      setStoredValue(valueToStore);
      window.localStorage.setItem(key, JSON.stringify(valueToStore));
    } catch (error) {
      console.warn(error);
    }
  };

  return [storedValue, setValue];
}

export const MarketOverview: React.FC = () => {
  const [isMarketOverviewOpen, setIsMarketOverviewOpen] = useLocalStorage<boolean>('dashboard_marketOverviewOpen', true);

  return (
    <div className={styles.marketOverviewWrapper}>
      {isMarketOverviewOpen && (
        <div className={styles.marketOverviewStrip}>
          <MarketInternals />
          <SectorHeatmap />
        </div>
      )}
      <button 
        className={styles.marketToggleBtn}
        onClick={() => setIsMarketOverviewOpen(!isMarketOverviewOpen)}
        title="Toggle Market Overview"
      >
        {isMarketOverviewOpen ? '▲' : '▼'}
      </button>
    </div>
  );
};
