import React, { useState } from 'react';
import { MarketInternals } from './MarketInternals';
import { SectorHeatmap } from './SectorHeatmap';
import { MOBILE_QUERY } from '../../hooks/useMediaQuery';
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
  // Expanded by default on desktop, collapsed on a phone: the two strips cost ~185px
  // of an 812px viewport, and the chart — not the market ribbon — is what someone
  // opens this app to look at. Still a stored preference, so an explicit tap sticks.
  const defaultOpen =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? !window.matchMedia(MOBILE_QUERY).matches
      : true;
  const [isMarketOverviewOpen, setIsMarketOverviewOpen] = useLocalStorage<boolean>('dashboard_marketOverviewOpen', defaultOpen);

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
        aria-label={isMarketOverviewOpen ? 'Hide market overview' : 'Show market overview'}
        aria-expanded={isMarketOverviewOpen}
      >
        {isMarketOverviewOpen ? '▲' : '▼'}
      </button>
    </div>
  );
};
