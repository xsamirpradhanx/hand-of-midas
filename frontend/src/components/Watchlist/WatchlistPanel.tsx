import React, { useState, useEffect, useRef } from 'react';
import { api } from '../../lib/api';
import type { WatchlistEntry, QuoteResponse } from '../../types';
import { WatchlistItem } from './WatchlistItem';
import { AddTickerModal } from './AddTickerModal';
import styles from './WatchlistPanel.module.css';

interface WatchlistPanelProps {
  selectedSymbol: string | null;
  onSelectSymbol: (symbol: string) => void;
  showExtendedHours: boolean;
}

export const WatchlistPanel: React.FC<WatchlistPanelProps> = ({ selectedSymbol, onSelectSymbol, showExtendedHours }) => {
  const [entries, setEntries] = useState<WatchlistEntry[]>([]);
  const [quotes, setQuotes] = useState<Record<string, QuoteResponse>>({});
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('watchlist_collapsed') === 'true';
    } catch {
      return false;
    }
  });
  const [flashSymbols, setFlashSymbols] = useState<Record<string, 'up' | 'down'>>({});
  const prevPricesRef = useRef<Record<string, number>>({});

  const toggleCollapse = () => {
    setIsCollapsed(prev => {
      const next = !prev;
      try {
        localStorage.setItem('watchlist_collapsed', String(next));
      } catch (err) {
        console.warn(err);
      }
      return next;
    });
  };

  const fetchWatchlist = async () => {
    try {
      const data = await api.getWatchlist();
      setEntries(data || []);
    } catch (err) {
      console.error('Failed to fetch watchlist', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchQuotes = async (currentEntries: WatchlistEntry[]) => {
    if (currentEntries.length === 0) return;
    try {
      const quotesData: Record<string, QuoteResponse> = {};
      for (const entry of currentEntries) {
        const q = await api.getQuote(entry.symbol);
        quotesData[entry.symbol] = q;
      }

      // Detect price changes for flash animation
      const changes: Record<string, 'up' | 'down'> = {};
      for (const symbol in quotesData) {
        const newPrice = quotesData[symbol].price;
        const prevPrice = prevPricesRef.current[symbol];
        if (prevPrice !== undefined && prevPrice !== newPrice) {
          changes[symbol] = newPrice > prevPrice ? 'up' : 'down';
        }
        prevPricesRef.current[symbol] = newPrice;
      }

      setQuotes(quotesData);

      if (Object.keys(changes).length > 0) {
        setFlashSymbols(changes);
        setTimeout(() => setFlashSymbols({}), 600);
      }
    } catch (err) {
      console.error('Failed to fetch quotes', err);
    }
  };

  useEffect(() => {
    fetchWatchlist();
  }, []);

  useEffect(() => {
    if (entries.length === 0) return;

    fetchQuotes(entries);

    const interval = setInterval(() => fetchQuotes(entries), 30000);
    return () => clearInterval(interval);
  }, [entries]);

  const handleAddTicker = async (symbol: string) => {
    await api.addToWatchlist(symbol);
    await fetchWatchlist();
    setIsModalOpen(false);
  };

  const handleRemoveTicker = async (symbol: string) => {
    await api.removeFromWatchlist(symbol);
    await fetchWatchlist();
    if (selectedSymbol === symbol) {
      onSelectSymbol('');
    }
  };

  return (
    <div className={`${styles.panel} ${isCollapsed ? styles.collapsed : ''}`}>
      <div className={styles.header}>
        {!isCollapsed && <h2>Watchlist</h2>}
        <div className={styles.headerActions}>
          <button onClick={() => setIsModalOpen(true)} className={styles.addBtn} title="Add Ticker">+</button>
          <button onClick={toggleCollapse} className={styles.collapseBtn} title={isCollapsed ? "Expand Watchlist" : "Collapse Watchlist"}>
            {isCollapsed ? '»' : '«'}
          </button>
        </div>
      </div>

      <div className={styles.list}>
        {loading ? (
          <div className={styles.emptyState}>{isCollapsed ? '...' : 'Loading...'}</div>
        ) : entries.length === 0 ? (
          <div className={styles.emptyState}>{isCollapsed ? '+' : 'Add tickers to get started'}</div>
        ) : (
          entries.map(entry => {
            const quote = quotes[entry.symbol];
            if (isCollapsed) {
              const isPositive = (quote?.change ?? 0) >= 0;
              const priceStr = quote
                ? `$${quote.price.toFixed(2)} (${isPositive ? '+' : ''}${quote.changePercent.toFixed(2)}%)`
                : 'Loading quote...';
              return (
                <div
                  key={entry.symbol}
                  className={`${styles.collapsedItem} ${selectedSymbol === entry.symbol ? styles.selected : ''}`}
                  onClick={() => onSelectSymbol(entry.symbol)}
                  title={`${entry.symbol}: ${priceStr}`}
                >
                  <span className={styles.collapsedSymbol}>{entry.symbol.length > 5 ? entry.symbol.slice(0, 4) : entry.symbol}</span>
                  {quote && (
                    <span className={`${styles.collapsedDot} ${isPositive ? styles.positiveDot : styles.negativeDot}`} />
                  )}
                </div>
              );
            }
            return (
              <WatchlistItem
                key={entry.symbol}
                symbol={entry.symbol}
                quote={quote}
                isSelected={selectedSymbol === entry.symbol}
                showExtendedHours={showExtendedHours}
                flashDirection={flashSymbols[entry.symbol]}
                onSelect={() => onSelectSymbol(entry.symbol)}
                onRemove={() => handleRemoveTicker(entry.symbol)}
              />
            );
          })
        )}
      </div>

      {isModalOpen && (
        <AddTickerModal
          onClose={() => setIsModalOpen(false)}
          onAdd={handleAddTicker}
        />
      )}
    </div>
  );
};
