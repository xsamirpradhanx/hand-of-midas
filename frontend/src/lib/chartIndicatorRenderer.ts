import { IChartApi, ISeriesApi, LineSeries, HistogramSeries } from 'lightweight-charts';
import { getSeriesColor } from './chartHelpers';
import type { IndicatorConfig } from '../types';

import { calculateSMA } from './indicators/sma';
import { calculateEMA } from './indicators/ema';
import { calculateRSI } from './indicators/rsi';
import { calculateMACD } from './indicators/macd';
import { calculateBollingerBands } from './indicators/bollingerBands';
import { calculateVWAP } from './indicators/vwap';
import { calculateATR } from './indicators/atr';
import { calculateStochastic } from './indicators/stochastic';
import { calculateADX } from './indicators/adx';
import { calculateFibonacci } from './indicators/fibonacci';
import type { OHLCVBar } from './indicators/types';

// Optional: you can define a specific type for the internal OHLCV format expected by indicator math
type InternalOHLCV = {
  time: number | string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export function renderIndicators(
  chart: IChartApi,
  indicatorData: InternalOHLCV[],
  activeIndicators: IndicatorConfig[],
  seriesMapRef: React.MutableRefObject<Map<string, ISeriesApi<any>>>
) {
  const data = indicatorData as unknown as OHLCVBar[];

  // 1. Identify which indicators require a sub-pane
  const subPaneTypes = ['VOLUME', 'RSI', 'MACD', 'ATR', 'STOCHASTIC', 'ADX'];
  const activeSubPanes = activeIndicators.filter(ind => subPaneTypes.includes(ind.type));
  const subPaneCount = activeSubPanes.length;

  // 2. Adjust main price scale to make room for sub-panes at the bottom.
  // Each sub-pane takes up 15% of the vertical space. 
  // Max sub-panes we support nicely is ~4 (60% height).
  const paneHeight = 0.15;
  const totalSubHeight = Math.min(subPaneCount * paneHeight, 0.6);
  chart.priceScale('right').applyOptions({
    scaleMargins: {
      top: 0.1,
      bottom: totalSubHeight + 0.02,
    },
  });

  // Track the current bottom offset for allocating sub-panes
  let currentBottom = 0;

  activeIndicators.forEach((ind, i) => {
    // Determine margins for this indicator if it's a sub-pane
    let margins: { top: number; bottom: number } | null = null;
    if (subPaneTypes.includes(ind.type)) {
      margins = {
        top: 1.0 - totalSubHeight + currentBottom + 0.02,
        bottom: totalSubHeight - currentBottom - paneHeight,
      };
      // Prevent negative bottom margin if too many panes
      if (margins.bottom < 0) margins.bottom = 0;
      currentBottom += paneHeight;
    }

    if (ind.type === 'SMA' || ind.type === 'EMA') {
      const period = Number(ind.params.period) || 14;
      const calcData = ind.type === 'SMA'
        ? calculateSMA(data, period)
        : calculateEMA(data, period);

      const key = `${ind.type}_${period}`;
      const series = chart.addSeries(LineSeries, {
        color: ind.color || getSeriesColor(ind.type, i),
        lineWidth: 2,
      });
      series.setData(calcData as any);
      seriesMapRef.current.set(key, series);
    } else if (ind.type === 'BOLLINGER') {
      const period = Number(ind.params.period) || 20;
      const stdDev = Number(ind.params.stdDev) || 2;
      const bbData = calculateBollingerBands(data, period, stdDev);
      const color = ind.color || '#2962FF';

      const upper = chart.addSeries(LineSeries, { color, lineWidth: 1, lineStyle: 2 });
      const middle = chart.addSeries(LineSeries, { color, lineWidth: 1 });
      const lower = chart.addSeries(LineSeries, { color, lineWidth: 1, lineStyle: 2 });

      upper.setData(bbData.map(d => ({ time: d.time, value: d.upper })) as any);
      middle.setData(bbData.map(d => ({ time: d.time, value: d.middle })) as any);
      lower.setData(bbData.map(d => ({ time: d.time, value: d.lower })) as any);

      seriesMapRef.current.set(`BOLLINGER_${period}_upper`, upper);
      seriesMapRef.current.set(`BOLLINGER_${period}_middle`, middle);
      seriesMapRef.current.set(`BOLLINGER_${period}_lower`, lower);
    } else if (ind.type === 'VWAP') {
      const vwapData = calculateVWAP(data);
      const series = chart.addSeries(LineSeries, {
        color: ind.color || '#ff4081',
        lineWidth: 2,
      });
      series.setData(vwapData as any);
      seriesMapRef.current.set('VWAP', series);
    } else if (ind.type === 'RSI' && margins) {
      const period = Number(ind.params.period) || 14;
      const rsiData = calculateRSI(data, period);

      const series = chart.addSeries(LineSeries, {
        color: ind.color || '#9d4edd',
        lineWidth: 2,
        priceScaleId: `rsi_${i}`,
      });
      chart.priceScale(`rsi_${i}`).applyOptions({ scaleMargins: margins });
      series.setData(rsiData as any);
      seriesMapRef.current.set(`RSI_${period}`, series);
    } else if (ind.type === 'ATR' && margins) {
      const period = Number(ind.params.period) || 14;
      const atrData = calculateATR(data, period);

      const series = chart.addSeries(LineSeries, {
        color: ind.color || '#00d4aa',
        lineWidth: 2,
        priceScaleId: `atr_${i}`,
      });
      chart.priceScale(`atr_${i}`).applyOptions({ scaleMargins: margins });
      series.setData(atrData as any);
      seriesMapRef.current.set(`ATR_${period}`, series);
    } else if (ind.type === 'STOCHASTIC' && margins) {
      const periodK = Number(ind.params.periodK) || 14;
      const periodD = Number(ind.params.periodD) || 3;
      const stochData = calculateStochastic(data, periodK, periodD);

      const scaleId = `stoch_${i}`;
      const kSeries = chart.addSeries(LineSeries, {
        color: '#00b4d8',
        lineWidth: 2,
        priceScaleId: scaleId,
      });
      const dSeries = chart.addSeries(LineSeries, {
        color: '#fca311',
        lineWidth: 1,
        priceScaleId: scaleId,
      });
      chart.priceScale(scaleId).applyOptions({ scaleMargins: margins });

      kSeries.setData(stochData.map((d: any) => ({ time: d.time, value: d.k })) as any);
      dSeries.setData(stochData.map((d: any) => ({ time: d.time, value: d.d })) as any);
      
      seriesMapRef.current.set(`STOCHASTIC_${periodK}_k`, kSeries);
      seriesMapRef.current.set(`STOCHASTIC_${periodD}_d`, dSeries);
    } else if (ind.type === 'VOLUME' && margins) {
      const series = chart.addSeries(HistogramSeries, {
        color: '#26a69a',
        priceFormat: { type: 'volume' },
        priceScaleId: `volume_${i}`,
      });
      chart.priceScale(`volume_${i}`).applyOptions({ scaleMargins: margins });

      const volSeen = new Set<number | string>();
      const volData: any[] = [];
      for (const d of data) {
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

      series.setData(volData as any);
      seriesMapRef.current.set('VOLUME', series);
    } else if (ind.type === 'MACD' && margins) {
      const fast = Number(ind.params.fastPeriod) || 12;
      const slow = Number(ind.params.slowPeriod) || 26;
      const sig = Number(ind.params.signalPeriod) || 9;
      const macdData = calculateMACD(data, fast, slow, sig);

      const scaleId = `macd_${i}`;
      const macdLine = chart.addSeries(LineSeries, { color: '#00b4d8', lineWidth: 2, priceScaleId: scaleId });
      const sigLine = chart.addSeries(LineSeries, { color: '#fca311', lineWidth: 1, priceScaleId: scaleId });
      const histLine = chart.addSeries(HistogramSeries, { color: '#e0a96d', priceScaleId: scaleId });
      
      chart.priceScale(scaleId).applyOptions({ scaleMargins: margins });

      macdLine.setData(macdData.map((d: any) => ({ time: d.time, value: d.macd })) as any);
      sigLine.setData(macdData.map((d: any) => ({ time: d.time, value: d.signal })) as any);
      histLine.setData(
        macdData.map((d: any) => ({
          time: d.time,
          value: d.histogram,
          color: d.histogram >= 0 ? '#00e676' : '#ff1744',
        })) as any
      );

      seriesMapRef.current.set(`MACD_${fast}_${slow}_${sig}_macd`, macdLine);
      seriesMapRef.current.set(`MACD_${fast}_${slow}_${sig}_signal`, sigLine);
      seriesMapRef.current.set(`MACD_${fast}_${slow}_${sig}_histogram`, histLine);
    } else if (ind.type === 'ADX' && margins) {
      const period = Number(ind.params.period) || 14;
      const adxData = calculateADX(data, period);
      const scaleId = `adx_${i}`;
      
      const plusDISeries = chart.addSeries(LineSeries, { color: '#00e676', lineWidth: 1.5, priceScaleId: scaleId });
      const minusDISeries = chart.addSeries(LineSeries, { color: '#ff1744', lineWidth: 1.5, priceScaleId: scaleId });
      const adxSeries = chart.addSeries(LineSeries, { color: '#ffd700', lineWidth: 2, priceScaleId: scaleId });
      
      chart.priceScale(scaleId).applyOptions({ scaleMargins: margins });
      
      plusDISeries.setData(adxData.map(d => ({ time: d.time, value: d.plusDI })) as any);
      minusDISeries.setData(adxData.map(d => ({ time: d.time, value: d.minusDI })) as any);
      adxSeries.setData(adxData.map(d => ({ time: d.time, value: d.adx })) as any);
      
      seriesMapRef.current.set(`ADX_${period}_plusDI`, plusDISeries);
      seriesMapRef.current.set(`ADX_${period}_minusDI`, minusDISeries);
      seriesMapRef.current.set(`ADX_${period}_adx`, adxSeries);
    }
  });

  // Fibonacci overlay (rendered after other indicators)
  const fibIndicator = activeIndicators.find(ind => ind.type === 'FIBONACCI');
  if (fibIndicator) {
    const fibLevels = calculateFibonacci(data);
    
    fibLevels.forEach((fib, idx) => {
      const color = fib.level === 0.5 || fib.level === 0.618 ? '#ffd700' : 'rgba(255, 215, 0, 0.4)';
      const lineWidth = fib.level === 0.5 || fib.level === 0.618 ? 2 : 1;
      const series = chart.addSeries(LineSeries, {
        color,
        lineWidth,
        lineStyle: 2, // dashed
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      // Create a flat horizontal line spanning the full data range
      if (data.length >= 2) {
        series.setData([
          { time: data[0].time, value: fib.price },
          { time: data[data.length - 1].time, value: fib.price },
        ] as any);
      }
      seriesMapRef.current.set(`FIB_${fib.label}`, series);
    });
  }
}
