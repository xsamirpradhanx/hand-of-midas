import React, { useState, useEffect, useRef } from 'react';
import { api } from '../../lib/api';
import type { SymbolSearchResult } from '../../types';
import styles from './AddTickerModal.module.css';

interface AddTickerModalProps {
  onClose: () => void;
  onAdd: (symbol: string) => void;
}

export const AddTickerModal: React.FC<AddTickerModalProps> = ({ onClose, onAdd }) => {
  const [symbol, setSymbol] = useState('');
  const [results, setResults] = useState<SymbolSearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const trimmed = symbol.trim();
    if (trimmed.length < 1) {
      setResults([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const data = await api.searchSymbols(trimmed);
        setResults(data);
      } catch {
        setResults([]);
      } finally {
        setIsLoading(false);
      }
    }, 250);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [symbol]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (results.length > 0) {
      const exactMatch = results.find(r => r.symbol === symbol.trim().toUpperCase());
      const ticker = exactMatch ? exactMatch.symbol : results[0].symbol;
      onAdd(ticker);
    }
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h3>Add Ticker</h3>
          <button className={styles.closeBtn} onClick={onClose}>×</button>
        </div>
        <form onSubmit={handleSubmit} className={styles.form}>
          <input
            type="text"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            placeholder="e.g. AAPL"
            autoFocus
            className={styles.input}
            autoComplete="off"
            spellCheck={false}
          />
          
          <div className={styles.resultsContainer}>
            {isLoading && symbol.trim().length > 0 && <div className={styles.loading}>Searching...</div>}
            {!isLoading && results.length > 0 && (
              <ul className={styles.resultsList}>
                {results.map(r => (
                  <li key={r.symbol} className={styles.resultItem} onClick={() => onAdd(r.symbol)}>
                    <span className={styles.resultSymbol}>{r.symbol}</span>
                    <span className={styles.resultName}>{r.name}</span>
                    <span className={styles.resultExchange}>{r.exchange}</span>
                  </li>
                ))}
              </ul>
            )}
            {!isLoading && symbol.trim().length > 0 && results.length === 0 && (
              <div className={styles.noResults}>No matches found.</div>
            )}
          </div>
        </form>
      </div>
    </div>
  );
};
