import React, { useState, useRef, useEffect } from 'react';
import styles from './ProviderSelector.module.css';

type Provider = 'yahoo' | 'schwab' | 'polygon';

export const ProviderSelector: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [provider, setProvider] = useState<Provider>(() => {
    try {
      const stored = window.localStorage.getItem('dashboard_dataProvider');
      return stored ? JSON.parse(stored) : 'yahoo';
    } catch {
      return 'yahoo';
    }
  });

  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = (newProvider: Provider) => {
    setProvider(newProvider);
    window.localStorage.setItem('dashboard_dataProvider', JSON.stringify(newProvider));
    setIsOpen(false);
    window.location.reload(); // Reload to refetch everything with the new provider
  };

  const getProviderLabel = (p: Provider) => {
    switch (p) {
      case 'yahoo': return 'Yahoo';
      case 'schwab': return 'Schwab';
      case 'polygon': return 'Polygon';
    }
  };

  return (
    <div className={styles.container} ref={menuRef}>
      <button 
        className={styles.button} 
        onClick={() => setIsOpen(!isOpen)}
        title="Select Data Provider"
      >
        <span className={styles.icon}>⚙️</span>
        <span className={styles.label}>{getProviderLabel(provider)}</span>
      </button>

      {isOpen && (
        <div className={styles.dropdown}>
          <div className={styles.header}>Data Provider</div>
          <button 
            className={`${styles.item} ${provider === 'yahoo' ? styles.active : ''}`}
            onClick={() => handleSelect('yahoo')}
          >
            Yahoo Finance
          </button>
          <button 
            className={`${styles.item} ${provider === 'schwab' ? styles.active : ''}`}
            onClick={() => handleSelect('schwab')}
          >
            Charles Schwab
          </button>
          <button 
            className={`${styles.item} ${provider === 'polygon' ? styles.active : ''}`}
            onClick={() => handleSelect('polygon')}
          >
            Polygon.io
          </button>
        </div>
      )}
    </div>
  );
};
