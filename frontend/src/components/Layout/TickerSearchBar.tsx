import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import type { SymbolSearchResult } from '../../types';
import styles from './TickerSearchBar.module.css';

const SELECTED_SYMBOL_KEY = 'dashboard_selectedSymbol';

function selectTicker(symbol: string, navigate: ReturnType<typeof useNavigate>) {
  const upper = symbol.trim().toUpperCase();
  if (!upper) return;

  window.localStorage.setItem(SELECTED_SYMBOL_KEY, JSON.stringify(upper));
  window.dispatchEvent(new CustomEvent('TICKER_SELECTED', { detail: { symbol: upper } }));
  navigate('/');
}

export const TickerSearchBar: React.FC = () => {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SymbolSearchResult[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const closeDropdown = useCallback(() => {
    setIsOpen(false);
    setHighlightIndex(-1);
  }, []);

  const handleSelect = useCallback((symbol: string) => {
    selectTicker(symbol, navigate);
    setQuery('');
    setResults([]);
    closeDropdown();
    inputRef.current?.blur();
  }, [navigate, closeDropdown]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        closeDropdown();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [closeDropdown]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const trimmed = query.trim();
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
        setIsOpen(true);
        setHighlightIndex(-1);
      } catch {
        setResults([]);
      } finally {
        setIsLoading(false);
      }
    }, 250);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (highlightIndex >= 0 && results[highlightIndex]) {
      handleSelect(results[highlightIndex].symbol);
    } else if (query.trim()) {
      handleSelect(query);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!isOpen && results.length > 0) setIsOpen(true);
      setHighlightIndex(prev => Math.min(prev + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIndex(prev => Math.max(prev - 1, -1));
    } else if (e.key === 'Escape') {
      closeDropdown();
      inputRef.current?.blur();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightIndex >= 0 && results[highlightIndex]) {
        handleSelect(results[highlightIndex].symbol);
      } else if (query.trim()) {
        handleSelect(query);
      }
    }
  };

  return (
    <div className={styles.container} ref={containerRef}>
      <form className={styles.searchForm} onSubmit={handleSubmit}>
        <svg
          className={styles.searchIcon}
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>

        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value.toUpperCase())}
          onFocus={() => query.trim() && results.length > 0 && setIsOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder="Consult the Oracle…"
          className={styles.input}
          autoComplete="off"
          spellCheck={false}
          aria-label="Search ticker symbol"
          aria-expanded={isOpen}
          aria-haspopup="listbox"
        />

        <kbd className={styles.shortcut} aria-hidden="true">⌘K</kbd>
      </form>

      {isOpen && (results.length > 0 || isLoading) && (
        <ul className={styles.dropdown} role="listbox">
          {isLoading && results.length === 0 ? (
            <li className={styles.loadingItem}>Searching…</li>
          ) : (
            results.map((item, index) => (
              <li key={item.symbol}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === highlightIndex}
                  className={`${styles.resultItem} ${index === highlightIndex ? styles.highlighted : ''}`}
                  onMouseEnter={() => setHighlightIndex(index)}
                  onClick={() => handleSelect(item.symbol)}
                >
                  <span className={styles.symbol}>{item.symbol}</span>
                  <span className={styles.name}>{item.name}</span>
                  <span className={styles.exchange}>{item.exchange}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
};
