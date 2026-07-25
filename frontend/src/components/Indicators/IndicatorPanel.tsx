import React, { useState } from 'react';
import type { IndicatorConfig as IndicatorType } from '../../types';
import { IndicatorConfig } from './IndicatorConfig';
import styles from './IndicatorPanel.module.css';

interface IndicatorPanelProps {
  indicators: IndicatorType[];
  onChange: (indicators: IndicatorType[]) => void;
  showExtendedHours: boolean;
  setShowExtendedHours: (show: boolean) => void;
  showPredictiveZones: boolean;
  setShowPredictiveZones: (show: boolean) => void;
  showInstitutionalSignals: boolean;
  setShowInstitutionalSignals: (show: boolean) => void;
  currentInterval?: string;
}

export const IndicatorPanel: React.FC<IndicatorPanelProps> = ({ 
  indicators, 
  onChange,
  showExtendedHours,
  setShowExtendedHours,
  showPredictiveZones,
  setShowPredictiveZones,
  showInstitutionalSignals,
  setShowInstitutionalSignals,
  currentInterval = '1day'
}) => {
  const [showAdd, setShowAdd] = useState(false);

  // Helper to determine current US Market Session
  const getMarketSession = () => {
    const now = new Date();
    // Convert to US Eastern Time
    const estString = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
    const estDate = new Date(estString);
    const day = estDate.getDay();
    const hours = estDate.getHours();
    const minutes = estDate.getMinutes();
    const totalMinutes = hours * 60 + minutes;

    if (day === 0 || day === 6) {
      return { status: 'Closed', type: 'closed', label: 'Weekend' };
    }

    if (totalMinutes >= 240 && totalMinutes < 570) { // 4:00 AM - 9:30 AM
      return { status: 'Pre-Market', type: 'ext', label: 'Pre-Mkt 🌙' };
    } else if (totalMinutes >= 570 && totalMinutes < 960) { // 9:30 AM - 4:00 PM
      return { status: 'Regular', type: 'open', label: 'Market Open 🟢' };
    } else if (totalMinutes >= 960 && totalMinutes < 1200) { // 4:00 PM - 8:00 PM
      return { status: 'After-Hours', type: 'ext', label: 'After-Hrs 🌙' };
    } else {
      return { status: 'Closed', type: 'closed', label: 'Closed 🔴' };
    }
  };

  const marketSession = getMarketSession();
  const isIntraday = ['1min', '5min', '15min', '30min', '1h'].includes(currentInterval);

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
        <div className={styles.headerTitleGroup}>
          <span className={styles.sectionIcon}>📊</span>
          <h3>Indicators</h3>
          <span className={styles.badge}>{indicators.length}</span>
        </div>
        <button onClick={() => setShowAdd(!showAdd)} className={styles.addBtn} title="Add Indicator">
          {showAdd ? '✕' : '+'}
        </button>
      </div>
      
      {showAdd && (
        <div className={styles.addMenu}>
          <div className={styles.addMenuHeader}>Add Technical Indicator</div>
          <button onClick={() => handleAdd('SMA')}>📈 SMA (Simple Moving Avg)</button>
          <button onClick={() => handleAdd('EMA')}>⚡ EMA (Exponential Moving Avg)</button>
          <button onClick={() => handleAdd('RSI')}>🌀 RSI (Relative Strength Index)</button>
          <button onClick={() => handleAdd('MACD')}>📊 MACD Oscillator</button>
          <button onClick={() => handleAdd('BOLLINGER')}>🛡️ Bollinger Bands</button>
          <button onClick={() => handleAdd('VOLUME')}>📊 Volume Histogram</button>
        </div>
      )}

      <div className={styles.list}>
        {indicators.length === 0 ? (
          <div className={styles.empty}>
            <span className={styles.emptyIcon}>🔍</span>
            <p>No active indicators</p>
            <span className={styles.emptyHint}>Click + to add overlays</span>
          </div>
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
      
      <div className={styles.chartControls}>
        <div className={styles.controlsHeaderRow}>
          <h4 className={styles.controlsHeader}>
            <span className={styles.sectionIcon}>⚡</span> Overlays & Signals
          </h4>
          <span className={`${styles.statusBadge} ${styles[marketSession.type]}`}>
            {marketSession.label}
          </span>
        </div>

        <label className={`${styles.toggleLabel} ${styles.extToggle}`}>
          <div className={styles.labelInfo}>
            <span className={styles.labelText}>🌙 Extended Hours</span>
            {showExtendedHours && (
              <span className={styles.subBadge}>
                {isIntraday ? currentInterval.toUpperCase() : 'AUTO 1H'}
              </span>
            )}
          </div>
          <input
            type="checkbox"
            className={styles.toggleCheckbox}
            checked={showExtendedHours}
            onChange={(e) => setShowExtendedHours(e.target.checked)}
          />
        </label>

        <label className={`${styles.toggleLabel} ${styles.aiZoneToggle}`}>
          <div className={styles.labelInfo}>
            <span className={styles.labelText}>🎯 AI Zones</span>
          </div>
          <input
            type="checkbox"
            className={styles.toggleCheckbox}
            checked={showPredictiveZones}
            onChange={(e) => setShowPredictiveZones(e.target.checked)}
          />
        </label>

        <label className={`${styles.toggleLabel} ${styles.volSignalToggle}`} title="Options Market Volatility Signals (IV Term Structure & Risk Reversal Skew)">
          <div className={styles.labelInfo}>
            <span className={styles.labelText}>🐋 Options Vol Signals</span>
          </div>
          <input
            type="checkbox"
            className={styles.toggleCheckbox}
            checked={showInstitutionalSignals}
            onChange={(e) => setShowInstitutionalSignals(e.target.checked)}
          />
        </label>
      </div>
    </div>
  );
};
