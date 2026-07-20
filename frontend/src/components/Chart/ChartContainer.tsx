import React, { useEffect, useRef, useState } from 'react';
import { createMainChart, getSeriesColor } from '../../lib/chartHelpers';
import { api } from '../../lib/api';
import {
  IChartApi,
  ISeriesApi,
  CandlestickSeries,
  LineSeries,
  AreaSeries,
  HistogramSeries,
  MouseEventParams,
} from 'lightweight-charts';
import type { IndicatorConfig, OHLCVDataPoint } from '../../types';
import { calculateSMA } from '../../lib/indicators/sma';
import { calculateEMA } from '../../lib/indicators/ema';
import { calculateRSI } from '../../lib/indicators/rsi';
import { calculateMACD } from '../../lib/indicators/macd';
import { calculateBollingerBands } from '../../lib/indicators/bollingerBands';
import { calculateHeikinAshi } from '../../lib/indicators/heikinAshi';
import { OHLCTooltip } from './OHLCTooltip';
import type { ChartType } from './ChartTypeBar';
import styles from './ChartContainer.module.css';

interface ChartContainerProps {
  symbol: string;
  interval: string;
  indicators: IndicatorConfig[];
  chartType: ChartType;
}

interface TooltipData {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export const ChartContainer: React.FC<ChartContainerProps> = ({
  symbol,
  interval,
  indicators,
  chartType,
}) => {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesMapRef = useRef<Map<string, ISeriesApi<any>>>(new Map());
  const rawDataRef = useRef<OHLCVDataPoint[]>([]);

  const [data, setData] = useState<OHLCVDataPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);

  // Fetch data when symbol or interval changes
  useEffect(() => {
    let isMounted = true;

    const fetchData = async () => {
      setLoading(true);
      setError('');
      setTooltip(null);
      try {
        const [marketResult, quoteResult] = await Promise.all([
          api.getMarketData(symbol, interval),
          api.getQuote(symbol).catch(() => null)
        ]);
        if (isMounted) {
          const ordered = [...marketResult.data].reverse(); // chronological order
          if (quoteResult && ordered.length > 0) {
            const lastBar = { ...ordered[ordered.length - 1] };
            lastBar.close = quoteResult.price;
            if (quoteResult.price > lastBar.high) lastBar.high = quoteResult.price;
            if (quoteResult.price < lastBar.low) lastBar.low = quoteResult.price;
            ordered[ordered.length - 1] = lastBar;
          }
          rawDataRef.current = ordered;
          setData(ordered);
        }
      } catch (err: any) {
        if (isMounted) setError(err.message || 'Failed to fetch market data');
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    fetchData();

    return () => {
      isMounted = false;
    };
  }, [symbol, interval]);

  // Initialize chart once on mount
  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createMainChart(
      chartContainerRef.current,
      chartContainerRef.current.clientWidth,
      chartContainerRef.current.clientHeight
    );
    chartRef.current = chart;

    const resizeObserver = new ResizeObserver((entries) => {
      if (entries.length === 0 || entries[0].target !== chartContainerRef.current) return;
      const newRect = entries[0].contentRect;
      chart.applyOptions({ width: newRect.width, height: newRect.height });
    });

    resizeObserver.observe(chartContainerRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  // Crosshair tooltip subscription — runs once chart is ready, re-binds when data changes
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || data.length === 0) return;

    const handler = (param: MouseEventParams) => {
      if (!param.time || !param.seriesData) {
        setTooltip(null);
        return;
      }

      // Try to grab the main price series data from whichever key we used
      const mainKey = 'main';
      const mainSeries = seriesMapRef.current.get(mainKey);
      if (!mainSeries) { setTooltip(null); return; }

      const barData = param.seriesData.get(mainSeries) as any;
      if (!barData) { setTooltip(null); return; }

      // Find corresponding raw bar to get volume
      const rawBar = rawDataRef.current.find(d => d.datetime === param.time);

      setTooltip({
        time: String(param.time),
        open: barData.open ?? barData.value ?? 0,
        high: barData.high ?? barData.value ?? 0,
        low: barData.low ?? barData.value ?? 0,
        close: barData.close ?? barData.value ?? 0,
        volume: rawBar?.volume,
      });
    };

    chart.subscribeCrosshairMove(handler);
    return () => {
      chart.unsubscribeCrosshairMove(handler);
    };
  }, [data]);

  // Render series whenever data, chartType, or indicators change
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || data.length === 0) return;

    try {
      // Clear old series
      seriesMapRef.current.forEach(series => chart.removeSeries(series));
      seriesMapRef.current.clear();

      // ── Build main price series ──────────────────────────────────────────
      const baseChartData = data.map(d => ({
        time: d.datetime,
        open: d.open,
        high: d.high,
        low: d.low,
        close: d.close,
      }));

      let mainSeries: ISeriesApi<any>;

      if (chartType === 'candlestick') {
        mainSeries = chart.addSeries(CandlestickSeries, {
          upColor: '#00e676',
          downColor: '#ff1744',
          borderVisible: false,
          wickUpColor: '#00e676',
          wickDownColor: '#ff1744',
        });
        mainSeries.setData(baseChartData);
      } else if (chartType === 'heikinashi') {
        const haData = calculateHeikinAshi(baseChartData);
        if (haData.length > 0 && baseChartData.length > 0) {
           const trueCurrentPrice = baseChartData[baseChartData.length - 1].close;
           const lastHa = { ...haData[haData.length - 1] };
           lastHa.close = trueCurrentPrice;
           if (trueCurrentPrice > lastHa.high) lastHa.high = trueCurrentPrice;
           if (trueCurrentPrice < lastHa.low) lastHa.low = trueCurrentPrice;
           haData[haData.length - 1] = lastHa;
        }
        mainSeries = chart.addSeries(CandlestickSeries, {
          upColor: '#00b4d8',
          downColor: '#9d4edd',
          borderVisible: false,
          wickUpColor: '#00b4d8',
          wickDownColor: '#9d4edd',
        });
        mainSeries.setData(haData);
      } else if (chartType === 'line') {
        mainSeries = chart.addSeries(LineSeries, {
          color: '#00d4aa',
          lineWidth: 2,
        });
        mainSeries.setData(baseChartData.map(d => ({ time: d.time, value: d.close })));
      } else {
        // mountain / area
        mainSeries = chart.addSeries(AreaSeries, {
          lineColor: '#00d4aa',
          topColor: 'rgba(0, 212, 170, 0.3)',
          bottomColor: 'rgba(0, 212, 170, 0.0)',
          lineWidth: 2,
        });
        mainSeries.setData(baseChartData.map(d => ({ time: d.time, value: d.close })));
      }

      seriesMapRef.current.set('main', mainSeries);

      // ── Indicators ────────────────────────────────────────────────────────
      const indicatorData = data.map(d => ({
        time: d.datetime,
        open: d.open,
        high: d.high,
        low: d.low,
        close: d.close,
        volume: d.volume,
      }));

      const activeIndicators = indicators.filter(i => i.enabled);
      let nextPaneIndex = 1;

      activeIndicators.forEach((ind, i) => {
        if (ind.type === 'SMA' || ind.type === 'EMA') {
          const period = Number(ind.params.period) || 14;
          const calcData =
            ind.type === 'SMA'
              ? calculateSMA(indicatorData, period)
              : calculateEMA(indicatorData, period);

          const series = chart.addSeries(LineSeries, {
            color: ind.color || getSeriesColor(ind.type, i),
            lineWidth: 2,
          });
          series.setData(calcData);
          seriesMapRef.current.set(`ind_${i}`, series);
        } else if (ind.type === 'BOLLINGER') {
          const period = Number(ind.params.period) || 20;
          const stdDev = Number(ind.params.stdDev) || 2;
          const bbData = calculateBollingerBands(indicatorData, period, stdDev);

          const color = ind.color || '#2962FF';

          const upper = chart.addSeries(LineSeries, { color, lineWidth: 1, lineStyle: 2 });
          const middle = chart.addSeries(LineSeries, { color, lineWidth: 1 });
          const lower = chart.addSeries(LineSeries, { color, lineWidth: 1, lineStyle: 2 });

          upper.setData(bbData.map(d => ({ time: d.time, value: d.upper })));
          middle.setData(bbData.map(d => ({ time: d.time, value: d.middle })));
          lower.setData(bbData.map(d => ({ time: d.time, value: d.lower })));

          seriesMapRef.current.set(`ind_${i}_u`, upper);
          seriesMapRef.current.set(`ind_${i}_m`, middle);
          seriesMapRef.current.set(`ind_${i}_l`, lower);
        } else if (ind.type === 'RSI') {
          const period = Number(ind.params.period) || 14;
          const rsiData = calculateRSI(indicatorData, period);

          const series = chart.addSeries(LineSeries, {
            color: ind.color || '#9d4edd',
            lineWidth: 2,
          });
          series.setData(rsiData);
          seriesMapRef.current.set(`ind_${i}`, series);
        } else if (ind.type === 'VOLUME') {
          const series = chart.addSeries(HistogramSeries, {
            color: '#26a69a',
            priceFormat: {
              type: 'volume',
            },
            priceScaleId: 'volume',
          });
          chart.priceScale('volume').applyOptions({
            scaleMargins: {
              top: 0.8,
              bottom: 0,
            },
          });
          const volData = indicatorData.map(d => ({
            time: d.time,
            value: d.volume,
            color: d.close >= d.open ? '#00e676' : '#ff1744'
          }));
          series.setData(volData);
          seriesMapRef.current.set(`ind_${i}`, series);
        } else if (ind.type === 'MACD') {
          const fast = Number(ind.params.fastPeriod) || 12;
          const slow = Number(ind.params.slowPeriod) || 26;
          const sig = Number(ind.params.signalPeriod) || 9;

          const macdData = calculateMACD(indicatorData, fast, slow, sig);
          nextPaneIndex++;

          const macdLine = chart.addSeries(LineSeries, { color: '#00b4d8', lineWidth: 2 });
          const sigLine = chart.addSeries(LineSeries, { color: '#fca311', lineWidth: 1 });
          const histLine = chart.addSeries(HistogramSeries, { color: '#e0a96d' });

          macdLine.setData(macdData.map(d => ({ time: d.time, value: d.macd })));
          sigLine.setData(macdData.map(d => ({ time: d.time, value: d.signal })));
          histLine.setData(
            macdData.map(d => ({
              time: d.time,
              value: d.histogram,
              color: d.histogram >= 0 ? '#00e676' : '#ff1744',
            }))
          );

          seriesMapRef.current.set(`ind_${i}_m`, macdLine);
          seriesMapRef.current.set(`ind_${i}_s`, sigLine);
          seriesMapRef.current.set(`ind_${i}_h`, histLine);
        }
      });

      chart.timeScale().fitContent();
    } catch (err: any) {
      console.error(err);
      setError('Chart Error: ' + err.message);
    }
  }, [data, chartType, indicators]);

  return (
    <div className={styles.wrapper}>
      {loading && <div className={styles.loader}>Loading...</div>}
      {error && <div className={styles.error}>{error}</div>}
      <OHLCTooltip data={tooltip} />
      <div ref={chartContainerRef} className={styles.chart} />
    </div>
  );
};
