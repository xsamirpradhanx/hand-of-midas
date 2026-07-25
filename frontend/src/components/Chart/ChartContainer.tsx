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
import { ZonePlugin, PredictiveZone } from '../../lib/chartPlugins/ZonePlugin';
import { OHLCTooltip } from './OHLCTooltip';
import type { ChartType } from './ChartTypeBar';
import { useLivePricing } from '../../hooks/useLivePricing';
import styles from './ChartContainer.module.css';

interface ChartContainerProps {
  symbol: string;
  interval: string;
  indicators: IndicatorConfig[];
  chartType: ChartType;
  showExtendedHours?: boolean;
  showPredictiveZones?: boolean;
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
  showExtendedHours = false,
  showPredictiveZones = false,
}) => {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesMapRef = useRef<Map<string, ISeriesApi<any>>>(new Map());
  const rawDataRef = useRef<OHLCVDataPoint[]>([]);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirstIndicatorsRender = useRef(true);

  const [data, setData] = useState<OHLCVDataPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  // Auto-save indicator config with 500 ms debounce whenever indicators or symbol change.
  // Skip the first render to avoid saving state loaded from the API back immediately.
  useEffect(() => {
    if (isFirstIndicatorsRender.current) {
      isFirstIndicatorsRender.current = false;
      return;
    }
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setSaveStatus('saving');
    saveTimerRef.current = setTimeout(async () => {
      try {
        await api.saveChartConfig(symbol, { indicators });
        setSaveStatus('saved');
        setTimeout(() => setSaveStatus('idle'), 2000);
      } catch {
        setSaveStatus('error');
        setTimeout(() => setSaveStatus('idle'), 3000);
      }
    }, 500);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [indicators, symbol]);

  // Live Pricing Hook
  // We prefer polygon if key is found, otherwise finnhub
  const provider = localStorage.getItem('POLYGON_API_KEY') || import.meta.env.VITE_POLYGON_API_KEY ? 'polygon' : 'finnhub';
  const { latestTick } = useLivePricing(symbol, provider);

  // Fetch data when symbol or interval changes
  useEffect(() => {
    let isMounted = true;

    const fetchData = async () => {
      setLoading(true);
      setError('');
      setTooltip(null);
      try {
        const [marketResult, quoteResult] = await Promise.all([
          api.getMarketData(symbol, interval, '200', showExtendedHours),
          api.getQuote(symbol).catch(() => null)
        ]);
        if (isMounted) {
          // Ensure ascending order (oldest first). We don't blindly reverse anymore
          // because backend guarantees ascending order, but old cached data might be descending.
          const parseDt = (dt: string) => {
            if (dt.length <= 10) return new Date(dt + 'T00:00:00Z').getTime();
            if (dt.endsWith('Z')) return new Date(dt).getTime();
            return new Date(dt.replace(' ', 'T') + 'Z').getTime();
          };
          const seenTimes = new Set<number>();
          const ordered: OHLCVDataPoint[] = [];
          for (const rawItem of marketResult.data) {
            const t = parseDt(rawItem.datetime);
            if (!isNaN(t) && !seenTimes.has(t)) {
              seenTimes.add(t);
              const vol = typeof rawItem.volume === 'number' && !isNaN(rawItem.volume) ? rawItem.volume : 0;
              ordered.push({ ...rawItem, volume: vol });
            }
          }
          ordered.sort((a, b) => parseDt(a.datetime) - parseDt(b.datetime));

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
  }, [symbol, interval, showExtendedHours]);

  // Initialize chart once on mount
  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createMainChart(
      chartContainerRef.current,
      chartContainerRef.current.clientWidth,
      chartContainerRef.current.clientHeight
    );
    chartRef.current = chart;

    const resizeObserver = new ResizeObserver(() => {
      if (!chartContainerRef.current) return;
      const rect = chartContainerRef.current.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        // Check visibility state BEFORE resize
        const logicalRange = chart.timeScale().getVisibleLogicalRange();
        const wasFitted = logicalRange !== null && logicalRange.from <= 0;

        chart.applyOptions({ width: rect.width, height: rect.height });

        // If we were fully zoomed out (hitting left edge), stay fully zoomed out during the resize
        if (wasFitted) {
          chart.timeScale().fitContent();
        }
      }
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
      const rawBar = rawDataRef.current.find(d => {
        const parsed = d.datetime.length <= 10 ? d.datetime : new Date(d.datetime.replace(' ', 'T') + 'Z').getTime() / 1000;
        return parsed === param.time;
      });

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

  // Handle live tick updates
  useEffect(() => {
    if (!latestTick) return;
    const mainSeries = seriesMapRef.current.get('main');
    if (!mainSeries || rawDataRef.current.length === 0) return;

    const lastBar = rawDataRef.current[rawDataRef.current.length - 1];
    const newPrice = latestTick.price;
    
    // Check if the tick timestamp belongs to a NEW bar based on interval (simplified logic here just updates current bar)
    // For intraday, you'd ideally check if (latestTick.timestamp * 1000) > lastBar.time + intervalMs
    
    lastBar.close = newPrice;
    if (newPrice > lastBar.high) lastBar.high = newPrice;
    if (newPrice < lastBar.low) lastBar.low = newPrice;
    if (latestTick.volume) lastBar.volume = (lastBar.volume || 0) + latestTick.volume;

    try {
      const parseTime = (dt: string) => {
        if (dt.length <= 10) return dt;
        if (dt.endsWith('Z')) return new Date(dt).getTime() / 1000;
        return new Date(dt.replace(' ', 'T') + 'Z').getTime() / 1000;
      };

      if (chartType === 'candlestick' || chartType === 'heikinashi') {
        mainSeries.update({
          time: parseTime(lastBar.datetime) as any,
          open: lastBar.open,
          high: lastBar.high,
          low: lastBar.low,
          close: lastBar.close,
        } as any);
      } else {
        mainSeries.update({
          time: parseTime(lastBar.datetime) as any,
          value: lastBar.close,
        } as any);
      }

      const volSeries = seriesMapRef.current.get('VOLUME');
      if (volSeries) {
        volSeries.update({
          time: parseTime(lastBar.datetime) as any,
          value: typeof lastBar.volume === 'number' && !isNaN(lastBar.volume) ? lastBar.volume : 0,
          color: lastBar.close >= lastBar.open ? '#00e676' : '#ff1744',
        });
      }
    } catch (err) {
      console.error("Failed to update chart tick", err);
    }
  }, [latestTick, chartType]);

  // Render series whenever data, chartType, or indicators change
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || data.length === 0) return;

    try {
      // Clear old series
      seriesMapRef.current.forEach(series => chart.removeSeries(series));
      seriesMapRef.current.clear();

      // Temporarily enable autoScale so the new data sizes correctly to the viewport
      chart.priceScale('right').applyOptions({ autoScale: true });

      const parseTime = (dt: string) => {
        if (dt.length <= 10) return dt;
        if (dt.endsWith('Z')) return new Date(dt).getTime() / 1000;
        return new Date(dt.replace(' ', 'T') + 'Z').getTime() / 1000;
      };

      // ── Build main price series ──────────────────────────────────────────
      const baseChartData: any[] = data.map(d => ({
        time: parseTime(d.datetime) as any,
        open: d.open,
        high: d.high,
        low: d.low,
        close: d.close,
      }));
      
      // Inject WhitespaceData if we need to project predictive zones into the future
      if (showPredictiveZones && baseChartData.length > 0) {
        const lastTime = baseChartData[baseChartData.length - 1].time;
        
        if (typeof lastTime === 'string') {
          // It's a YYYY-MM-DD string
          let currentDate = new Date(lastTime);
          for (let i = 0; i < 30; i++) {
            currentDate.setUTCDate(currentDate.getUTCDate() + 1);
            // Skip weekends
            if (currentDate.getUTCDay() === 0 || currentDate.getUTCDay() === 6) continue;
            const nextDateStr = currentDate.toISOString().split('T')[0];
            baseChartData.push({ time: nextDateStr });
          }
        } else {
          // It's a UNIX timestamp
          let currentTime = lastTime as number;
          for (let i = 0; i < 30; i++) {
            currentTime += 86400; // 1 day jump
            baseChartData.push({ time: currentTime });
          }
        }
      }

      let mainSeries: ISeriesApi<any>;

      if (chartType === 'candlestick') {
        mainSeries = chart.addSeries(CandlestickSeries, {
          upColor: '#26a69a',
          downColor: '#ef5350',
          borderVisible: false,
          wickUpColor: '#26a69a',
          wickDownColor: '#ef5350',
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
          upColor: '#00bcd4',
          downColor: '#e91e63',
          borderVisible: false,
          wickUpColor: '#00bcd4',
          wickDownColor: '#e91e63',
        });
        mainSeries.setData(haData);
      } else if (chartType === 'line') {
        mainSeries = chart.addSeries(LineSeries, {
          color: '#ffffff',
          lineWidth: 2,
        });
        mainSeries.setData(baseChartData.map(d => ({ time: d.time, value: d.close })));
      } else {
        // mountain / area
        mainSeries = chart.addSeries(AreaSeries, {
          lineColor: '#ffffff',
          topColor: 'rgba(255, 255, 255, 0.4)',
          bottomColor: 'rgba(255, 255, 255, 0.0)',
          lineWidth: 2,
        });
        mainSeries.setData(baseChartData.map(d => ({ time: d.time, value: d.close })));
      }

      seriesMapRef.current.set('main', mainSeries);

      // ── Indicators ────────────────────────────────────────────────────────
      const indicatorData = data.map(d => ({
        time: parseTime(d.datetime) as any,
        open: d.open,
        high: d.high,
        low: d.low,
        close: d.close,
        volume: d.volume,
      }));

      const activeIndicators = indicators.filter(i => i.enabled);

      // Track series by semantic key (type+period) so cleanup is deterministic across re-renders.
      activeIndicators.forEach((ind, i) => {
        if (ind.type === 'SMA' || ind.type === 'EMA') {
          const period = Number(ind.params.period) || 14;
          const calcData =
            ind.type === 'SMA'
              ? calculateSMA(indicatorData, period)
              : calculateEMA(indicatorData, period);

          const key = `${ind.type}_${period}`;
          const series = chart.addSeries(LineSeries, {
            color: ind.color || getSeriesColor(ind.type, i),
            lineWidth: 2,
          });
          series.setData(calcData);
          seriesMapRef.current.set(key, series);
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

          seriesMapRef.current.set(`BOLLINGER_${period}_upper`, upper);
          seriesMapRef.current.set(`BOLLINGER_${period}_middle`, middle);
          seriesMapRef.current.set(`BOLLINGER_${period}_lower`, lower);
        } else if (ind.type === 'RSI') {
          const period = Number(ind.params.period) || 14;
          const rsiData = calculateRSI(indicatorData, period);

          const series = chart.addSeries(LineSeries, {
            color: ind.color || '#9d4edd',
            lineWidth: 2,
          });
          series.setData(rsiData);
          seriesMapRef.current.set(`RSI_${period}`, series);
        } else if (ind.type === 'VOLUME') {
          const series = chart.addSeries(HistogramSeries, {
            color: '#26a69a',
            priceFormat: { type: 'volume' },
            priceScaleId: 'volume',
          });
          chart.priceScale('volume').applyOptions({
            scaleMargins: { top: 0.8, bottom: 0 },
          });

          // Ensure volume values are clean numbers and timestamps are unique
          const volSeen = new Set<number | string>();
          const volData: any[] = [];
          for (const d of indicatorData) {
            if (!volSeen.has(d.time)) {
              volSeen.add(d.time);
              const val = typeof d.volume === 'number' && !isNaN(d.volume) ? d.volume : 0;
              volData.push({
                time: d.time,
                value: val,
                color: d.close >= d.open ? '#00e676' : '#ff1744',
              });
            }
          }

          series.setData(volData);
          seriesMapRef.current.set('VOLUME', series);
        } else if (ind.type === 'MACD') {
          const fast = Number(ind.params.fastPeriod) || 12;
          const slow = Number(ind.params.slowPeriod) || 26;
          const sig = Number(ind.params.signalPeriod) || 9;
          const macdData = calculateMACD(indicatorData, fast, slow, sig);

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
            })),
          );

          seriesMapRef.current.set('MACD_macd', macdLine);
          seriesMapRef.current.set('MACD_signal', sigLine);
          seriesMapRef.current.set('MACD_histogram', histLine);
        }
      });
      
      // ── Attach Zone Plugin if active ────────────────────────────────────────
      if (showPredictiveZones) {
        api.getPredictiveZones(symbol).then((res) => {
          if (res && res.zones && res.zones.length > 0) {
            const plugin = new ZonePlugin(chart);
            // Start projecting from today to the end of the whitespace
            const startTime = baseChartData[baseChartData.length - 31]?.time; // start where actual data ends
            const endTime = baseChartData[baseChartData.length - 1]?.time; // end of whitespace
            
            plugin.updateZones(res.zones, startTime, endTime);
            mainSeries.attachPrimitive(plugin);

            // Add native price lines to guarantee visibility on the price axis
            res.zones.forEach((zone: PredictiveZone) => {
              const color = zone.type === 'buy' ? '#00e676' : '#ff1744';
              const label = zone.type === 'buy' ? 'AI Buy Zone' : 'AI Sell Zone';
              
              mainSeries.createPriceLine({
                price: zone.priceTop,
                color,
                lineWidth: 1,
                lineStyle: 2, // Dotted
                axisLabelVisible: true,
                title: `${label} Top`,
              });
              mainSeries.createPriceLine({
                price: zone.priceBottom,
                color,
                lineWidth: 1,
                lineStyle: 2, // Dotted
                axisLabelVisible: true,
                title: `${label} Bottom`,
              });
            });

            // Re-apply autoscale to fit the newly attached zones, then disable again
            chart.priceScale('right').applyOptions({ autoScale: true });
            setTimeout(() => {
              chart.priceScale('right').applyOptions({ autoScale: false });
            }, 50);
          }
        }).catch(err => console.error("Failed to fetch predictive zones", err));
      }

      chart.timeScale().fitContent();
      
      // Disable autoScale shortly after render to allow immediate vertical panning without having to drag the Y-axis
      requestAnimationFrame(() => {
        chart.priceScale('right').applyOptions({ autoScale: false });
      });
    } catch (err: any) {
      console.error(err);
      setError('Chart Error: ' + err.message);
    }
  }, [data, chartType, indicators, showPredictiveZones]);

  return (
    <div className={styles.wrapper}>
      {loading && <div className={styles.loader}>Loading...</div>}
      {error && <div className={styles.error}>{error}</div>}
      {saveStatus === 'saving' && <div className={styles.saveStatus}>Saving…</div>}
      {saveStatus === 'saved' && <div className={`${styles.saveStatus} ${styles.saveStatusOk}`}>Saved ✓</div>}
      {saveStatus === 'error' && <div className={`${styles.saveStatus} ${styles.saveStatusErr}`}>Save failed</div>}
      <OHLCTooltip data={tooltip} />
      <div ref={chartContainerRef} className={styles.chart} />
    </div>
  );
};
