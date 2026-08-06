import React, { useEffect, useRef, useState } from 'react';
import { createMainChart } from '../../lib/chartHelpers';
import { api } from '../../lib/api';
import {
  IChartApi,
  ISeriesApi,
  CandlestickSeries,
  LineSeries,
  AreaSeries,
  MouseEventParams,
} from 'lightweight-charts';
import type { IndicatorConfig, OHLCVDataPoint } from '../../types';
import { calculateHeikinAshi } from '../../lib/indicators/heikinAshi';
import { renderIndicators } from '../../lib/chartIndicatorRenderer';
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
  timezone?: 'EST' | 'GMT';
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
  timezone = 'EST',
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
            const currentPrice = (showExtendedHours && quoteResult.preMarketPrice != null) 
              ? quoteResult.preMarketPrice 
              : quoteResult.price;
            const lastBar = { ...ordered[ordered.length - 1] };
            lastBar.close = currentPrice;
            if (currentPrice > lastBar.high) lastBar.high = currentPrice;
            if (currentPrice < lastBar.low) lastBar.low = currentPrice;
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

  // Apply timezone formatting — always ET (market timezone)
  useEffect(() => {
    if (!chartRef.current) return;

    const tickMarkFormatter = (time: number | string, tickMarkType: any) => {
      if (typeof time === 'string') return time;
      const date = new Date(time * 1000);
      const options: Intl.DateTimeFormatOptions = { timeZone: 'America/New_York' };
      if (tickMarkType === 0) options.year = 'numeric';
      else if (tickMarkType === 1) options.month = 'short';
      else if (tickMarkType === 2) options.day = 'numeric';
      else { options.hour = '2-digit'; options.minute = '2-digit'; options.hour12 = false; }
      return date.toLocaleString('en-US', options);
    };

    chartRef.current.applyOptions({
      timeScale: { tickMarkFormatter }
    });
  }, [timezone]);

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

      const formatTooltipTime = (t: number | string) => {
        if (typeof t === 'string') return t;
        const tzString = timezone === 'EST' ? 'America/New_York' : 'UTC';
        return new Date(t * 1000).toLocaleString('en-US', {
          timeZone: tzString,
          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
        });
      };

      setTooltip({
        time: formatTooltipTime(param.time),
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
  }, [data, timezone]);

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
          priceLineColor: '#ffffff',
          priceLineWidth: 2,
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
          priceLineColor: '#ffffff',
          priceLineWidth: 2,
        });
        mainSeries.setData(haData);
      } else if (chartType === 'line') {
        mainSeries = chart.addSeries(LineSeries, {
          color: '#ffffff',
          lineWidth: 2,
          priceLineColor: '#ffffff',
          priceLineWidth: 2,
        });
        mainSeries.setData(baseChartData.map(d => ({ time: d.time, value: d.close })));
      } else {
        // mountain / area
        mainSeries = chart.addSeries(AreaSeries, {
          lineColor: '#ffffff',
          topColor: 'rgba(255, 255, 255, 0.4)',
          bottomColor: 'rgba(255, 255, 255, 0.0)',
          lineWidth: 2,
          priceLineColor: '#ffffff',
          priceLineWidth: 2,
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
      
      // Use abstracted renderer
      renderIndicators(chart, indicatorData, activeIndicators, seriesMapRef);
      
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
            
            // Explicitly force the visible range to span all data points to eliminate left-side gaps
            chart.timeScale().setVisibleLogicalRange({ from: 0, to: baseChartData.length - 1 });

            setTimeout(() => {
              chart.priceScale('right').applyOptions({ autoScale: false });
            }, 50);
          }
        }).catch(err => console.error("Failed to fetch predictive zones", err));
      }
      // Force the logical range instead of fitContent to ensure the chart uses the full width
      chart.timeScale().setVisibleLogicalRange({ from: 0, to: baseChartData.length - 1 });
      
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
