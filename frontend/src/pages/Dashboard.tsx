import React, { useState, useEffect } from 'react';
import { WatchlistPanel } from '../components/Watchlist/WatchlistPanel';
import { ChartContainer } from '../components/Chart/ChartContainer';
import { TimeframeBar } from '../components/Chart/TimeframeBar';
import { ChartTypeBar, type ChartType } from '../components/Chart/ChartTypeBar';
import { IndicatorPanel } from '../components/Indicators/IndicatorPanel';
import { OptionsDashboard } from '../components/Options/OptionsDashboard';
import { UnusualActivityFeed } from '../components/Options/UnusualActivityFeed';
import { PortfolioDashboard } from './PortfolioDashboard';
import { api } from '../lib/api';
import type { IndicatorConfig } from '../types';
import styles from './Dashboard.module.css';

type Tab = 'chart' | 'options' | 'unusual' | 'portfolio';

export const Dashboard: React.FC = () => {
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('chart');
  const [interval, setInterval] = useState<string>('1day');
  const [chartType, setChartType] = useState<ChartType>('candlestick');
  const [indicators, setIndicators] = useState<IndicatorConfig[]>([]);

  // Load chart config when symbol changes
  useEffect(() => {
    if (!selectedSymbol) return;

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

  return (
    <div className={styles.dashboard}>
      <WatchlistPanel
        selectedSymbol={selectedSymbol}
        onSelectSymbol={setSelectedSymbol}
      />

      <div className={styles.mainArea}>
        {selectedSymbol && (
          <div className={styles.chartHeader}>
            <div className={styles.symbolTitle}>
              <h2>{selectedSymbol}</h2>
            </div>
            {activeTab === 'chart' && (
              <div className={styles.headerControls}>
                <ChartTypeBar chartType={chartType} onChange={setChartType} />
                <TimeframeBar interval={interval} onChange={setInterval} />
              </div>
            )}
          </div>
        )}

        <div className={styles.tabBar}>
          <button className={`${styles.tab} ${activeTab === 'chart' ? styles.active : ''}`} onClick={() => setActiveTab('chart')}>Chart</button>
          <button className={`${styles.tab} ${activeTab === 'options' ? styles.active : ''}`} onClick={() => setActiveTab('options')}>Options Chain</button>
          <button className={`${styles.tab} ${activeTab === 'unusual' ? styles.active : ''}`} onClick={() => setActiveTab('unusual')}>🐋 Whale Flow</button>
          <button className={`${styles.tab} ${activeTab === 'portfolio' ? styles.active : ''}`} onClick={() => setActiveTab('portfolio')}>Portfolio</button>
        </div>

        <div className={styles.contentArea}>
          {!selectedSymbol && activeTab !== 'portfolio' ? (
            <div className={styles.emptyContainer}>
              <div className={styles.emptyIcon}>📈</div>
              <p>Select a ticker from your watchlist to view the chart</p>
            </div>
          ) : (
            <>
              {activeTab === 'chart' && selectedSymbol && (
                <div className={styles.chartArea}>
                  <ChartContainer
                    key={selectedSymbol}
                    symbol={selectedSymbol}
                    interval={interval}
                    indicators={indicators}
                    chartType={chartType}
                  />
                </div>
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
            </>
          )}
        </div>
      </div>

      {activeTab === 'chart' && (
        <IndicatorPanel
          indicators={indicators}
          onChange={handleIndicatorsChange}
        />
      )}
    </div>
  );
};
