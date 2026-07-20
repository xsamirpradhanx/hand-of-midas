import React, { useState } from 'react';
import type { IndicatorConfig as IndicatorType } from '../../types';
import { IndicatorConfig } from './IndicatorConfig';
import styles from './IndicatorPanel.module.css';

interface IndicatorPanelProps {
  indicators: IndicatorType[];
  onChange: (indicators: IndicatorType[]) => void;
}

export const IndicatorPanel: React.FC<IndicatorPanelProps> = ({ indicators, onChange }) => {
  const [showAdd, setShowAdd] = useState(false);

  const handleAdd = (type: string) => {
    let params: Record<string, any> = {};
    if (type === 'SMA' || type === 'EMA') params = { period: 20 };
    if (type === 'RSI') params = { period: 14 };
    if (type === 'MACD') params = { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 };
    if (type === 'BOLLINGER') params = { period: 20, stdDev: 2 };
    if (type === 'VOLUME') params = {};

    const newIndicator: IndicatorType = {
      type,
      enabled: true,
      params,
    };

    onChange([...indicators, newIndicator]);
    setShowAdd(false);
  };

  const handleUpdate = (index: number, updated: IndicatorType) => {
    const next = [...indicators];
    next[index] = updated;
    onChange(next);
  };

  const handleRemove = (index: number) => {
    const next = indicators.filter((_, i) => i !== index);
    onChange(next);
  };

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <h3>Indicators</h3>
        <button onClick={() => setShowAdd(!showAdd)} className={styles.addBtn}>+</button>
      </div>
      
      {showAdd && (
        <div className={styles.addMenu}>
          <button onClick={() => handleAdd('SMA')}>SMA</button>
          <button onClick={() => handleAdd('EMA')}>EMA</button>
          <button onClick={() => handleAdd('RSI')}>RSI</button>
          <button onClick={() => handleAdd('MACD')}>MACD</button>
          <button onClick={() => handleAdd('BOLLINGER')}>Bollinger Bands</button>
          <button onClick={() => handleAdd('VOLUME')}>Volume</button>
        </div>
      )}

      <div className={styles.list}>
        {indicators.length === 0 ? (
          <div className={styles.empty}>No indicators added</div>
        ) : (
          indicators.map((ind, i) => (
            <IndicatorConfig
              key={`${ind.type}-${i}`}
              indicator={ind}
              onUpdate={(updated) => handleUpdate(i, updated)}
              onRemove={() => handleRemove(i)}
            />
          ))
        )}
      </div>
    </div>
  );
};
