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
  const [isCollapsed, setIsCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('indicator_collapsed') === 'true';
    } catch {
      return false;
    }
  });

  const toggleCollapse = () => {
    setIsCollapsed(prev => {
      const next = !prev;
      try {
        localStorage.setItem('indicator_collapsed', String(next));
      } catch (err) {
        console.warn(err);
      }
      return next;
    });
  };

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
    // Moving averages / overlays
    if (type === 'SMA' || type === 'EMA' || type === 'WMA') params = { period: 20 };
    if (type === 'HMA')       params = { period: 9 };
    if (type === 'BOLLINGER') params = { period: 20, stdDev: 2 };
    if (type === 'KC')        params = { period: 20, mult: 2 };
    if (type === 'DC')        params = { period: 20 };
    if (type === 'PSAR')      params = { step: 0.02, max: 0.2 };
    if (type === 'ICHIMOKU')  params = {};
    if (type === 'VWAP')      params = {};
    if (type === 'FIBONACCI') params = {};
    // Oscillators
    if (type === 'RSI')       params = { period: 14 };
    if (type === 'MACD')      params = { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 };
    if (type === 'STOCHASTIC') params = { periodK: 14, periodD: 3 };
    if (type === 'CCI')       params = { period: 20 };
    if (type === 'WILLR')     params = { period: 14 };
    if (type === 'MFI')       params = { period: 14 };
    if (type === 'ROC')       params = { period: 12 };
    if (type === 'MOM')       params = { period: 10 };
    if (type === 'AROON')     params = { period: 25 };
    // Volume
    if (type === 'VOLUME')    params = {};
    if (type === 'OBV')       params = {};
    if (type === 'CMF')       params = { period: 20 };
    // Strength / Volatility
    if (type === 'ATR')       params = { period: 14 };
    if (type === 'ADX')       params = { period: 14 };

    onChange([...indicators, { type, enabled: true, params }]);
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
    <div className={`${styles.panel} ${isCollapsed ? styles.collapsed : ''}`}>
      <div className={styles.header}>
        {!isCollapsed && (
          <div className={styles.headerTitleGroup}>
            <span className={styles.sectionIcon}>📊</span>
            <h3>Indicators</h3>
            <span className={styles.badge}>{indicators.length}</span>
          </div>
        )}
        <div className={styles.headerActions}>
          <button onClick={() => setShowAdd(!showAdd)} className={styles.addBtn} title="Add Indicator">
            {showAdd ? '✕' : '+'}
          </button>
          <button onClick={toggleCollapse} className={styles.collapseBtn} title={isCollapsed ? "Expand Indicators" : "Collapse Indicators"}>
            {isCollapsed ? '«' : '»'}
          </button>
        </div>
      </div>
      
      {showAdd && !isCollapsed && (
      <div className={styles.addMenu}>
          <div className={styles.addMenuHeader}>Add Technical Indicator</div>

          <div className={styles.addMenuSection}>📈 Trend &amp; Overlays</div>
          <button onClick={() => handleAdd('SMA')}>SMA — Simple Moving Avg</button>
          <button onClick={() => handleAdd('EMA')}>EMA — Exponential Moving Avg</button>
          <button onClick={() => handleAdd('WMA')}>WMA — Weighted Moving Avg</button>
          <button onClick={() => handleAdd('HMA')}>HMA — Hull Moving Avg</button>
          <button onClick={() => handleAdd('BOLLINGER')}>Bollinger Bands</button>
          <button onClick={() => handleAdd('KC')}>Keltner Channels</button>
          <button onClick={() => handleAdd('DC')}>Donchian Channels</button>
          <button onClick={() => handleAdd('PSAR')}>Parabolic SAR</button>
          <button onClick={() => handleAdd('ICHIMOKU')}>Ichimoku Cloud</button>
          <button onClick={() => handleAdd('VWAP')}>VWAP</button>
          <button onClick={() => handleAdd('FIBONACCI')}>Fibonacci Retracement</button>

          <div className={styles.addMenuSection}>🌀 Oscillators</div>
          <button onClick={() => handleAdd('RSI')}>RSI — Relative Strength Index</button>
          <button onClick={() => handleAdd('MACD')}>MACD Oscillator</button>
          <button onClick={() => handleAdd('STOCHASTIC')}>Stochastic Oscillator</button>
          <button onClick={() => handleAdd('CCI')}>CCI — Commodity Channel Index</button>
          <button onClick={() => handleAdd('WILLR')}>Williams %R</button>
          <button onClick={() => handleAdd('MFI')}>MFI — Money Flow Index</button>
          <button onClick={() => handleAdd('ROC')}>ROC — Rate of Change</button>
          <button onClick={() => handleAdd('MOM')}>Momentum</button>
          <button onClick={() => handleAdd('AROON')}>Aroon</button>

          <div className={styles.addMenuSection}>📊 Volume</div>
          <button onClick={() => handleAdd('VOLUME')}>Volume Histogram</button>
          <button onClick={() => handleAdd('OBV')}>OBV — On Balance Volume</button>
          <button onClick={() => handleAdd('CMF')}>CMF — Chaikin Money Flow</button>

          <div className={styles.addMenuSection}>⚡ Strength &amp; Volatility</div>
          <button onClick={() => handleAdd('ATR')}>ATR — Average True Range</button>
          <button onClick={() => handleAdd('ADX')}>ADX — Trend Strength</button>
        </div>
      )}

      <div className={styles.list}>
        {isCollapsed ? (
          indicators.map((ind, i) => (
            <div key={`${ind.type}-${i}`} className={styles.collapsedItem} title={ind.type}>
              <span className={styles.collapsedSymbol}>{ind.type.slice(0, 3)}</span>
            </div>
          ))
        ) : indicators.length === 0 ? (
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
      
      {!isCollapsed && (
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
      )}
    </div>
  );
};
