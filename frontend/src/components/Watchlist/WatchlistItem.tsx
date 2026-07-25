import React from 'react';
import type { QuoteResponse } from '../../types';
import { formatPrice } from '../../lib/chartHelpers';
import styles from './WatchlistPanel.module.css';

interface WatchlistItemProps {
  symbol: string;
  quote?: QuoteResponse;
  isSelected: boolean;
  showExtendedHours?: boolean;
  flashDirection?: 'up' | 'down';
  onSelect: () => void;
  onRemove: () => void;
}

export const WatchlistItem: React.FC<WatchlistItemProps> = ({
  symbol, quote, isSelected, showExtendedHours, flashDirection, onSelect, onRemove
}) => {
  const displayPrice = showExtendedHours && quote?.preMarketPrice != null 
    ? quote.preMarketPrice 
    : quote?.price;
    
  const displayChangePercent = showExtendedHours && quote?.preMarketChangePercent != null
    ? quote.preMarketChangePercent
    : quote?.changePercent;

  const displayChange = showExtendedHours && quote?.preMarketChange != null
    ? quote.preMarketChange
    : quote?.change;

  const isPositive = displayChangePercent != null && displayChangePercent >= 0;

  return (
    <div
      className={`${styles.item} ${isSelected ? styles.selected : ''}`}
      onClick={onSelect}
    >
      <div className={styles.itemInfo}>
        <span className={styles.symbol}>{symbol}</span>
        {quote && <span className={styles.name}>{quote.name || symbol}</span>}
      </div>

      {quote && displayPrice != null && (
        <div className={styles.itemData}>
          <span
            key={`${symbol}_${displayPrice}`}
            className={`${styles.price} ${
              flashDirection === 'up'
                ? styles.priceFlashUp
                : flashDirection === 'down'
                ? styles.priceFlashDown
                : ''
            }`}
          >
            {formatPrice(displayPrice)}
          </span>
          <span className={`${styles.change} ${isPositive ? styles.positive : styles.negative}`}>
            {isPositive ? '▲' : '▼'} {Math.abs(displayChangePercent || 0).toFixed(2)}%
          </span>
          {displayChange != null && (
            <span className={`${styles.changeDollar} ${isPositive ? styles.positive : styles.negative}`}>
              {isPositive ? '+' : ''}{displayChange.toFixed(2)}
            </span>
          )}
        </div>
      )}

      <button
        className={styles.removeBtn}
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        title="Remove"
      >
        ×
      </button>
    </div>
  );
};
