import React, { useState, useEffect, useRef } from 'react';
import { createChart, IChartApi, ISeriesApi, LineSeries } from 'lightweight-charts';
import { api } from '../../lib/api';
import styles from './IVChart.module.css';

interface IVChartProps {
  symbol: string;
}

export const IVChart: React.FC<IVChartProps> = ({ symbol }) => {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState({
    ivRank: 0,
    ivPercentile: 0,
    atmIv: 0,
    avgIv: 0
  });

  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { color: 'transparent' },
        textColor: '#e0e0e0',
      },
      grid: {
        vertLines: { color: 'rgba(255, 255, 255, 0.06)' },
        horzLines: { color: 'rgba(255, 255, 255, 0.06)' },
      },
      crosshair: {
        mode: 1,
        vertLine: {
          color: 'rgba(255, 255, 255, 0.4)',
          width: 1,
          style: 1,
        },
        horzLine: {
          color: 'rgba(255, 255, 255, 0.4)',
          width: 1,
          style: 1,
        },
      },
      timeScale: {
        borderColor: 'rgba(255, 255, 255, 0.1)',
        timeVisible: true,
      },
      rightPriceScale: {
        borderColor: 'rgba(255, 255, 255, 0.1)',
      },
    });

    chartRef.current = chart;
    
    const lineSeries = chart.addSeries(LineSeries, {
      color: '#00d4aa',
      lineWidth: 2,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
    });
    
    seriesRef.current = lineSeries;

    const handleResize = () => {
      if (chartContainerRef.current) {
        chart.applyOptions({
          width: chartContainerRef.current.clientWidth,
          height: chartContainerRef.current.clientHeight,
        });
      }
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chart.remove();
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    setLoading(true);
    setError(null);

    api.getRealizedVolHistory(symbol)
      .then(res => {
        if (!isMounted) return;
        
        if (!res || res.length === 0) {
          setError('No IV data available');
          setLoading(false);
          return;
        }

        // Assuming res is array of { date, atm_iv, iv_rank, iv_percentile }
        // Sort by date just in case
        const sortedData = res.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
        
        const latest = sortedData[sortedData.length - 1];
        
        const getIvValue = (item: any): number => item.atm_iv ?? item.realizedVol ?? 0;

        const avgIv = sortedData.reduce((acc, val) => acc + getIvValue(val), 0) / sortedData.length;

        setStats({
          ivRank: latest.iv_rank || 0,
          ivPercentile: latest.iv_percentile || 0,
          atmIv: getIvValue(latest),
          avgIv: avgIv
        });

        if (seriesRef.current) {
          const chartData = sortedData.map(d => ({
            time: (new Date(d.date).getTime() / 1000) as any,
            value: getIvValue(d) * 100
          }));
          
          seriesRef.current.setData(chartData);
          
          // Add 1-year average horizontal line
          seriesRef.current.createPriceLine({
            price: avgIv * 100,
            color: '#f0b849',
            lineWidth: 1,
            lineStyle: 2,
            axisLabelVisible: true,
            title: '1Y Avg',
          });

          // Set color based on latest vs avg
          seriesRef.current.applyOptions({
            color: getIvValue(latest) > avgIv ? '#f0b849' : '#00d4aa'
          });

          chartRef.current?.timeScale().fitContent();
        }

        setLoading(false);
      })
      .catch(err => {
        console.error('Failed to load IV history', err);
        if (isMounted) {
          setError('Failed to load chart data');
          setLoading(false);
        }
      });

    return () => { isMounted = false; };
  }, [symbol]);

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.badge}>
          <span className={styles.badgeLabel}>IV Rank</span>
          <div className={styles.badgeValueContainer}>
            <span className={styles.badgeValue}>{stats.ivRank.toFixed(1)}</span>
            {stats.ivRank > 70 && (
              <span className={`${styles.signalBadge} ${styles.signalSell}`}>
                Sell Premium
              </span>
            )}
            {stats.ivRank < 30 && (
              <span className={`${styles.signalBadge} ${styles.signalBuy}`}>
                Buy Premium
              </span>
            )}
          </div>
        </div>
        <div className={styles.badge}>
          <span className={styles.badgeLabel}>IV Percentile</span>
          <span className={styles.badgeValue}>{stats.ivPercentile.toFixed(1)}%</span>
        </div>
        <div className={styles.badge}>
          <span className={styles.badgeLabel}>Current ATM IV</span>
          <span className={`${styles.badgeValue} ${styles.valueHighlight}`}>
            {(stats.atmIv * 100).toFixed(2)}%
          </span>
        </div>
      </div>

      <div className={styles.chartContainer}>
        {loading && <div className={styles.loading}>Loading IV data...</div>}
        {error && <div className={styles.loading}>{error}</div>}
        <div ref={chartContainerRef} className={styles.chartTarget} />
      </div>
    </div>
  );
};
