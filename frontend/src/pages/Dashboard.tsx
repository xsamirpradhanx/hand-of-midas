import React, { useState, useEffect } from 'react';
import { WatchlistPanel } from '../components/Watchlist/WatchlistPanel';
import { ChartContainer } from '../components/Chart/ChartContainer';
import { InstitutionalSubCharts } from '../components/Chart/InstitutionalSubCharts';
import { TimeframeBar } from '../components/Chart/TimeframeBar';
import { ChartTypeBar, type ChartType } from '../components/Chart/ChartTypeBar';
import { IndicatorPanel } from '../components/Indicators/IndicatorPanel';
import { OptionsDashboard } from '../components/Options/OptionsDashboard';
import { UnusualActivityFeed } from '../components/Options/UnusualActivityFeed';
import { PortfolioDashboard } from './PortfolioDashboard';
import { TradePlanPanel } from '../components/Screener/TradePlanPanel';

import { api } from '../lib/api';
import type { IndicatorConfig } from '../types';
import styles from './Dashboard.module.css';

type Tab = 'chart' | 'options' | 'unusual' | 'portfolio' | 'market' | 'trade_plan';

function useLocalStorage<T>(key: string, initialValue: T): [T, (value: T | ((val: T) => T)) => void] {
  const [storedValue, setStoredValue] = useState<T>(() => {
    try {
      const item = window.localStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
    } catch (error) {
      console.warn(error);
      return initialValue;
    }
  });

  const setValue = (value: T | ((val: T) => T)) => {
    try {
      const valueToStore = value instanceof Function ? value(storedValue) : value;
      setStoredValue(valueToStore);
      window.localStorage.setItem(key, JSON.stringify(valueToStore));
    } catch (error) {
      console.warn(error);
    }
  };

  return [storedValue, setValue];
}
export const Dashboard: React.FC = () => {
  const [selectedSymbol, setSelectedSymbol] = useLocalStorage<string | null>('dashboard_selectedSymbol', null);
  const [activeTab, setActiveTab] = useLocalStorage<Tab>('dashboard_activeTab', 'chart');
  const [interval, setInterval] = useLocalStorage<string>('dashboard_interval', '1day');
  const [chartType, setChartType] = useLocalStorage<ChartType>('dashboard_chartType', 'candlestick');
  const [showExtendedHours, setShowExtendedHours] = useLocalStorage<boolean>('dashboard_showExtendedHours', false);
  const [showPredictiveZones, setShowPredictiveZones] = useLocalStorage<boolean>('dashboard_showPredictiveZones', false);
  const [showInstitutionalSignals, setShowInstitutionalSignals] = useLocalStorage<boolean>('dashboard_showInstitutionalSignals', true);
  const [timezone, setTimezone] = useLocalStorage<'EST' | 'GMT'>('dashboard_timezone', 'EST');
  const [indicators, setIndicators] = useState<IndicatorConfig[]>([]);
  const [companyName, setCompanyName] = useState<string>('');
  
  // Split View State
  const [isSplitView, setIsSplitView] = useLocalStorage<boolean>('dashboard_splitView', false);
  const [splitWidth, setSplitWidth] = useLocalStorage<number>('dashboard_splitWidth', 50); // percentage

  useEffect(() => {
    const handleTickerSelected = (e: Event) => {
      const symbol = (e as CustomEvent<{ symbol: string }>).detail?.symbol;
      if (symbol) setSelectedSymbol(symbol);
    };
    window.addEventListener('TICKER_SELECTED', handleTickerSelected);
    return () => window.removeEventListener('TICKER_SELECTED', handleTickerSelected);
  }, [setSelectedSymbol]);

  // Load chart config and company name when symbol changes
  useEffect(() => {
    if (!selectedSymbol) return;

    // Fetch company name
    api.getQuote(selectedSymbol)
      .then(res => setCompanyName(res?.name || ''))
      .catch(() => setCompanyName(''));

    api.getChartConfig(selectedSymbol)
      .then(res => {
        if (res && res.indicators) {
          setIndicators(res.indicators);
        } else {
          setIndicators([
            { type: 'SMA', enabled: true, params: { period: 20 }, color: '#00d4aa' },
          ]);
        }
      })
      .catch(() => {
        setIndicators([
          { type: 'SMA', enabled: true, params: { period: 20 }, color: '#00d4aa' },
        ]);
      });
  }, [selectedSymbol]);

  const handleIndicatorsChange = (newIndicators: IndicatorConfig[]) => {
    setIndicators(newIndicators);
    if (selectedSymbol) {
      api.saveChartConfig(selectedSymbol, { indicators: newIndicators })
        .catch(err => console.error('Failed to save chart config', err));
    }
  };

  const handleToggleExtendedHours = (checked: boolean) => {
    setShowExtendedHours(checked);
    // Extended hours data is only available for intraday intervals.
    // If the user turns it on while on a daily/weekly/monthly chart, automatically switch to 1h.
    if (checked && ['1day', '1week', '1month'].includes(interval)) {
      setInterval('1h');
    }
  };

  return (
    <div className={styles.appLayout}>
      <div className={styles.dashboard}>
          <WatchlistPanel
            selectedSymbol={selectedSymbol}
            onSelectSymbol={setSelectedSymbol}
            showExtendedHours={showExtendedHours}
          />

          <div className={styles.mainArea}>
        {selectedSymbol && (
          <div className={styles.chartHeader}>
            <div className={styles.symbolTitle}>
              <h2>{selectedSymbol}</h2>
              {companyName && (
                <span style={{ fontSize: '1.2rem', color: 'var(--text-secondary)', fontWeight: 400 }}>
                  {companyName}
                </span>
              )}
            </div>
            {(activeTab === 'chart' || isSplitView) && (
              <div className={styles.headerControlsContainer}>
                <div className={styles.headerControls}>
                  <ChartTypeBar chartType={chartType} onChange={setChartType} />
                  <TimeframeBar interval={interval} onChange={setInterval} />
                  <button 
                    className={`${styles.tab} ${styles.timezoneToggle || ''}`}
                    style={{ padding: '6px 12px', minWidth: '50px', fontSize: '0.75rem', border: '1px solid var(--border-color)', borderRadius: '6px', background: 'var(--bg-secondary)', marginLeft: '4px' }}
                    onClick={() => setTimezone(prev => prev === 'EST' ? 'GMT' : 'EST')}
                    title="Toggle Timezone"
                  >
                    {timezone}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        <div className={styles.tabBar}>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className={`${styles.tab} ${activeTab === 'chart' ? styles.active : ''}`} onClick={() => setActiveTab('chart')}>Chart</button>
            <button className={`${styles.tab} ${activeTab === 'options' ? styles.active : ''}`} onClick={() => setActiveTab('options')}>Options Chain</button>
            <button className={`${styles.tab} ${activeTab === 'unusual' ? styles.active : ''}`} onClick={() => setActiveTab('unusual')}>🐋 Whale Flow</button>
            <button className={`${styles.tab} ${activeTab === 'trade_plan' ? styles.active : ''}`} onClick={() => setActiveTab('trade_plan')}>🤖 AI Trade Plan</button>
            {/* Portfolio hidden for now */}
          </div>
          
          {activeTab !== 'chart' && (
            <div className={styles.splitToggleWrapper} style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>
              <button 
                className={`${styles.tab} ${isSplitView ? styles.activeSplit : ''}`} 
                onClick={() => setIsSplitView(!isSplitView)}
                title="Toggle Chart Visibility"
                style={{ padding: '6px 12px', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '6px' }}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect width="18" height="18" x="3" y="3" rx="2" />
                  <path d="M12 3v18" />
                </svg>
                Show Chart
              </button>
            </div>
          )}
        </div>

        <div className={styles.contentArea}>
          {!selectedSymbol && activeTab !== 'portfolio' ? (
            <div className={styles.emptyContainer}>
              <div className={styles.emptyIcon}>📈</div>
              <p>Select a ticker from your watchlist to view the chart</p>
            </div>
          ) : (
            <div className={styles.splitContainer} style={{ display: 'flex', width: '100%', height: '100%', overflow: 'hidden' }}>
              
              {/* Left Pane: Active Tab */}
              {(activeTab !== 'chart' || !selectedSymbol) && (
                <div 
                  className={styles.rightPane} 
                  style={{ 
                    width: isSplitView && selectedSymbol && activeTab !== 'portfolio' ? `${splitWidth}%` : '100%',
                    height: '100%',
                    overflow: 'auto',
                    display: activeTab === 'chart' && selectedSymbol ? 'none' : 'block'
                  }}
                >
                  {activeTab === 'trade_plan' && selectedSymbol && (
                    <TradePlanPanel symbol={selectedSymbol} />
                  )}
                  {activeTab === 'options' && selectedSymbol && (
                    <OptionsDashboard symbol={selectedSymbol} />
                  )}
                  {activeTab === 'unusual' && (
                    <UnusualActivityFeed initialSymbol={selectedSymbol || undefined} />
                  )}
                  {activeTab === 'portfolio' && (
                    <PortfolioDashboard />
                  )}
                </div>
              )}

              {/* Resizer Handle */}
              {isSplitView && selectedSymbol && activeTab !== 'chart' && activeTab !== 'portfolio' && (
                <div 
                  className={styles.resizer}
                  onMouseDown={(e) => {
                    const startX = e.clientX;
                    const startWidth = splitWidth;
                    
                    const onMouseMove = (moveEvent: MouseEvent) => {
                      const delta = moveEvent.clientX - startX;
                      const parentWidth = window.innerWidth - 300; // approximate parent width
                      const newWidth = Math.min(Math.max(startWidth + (delta / parentWidth) * 100, 20), 80);
                      setSplitWidth(newWidth);
                    };
                    
                    const onMouseUp = () => {
                      document.removeEventListener('mousemove', onMouseMove);
                      document.removeEventListener('mouseup', onMouseUp);
                    };
                    
                    document.addEventListener('mousemove', onMouseMove);
                    document.addEventListener('mouseup', onMouseUp);
                  }}
                />
              )}

              {/* Right Pane: Chart (Always visible if in split mode or chart tab) */}
              {(activeTab === 'chart' || (isSplitView && selectedSymbol && activeTab !== 'portfolio')) && selectedSymbol && (
                <div 
                  className={styles.chartArea} 
                  style={{ width: isSplitView && activeTab !== 'chart' ? `${100 - splitWidth}%` : '100%' }}
                >
                  <ChartContainer
                    key={selectedSymbol}
                    symbol={selectedSymbol}
                    interval={interval}
                    indicators={indicators}
                    chartType={chartType}
                    showExtendedHours={showExtendedHours}
                    showPredictiveZones={showPredictiveZones}
                    timezone={timezone}
                  />
                  {showInstitutionalSignals && (
                    <InstitutionalSubCharts symbol={selectedSymbol} />
                  )}
                </div>
              )}
            </div>
          )}
        </div>
          </div>
          {activeTab === 'chart' && (
            <IndicatorPanel
              indicators={indicators}
              onChange={handleIndicatorsChange}
              showExtendedHours={showExtendedHours}
              setShowExtendedHours={handleToggleExtendedHours}
              showPredictiveZones={showPredictiveZones}
              setShowPredictiveZones={setShowPredictiveZones}
              showInstitutionalSignals={showInstitutionalSignals}
              setShowInstitutionalSignals={setShowInstitutionalSignals}
              currentInterval={interval}
            />
          )}
        </div>
    </div>
  );
};
