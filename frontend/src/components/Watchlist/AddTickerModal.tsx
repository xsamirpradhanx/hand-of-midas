import React, { useState } from 'react';
import styles from './AddTickerModal.module.css';

interface AddTickerModalProps {
  onClose: () => void;
  onAdd: (symbol: string) => void;
}

export const AddTickerModal: React.FC<AddTickerModalProps> = ({ onClose, onAdd }) => {
  const [symbol, setSymbol] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (symbol.trim()) {
      onAdd(symbol.trim().toUpperCase());
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
          />
          <button type="submit" className={styles.submitBtn} disabled={!symbol.trim()}>
            Add to Watchlist
          </button>
        </form>
      </div>
    </div>
  );
};
