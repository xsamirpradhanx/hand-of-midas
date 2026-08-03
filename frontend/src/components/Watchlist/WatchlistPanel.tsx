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

function getDisplayChangePercent(quote?: QuoteResponse, showExtendedHours?: boolean) {
  if (!quote) return -Infinity;
  const isExtendedMarket = quote.marketState ? quote.marketState !== 'REGULAR' : true;
  if (showExtendedHours && isExtendedMarket && quote.preMarketChangePercent != null) {
    return quote.preMarketChangePercent;
  }
  return quote.changePercent || 0;
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
  
  const dragItem = useRef<number | null>(null);
  const dragOverItem = useRef<number | null>(null);
  const [isSortMenuOpen, setIsSortMenuOpen] = useState(false);
  const sortMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (sortMenuRef.current && !sortMenuRef.current.contains(event.target as Node)) {
        setIsSortMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

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

  const handleDragStart = (e: React.DragEvent, position: number) => {
    dragItem.current = position;
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragEnter = (e: React.DragEvent, position: number) => {
    dragOverItem.current = position;
  };

  const handleDragEnd = async () => {
    if (dragItem.current !== null && dragOverItem.current !== null && dragItem.current !== dragOverItem.current) {
      const newEntries = [...entries];
      const draggedItemContent = newEntries[dragItem.current];
      newEntries.splice(dragItem.current, 1);
      newEntries.splice(dragOverItem.current, 0, draggedItemContent);
      setEntries(newEntries);
      await api.reorderWatchlist(newEntries.map(e => e.symbol));
    }
    dragItem.current = null;
    dragOverItem.current = null;
  };

  const handleSortOption = async (mode: 'name_asc' | 'name_desc' | 'percent_up' | 'percent_down') => {
    setIsSortMenuOpen(false);
    if (entries.length === 0) return;
    
    const sortedEntries = [...entries].sort((a, b) => {
      if (mode === 'name_asc') return a.symbol.localeCompare(b.symbol);
      if (mode === 'name_desc') return b.symbol.localeCompare(a.symbol);
      
      const aPct = getDisplayChangePercent(quotes[a.symbol], showExtendedHours);
      const bPct = getDisplayChangePercent(quotes[b.symbol], showExtendedHours);
      
      if (mode === 'percent_up') return bPct - aPct;
      if (mode === 'percent_down') return aPct - bPct;
      
      return 0;
    });
    
    setEntries(sortedEntries);
    await api.reorderWatchlist(sortedEntries.map(e => e.symbol));
  };

  return (
    <div className={`${styles.panel} ${isCollapsed ? styles.collapsed : ''}`}>
      <div className={styles.header}>
        {!isCollapsed && <h2>Watchlist</h2>}
        <div className={styles.headerActions}>
          <div className={styles.sortContainer} ref={sortMenuRef}>
            <button onClick={() => setIsSortMenuOpen(!isSortMenuOpen)} className={styles.sortBtn} title="Sort Options">
              ↕
            </button>
            {isSortMenuOpen && (
              <div className={styles.sortMenu}>
                <div className={styles.sortMenuItem} onClick={() => handleSortOption('name_asc')}>Name (A-Z)</div>
                <div className={styles.sortMenuItem} onClick={() => handleSortOption('name_desc')}>Name (Z-A)</div>
                <div className={styles.sortMenuItem} onClick={() => handleSortOption('percent_up')}>% Up (High to Low)</div>
                <div className={styles.sortMenuItem} onClick={() => handleSortOption('percent_down')}>% Down (Low to High)</div>
              </div>
            )}
          </div>
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
          entries.map((entry, index) => {
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
                draggable={!isCollapsed}
                onDragStart={(e) => handleDragStart(e, index)}
                onDragEnter={(e) => handleDragEnter(e, index)}
                onDragEnd={handleDragEnd}
                onDragOver={(e) => e.preventDefault()}
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
