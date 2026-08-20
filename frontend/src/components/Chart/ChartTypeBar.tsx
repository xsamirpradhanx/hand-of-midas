import React, { useEffect, useRef, useState } from 'react';
import styles from './ChartTypeBar.module.css';

export type ChartType = 'candlestick' | 'heikinashi' | 'line' | 'mountain';

interface ChartTypeBarProps {
  chartType: ChartType;
  onChange: (type: ChartType) => void;
}

const chartTypes: { label: string; value: ChartType; icon: string }[] = [
  { label: 'Candles', value: 'candlestick', icon: '▣' },
  { label: 'HA', value: 'heikinashi', icon: '▤' },
  { label: 'Line', value: 'line', icon: '╱' },
  { label: 'Mountain', value: 'mountain', icon: '⛰' },
];

export const ChartTypeBar: React.FC<ChartTypeBarProps> = ({ chartType, onChange }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = chartTypes.find(ct => ct.value === chartType) ?? chartTypes[0];

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen(o => !o)}
        title="Chart type"
      >
        <span className={styles.icon}>{current.icon}</span>
        <span className={styles.label}>{current.label}</span>
        <span className={styles.chevron}>▾</span>
      </button>
      {open && (
        <div className={styles.menu}>
          {chartTypes.map(ct => (
            <button
              key={ct.value}
              type="button"
              className={`${styles.item} ${chartType === ct.value ? styles.active : ''}`}
              onClick={() => {
                onChange(ct.value);
                setOpen(false);
              }}
            >
              <span className={styles.icon}>{ct.icon}</span>
              <span className={styles.label}>{ct.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
