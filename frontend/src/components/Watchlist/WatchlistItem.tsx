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
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnter?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
}

export const WatchlistItem: React.FC<WatchlistItemProps> = ({
  symbol, quote, isSelected, showExtendedHours, flashDirection, onSelect, onRemove,
  draggable, onDragStart, onDragEnter, onDragEnd, onDragOver
}) => {
  const isExtendedMarket = quote?.marketState ? quote.marketState !== 'REGULAR' : true;
  
  const displayPrice = showExtendedHours && isExtendedMarket && quote?.preMarketPrice != null 
    ? quote.preMarketPrice 
    : quote?.price;
    
  const displayChangePercent = showExtendedHours && isExtendedMarket && quote?.preMarketChangePercent != null
    ? quote.preMarketChangePercent
    : quote?.changePercent;

  const displayChange = showExtendedHours && isExtendedMarket && quote?.preMarketChange != null
    ? quote.preMarketChange
    : quote?.change;

  const isPositive = displayChangePercent != null && displayChangePercent >= 0;

  return (
    <div
      className={`${styles.item} ${isSelected ? styles.selected : ''}`}
      onClick={onSelect}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnter={onDragEnter}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
    >
      <div className={styles.itemInfo}>
        <span className={styles.symbol}>{symbol}</span>
        {/* Always render name row to keep fixed height — skeleton when loading */}
        <span className={styles.name}>
          {quote
            ? (quote.name && quote.name !== symbol ? quote.name : symbol)
            : <span className={styles.skeletonText} />}
        </span>
      </div>

      <div className={styles.itemData}>
        {displayPrice != null ? (
          <>
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
          </>
        ) : (
          /* Skeleton placeholders preserve tile height before data arrives */
          <>
            <span className={`${styles.price} ${styles.skeletonPrice}`} />
            <span className={`${styles.change} ${styles.skeletonChange}`} />
            <span className={styles.skeletonChangeDollar} />
          </>
        )}
      </div>

      <div className={styles.itemActions}>
        <button
          className={styles.removeBtn}
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          title="Remove"
        >
          ×
        </button>
      </div>
    </div>
  );
};
