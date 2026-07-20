import React, { useState, useEffect } from 'react';
import { api } from '../../lib/api';
import type { WatchlistEntry, QuoteResponse } from '../../types';
import { WatchlistItem } from './WatchlistItem';
import { AddTickerModal } from './AddTickerModal';
import styles from './WatchlistPanel.module.css';

interface WatchlistPanelProps {
  selectedSymbol: string | null;
  onSelectSymbol: (symbol: string) => void;
}

export const WatchlistPanel: React.FC<WatchlistPanelProps> = ({ selectedSymbol, onSelectSymbol }) => {
  const [entries, setEntries] = useState<WatchlistEntry[]>([]);
  const [quotes, setQuotes] = useState<Record<string, QuoteResponse>>({});
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);

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

  const fetchQuotes = async () => {
    if (entries.length === 0) return;
    try {
      const quotesData: Record<string, QuoteResponse> = {};
      for (const entry of entries) {
        // Run sequentially to avoid rate limits, or batch if backend supports it
        const q = await api.getQuote(entry.symbol);
        quotesData[entry.symbol] = q;
      }
      setQuotes(quotesData);
    } catch (err) {
      console.error('Failed to fetch quotes', err);
    }
  };

  useEffect(() => {
    fetchWatchlist();
  }, []);

  useEffect(() => {
    if (entries.length > 0) {
      fetchQuotes();
    }
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
    <div className={styles.panel}>
      <div className={styles.header}>
        <h2>Watchlist</h2>
        <button onClick={() => setIsModalOpen(true)} className={styles.addBtn}>+</button>
      </div>
      
      <div className={styles.list}>
        {loading ? (
          <div className={styles.emptyState}>Loading...</div>
        ) : entries.length === 0 ? (
          <div className={styles.emptyState}>Add tickers to get started</div>
        ) : (
          entries.map(entry => (
            <WatchlistItem
              key={entry.symbol}
              symbol={entry.symbol}
              quote={quotes[entry.symbol]}
              isSelected={selectedSymbol === entry.symbol}
              onSelect={() => onSelectSymbol(entry.symbol)}
              onRemove={() => handleRemoveTicker(entry.symbol)}
            />
          ))
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
