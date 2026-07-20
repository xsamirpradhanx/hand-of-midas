import React from 'react';
import type { QuoteResponse } from '../../types';
import { formatPrice } from '../../lib/chartHelpers';
import styles from './WatchlistPanel.module.css';

interface WatchlistItemProps {
  symbol: string;
  quote?: QuoteResponse;
  isSelected: boolean;
  onSelect: () => void;
  onRemove: () => void;
}

export const WatchlistItem: React.FC<WatchlistItemProps> = ({ 
  symbol, quote, isSelected, onSelect, onRemove 
}) => {
  const isPositive = quote && quote.change >= 0;
  
  return (
    <div 
      className={`${styles.item} ${isSelected ? styles.selected : ''}`}
      onClick={onSelect}
    >
      <div className={styles.itemInfo}>
        <span className={styles.symbol}>{symbol}</span>
        {quote && <span className={styles.name}>{quote.name || symbol}</span>}
      </div>
      
      {quote && (
        <div className={styles.itemData}>
          <span className={styles.price}>{formatPrice(quote.price)}</span>
          <span className={`${styles.change} ${isPositive ? styles.positive : styles.negative}`}>
            {isPositive ? '▲' : '▼'} {Math.abs(quote.changePercent).toFixed(2)}%
          </span>
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
