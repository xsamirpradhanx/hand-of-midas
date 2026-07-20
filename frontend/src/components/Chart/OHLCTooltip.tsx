import React from 'react';
import styles from './OHLCTooltip.module.css';

interface OHLCData {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

interface OHLCTooltipProps {
  data: OHLCData | null;
}

function fmt(n: number) {
  return n.toFixed(2);
}

function fmtVol(v: number) {
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(2) + 'K';
  return v.toLocaleString();
}

export const OHLCTooltip: React.FC<OHLCTooltipProps> = ({ data }) => {
  if (!data) return null;

  const isUp = data.close >= data.open;
  const priceClass = isUp ? styles.up : styles.down;

  return (
    <div className={`${styles.tooltip} ${data ? styles.visible : ''}`}>
      <span className={styles.time}>{data.time}</span>
      <span className={styles.item}>
        <span className={styles.label}>O</span>
        <span className={priceClass}>{fmt(data.open)}</span>
      </span>
      <span className={styles.item}>
        <span className={styles.label}>H</span>
        <span className={styles.up}>{fmt(data.high)}</span>
      </span>
      <span className={styles.item}>
        <span className={styles.label}>L</span>
        <span className={styles.down}>{fmt(data.low)}</span>
      </span>
      <span className={styles.item}>
        <span className={styles.label}>C</span>
        <span className={priceClass}>{fmt(data.close)}</span>
      </span>
      {data.volume !== undefined && (
        <span className={styles.item}>
          <span className={styles.label}>V</span>
          <span className={styles.vol}>{fmtVol(data.volume)}</span>
        </span>
      )}
    </div>
  );
};
