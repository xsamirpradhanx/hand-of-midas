import React from 'react';
import styles from './TimeframeBar.module.css';

interface TimeframeBarProps {
  interval: string;
  onChange: (interval: string) => void;
}

const timeframes = [
  { label: '1D', value: '1day' },
  { label: '1W', value: '1week' },
  { label: '1M', value: '1month' }
];

export const TimeframeBar: React.FC<TimeframeBarProps> = ({ interval, onChange }) => {
  return (
    <div className={styles.bar}>
      {timeframes.map(tf => (
        <button
          key={tf.value}
          className={`${styles.btn} ${interval === tf.value ? styles.active : ''}`}
          onClick={() => onChange(tf.value)}
        >
          {tf.label}
        </button>
      ))}
    </div>
  );
};
