import React from 'react';
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
  return (
    <div className={styles.bar}>
      {chartTypes.map(ct => (
        <button
          key={ct.value}
          className={`${styles.btn} ${chartType === ct.value ? styles.active : ''}`}
          onClick={() => onChange(ct.value)}
          title={ct.label}
        >
          <span className={styles.icon}>{ct.icon}</span>
          <span className={styles.label}>{ct.label}</span>
        </button>
      ))}
    </div>
  );
};
