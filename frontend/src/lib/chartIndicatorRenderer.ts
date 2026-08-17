import { IChartApi, ISeriesApi, LineSeries, HistogramSeries, AreaSeries } from 'lightweight-charts';
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
// New indicators
import { calculateWMA } from './indicators/wma';
import { calculateHMA } from './indicators/hma';
import { calculateKeltnerChannels } from './indicators/keltnerChannels';
import { calculateDonchianChannels } from './indicators/donchianChannels';
import { calculateParabolicSAR } from './indicators/parabolicSar';
import { calculateIchimoku } from './indicators/ichimoku';
import { calculateCCI } from './indicators/cci';
import { calculateWilliamsR } from './indicators/williamsR';
import { calculateOBV } from './indicators/obv';
import { calculateCMF } from './indicators/cmf';
import { calculateMFI } from './indicators/mfi';
import { calculateROC } from './indicators/roc';
import { calculateMomentum } from './indicators/momentum';
import { calculateAroon } from './indicators/aroon';
import type { OHLCVBar } from './indicators/types';

type InternalOHLCV = {
  time: number | string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/** Indicator types that render in a separate sub-pane below the main chart. */
const SUB_PANE_TYPES = [
  'VOLUME', 'RSI', 'MACD', 'ATR', 'STOCHASTIC', 'ADX',
  'CCI', 'WILLR', 'OBV', 'CMF', 'MFI', 'ROC', 'MOM', 'AROON',
];

/**
 * Relative pane heights. Price gets the bulk; each oscillator gets a readable slice.
 * With one sub-pane that is a 75/25 split, with three it is 50/16.6 each.
 */
const PRICE_PANE_STRETCH = 3;
const SUB_PANE_STRETCH = 1;

/**
 * Pin a pane's axis to a fixed range instead of autoscaling it to the visible data.
 *
 * Bounded oscillators are read against absolute thresholds — RSI 70/30 only means
 * something on a 0–100 axis. Autoscaling zooms the axis to whatever the series
 * happens to span in view, so a quiet stretch reading 45–55 stretches to fill the
 * pane and looks identical to a violent swing from 5 to 95, with the 70/30 guides
 * pushed off-pane entirely.
 */
const fixedRange = (minValue: number, maxValue: number) =>
  () => ({ priceRange: { minValue, maxValue } });

/**
 * Keep a from-zero series (volume, and other non-negative magnitudes) off negative ticks,
 * while otherwise leaving the library's own autoscaling alone.
 *
 * `original` is the base implementation *function*, not its result — it has to be called.
 */
const nonNegativeRange = () => (original: () => { priceRange: { minValue: number; maxValue: number } } | null) => {
  const base = original();
  if (!base?.priceRange) return base;
  return { ...base, priceRange: { ...base.priceRange, minValue: 0 } };
};

export function renderIndicators(
  chart: IChartApi,
  indicatorData: InternalOHLCV[],
  activeIndicators: IndicatorConfig[],
  seriesMapRef: React.MutableRefObject<Map<string, ISeriesApi<any>>>
) {
  const data = indicatorData as unknown as OHLCVBar[];

  // Give every sub-pane indicator a real pane of its own.
  //
  // These were previously faked by putting all series on the main chart and using
  // scaleMargins to squeeze each into a horizontal band. That left the price scale
  // mapped over only the top slice of the chart while the axis still drew ticks across
  // the full height, so every label below the price region was a linear extrapolation
  // of the price scale running down through zero — producing negative "volume" ticks
  // on instruments that have never traded below 0. Worse, sub-pane series sat on
  // overlay price scales, which lightweight-charts does not render on the axis at all,
  // so a bounded oscillator like RSI had no readable 0–100 scale of its own.
  //
  // v5 panes each own an independent, separately-rendered and separately-autoscaled
  // price scale, which is what both problems actually required.
  const activeSubPanes = activeIndicators.filter(ind => SUB_PANE_TYPES.includes(ind.type));
  const paneIndexFor = new Map<IndicatorConfig, number>();
  activeSubPanes.forEach((ind, n) => paneIndexFor.set(ind, n + 1)); // pane 0 is price

  // The price pane keeps symmetric breathing room; it is no longer compressed to make
  // space for the sub-panes, since panes are laid out by the library instead.
  chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 } });

  const typeCounters: Record<string, number> = {};

  activeIndicators.forEach((ind, i) => {
    const paneIndex = paneIndexFor.get(ind) ?? null;

    // ── Overlay: SMA / EMA ─────────────────────────────────────────────────
    if (ind.type === 'SMA' || ind.type === 'EMA') {
      const period = Number(ind.params.period) || 14;
      const calcData = ind.type === 'SMA'
        ? calculateSMA(data, period)
        : calculateEMA(data, period);
      const key = `${ind.type}_${period}`;
      const typeIndex = typeCounters[ind.type] ?? 0;
      typeCounters[ind.type] = typeIndex + 1;
      const series = chart.addSeries(LineSeries, {
        color: ind.color || getSeriesColor(ind.type, typeIndex),
        lineWidth: 2,
        // Each overlay otherwise draws its own dashed price-line and stacked
        // axis label, which clutters the axis when several MAs sit close to
        // price. The candlestick series already owns the price-line/label.
        priceLineVisible: false,
        lastValueVisible: false,
      });
      series.setData(calcData as any);
      seriesMapRef.current.set(key, series);

    // ── Overlay: WMA ────────────────────────────────────────────────────────
    } else if (ind.type === 'WMA') {
      const period = Number(ind.params.period) || 14;
      const wmaData = calculateWMA(data, period);
      const series = chart.addSeries(LineSeries, {
        color: ind.color || '#ff9800',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      series.setData(wmaData as any);
      seriesMapRef.current.set(`WMA_${period}`, series);

    // ── Overlay: HMA ────────────────────────────────────────────────────────
    } else if (ind.type === 'HMA') {
      const period = Number(ind.params.period) || 9;
      const hmaData = calculateHMA(data, period);
      const series = chart.addSeries(LineSeries, {
        color: ind.color || '#e91e63',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      series.setData(hmaData as any);
      seriesMapRef.current.set(`HMA_${period}`, series);

    // ── Overlay: Bollinger Bands ────────────────────────────────────────────
    } else if (ind.type === 'BOLLINGER') {
      const period = Number(ind.params.period) || 20;
      const stdDev = Number(ind.params.stdDev) || 2;
      const bbData = calculateBollingerBands(data, period, stdDev);
      const color  = ind.color || '#2962FF';
      const lineOpts = { priceLineVisible: false, lastValueVisible: false };
      const upper  = chart.addSeries(LineSeries, { color, lineWidth: 1, lineStyle: 2, ...lineOpts });
      const middle = chart.addSeries(LineSeries, { color, lineWidth: 1, ...lineOpts });
      const lower  = chart.addSeries(LineSeries, { color, lineWidth: 1, lineStyle: 2, ...lineOpts });
      upper.setData(bbData.map(d => ({ time: d.time, value: d.upper })) as any);
      middle.setData(bbData.map(d => ({ time: d.time, value: d.middle })) as any);
      lower.setData(bbData.map(d => ({ time: d.time, value: d.lower })) as any);
      seriesMapRef.current.set(`BOLLINGER_${period}_upper`,  upper);
      seriesMapRef.current.set(`BOLLINGER_${period}_middle`, middle);
      seriesMapRef.current.set(`BOLLINGER_${period}_lower`,  lower);

    // ── Overlay: Keltner Channels ───────────────────────────────────────────
    } else if (ind.type === 'KC') {
      const period = Number(ind.params.period) || 20;
      const mult   = Number(ind.params.mult)   || 2;
      const kcData = calculateKeltnerChannels(data, period, mult);
      const color  = ind.color || '#00bcd4';
      const lineOpts = { priceLineVisible: false, lastValueVisible: false };
      const upper  = chart.addSeries(LineSeries, { color, lineWidth: 1, lineStyle: 2, ...lineOpts });
      const middle = chart.addSeries(LineSeries, { color, lineWidth: 1, ...lineOpts });
      const lower  = chart.addSeries(LineSeries, { color, lineWidth: 1, lineStyle: 2, ...lineOpts });
      upper.setData(kcData.map(d => ({ time: d.time, value: d.upper })) as any);
      middle.setData(kcData.map(d => ({ time: d.time, value: d.middle })) as any);
      lower.setData(kcData.map(d => ({ time: d.time, value: d.lower })) as any);
      seriesMapRef.current.set(`KC_${period}_upper`,  upper);
      seriesMapRef.current.set(`KC_${period}_middle`, middle);
      seriesMapRef.current.set(`KC_${period}_lower`,  lower);

    // ── Overlay: Donchian Channels ──────────────────────────────────────────
    } else if (ind.type === 'DC') {
      const period = Number(ind.params.period) || 20;
      const dcData = calculateDonchianChannels(data, period);
      const color  = ind.color || '#9c27b0';
      const lineOpts = { priceLineVisible: false, lastValueVisible: false };
      const upper  = chart.addSeries(LineSeries, { color, lineWidth: 1, lineStyle: 2, ...lineOpts });
      const middle = chart.addSeries(LineSeries, { color: `${color}88`, lineWidth: 1, lineStyle: 1, ...lineOpts });
      const lower  = chart.addSeries(LineSeries, { color, lineWidth: 1, lineStyle: 2, ...lineOpts });
      upper.setData(dcData.map(d => ({ time: d.time, value: d.upper })) as any);
      middle.setData(dcData.map(d => ({ time: d.time, value: d.middle })) as any);
      lower.setData(dcData.map(d => ({ time: d.time, value: d.lower })) as any);
      seriesMapRef.current.set(`DC_${period}_upper`,  upper);
      seriesMapRef.current.set(`DC_${period}_middle`, middle);
      seriesMapRef.current.set(`DC_${period}_lower`,  lower);

    // ── Overlay: Parabolic SAR ──────────────────────────────────────────────
    } else if (ind.type === 'PSAR') {
      const step = Number(ind.params.step) || 0.02;
      const max  = Number(ind.params.max)  || 0.2;
      const sarData = calculateParabolicSAR(data, step, max);
      const series = chart.addSeries(LineSeries, {
        color: ind.color || '#ff5722',
        lineWidth: 1,
        lineStyle: 0,
        // Render as dots by setting line width 0 and using crosshair markers isn't ideal
        // We use a very thin line — lightweight-charts doesn't support scatter natively
        crosshairMarkerVisible: true,
        lastValueVisible: false,
        priceLineVisible: false,
      });
      series.setData(sarData as any);
      seriesMapRef.current.set('PSAR', series);

    // ── Overlay: Ichimoku Cloud ─────────────────────────────────────────────
    } else if (ind.type === 'ICHIMOKU') {
      const ichiData = calculateIchimoku(data);
      const ichiLineOpts = { priceLineVisible: false, lastValueVisible: false };
      const tenkanSeries  = chart.addSeries(LineSeries, { color: '#e91e63', lineWidth: 1, ...ichiLineOpts });
      const kijunSeries   = chart.addSeries(LineSeries, { color: '#2196f3', lineWidth: 1, ...ichiLineOpts });
      const senkouASeries = chart.addSeries(LineSeries, { color: 'rgba(0,230,118,0.5)', lineWidth: 1, lineStyle: 2, ...ichiLineOpts });
      const senkouBSeries = chart.addSeries(LineSeries, { color: 'rgba(255,23,68,0.5)',  lineWidth: 1, lineStyle: 2, ...ichiLineOpts });
      const chikouSeries  = chart.addSeries(LineSeries, { color: '#795548', lineWidth: 1, ...ichiLineOpts });

      const filterValid = (arr: any[], key: string) =>
        arr.filter(d => d[key] !== null).map(d => ({ time: d.time, value: d[key] }));

      tenkanSeries.setData(filterValid(ichiData, 'tenkan')  as any);
      kijunSeries.setData(filterValid(ichiData, 'kijun')   as any);
      senkouASeries.setData(filterValid(ichiData, 'senkouA') as any);
      senkouBSeries.setData(filterValid(ichiData, 'senkouB') as any);
      // Chikou: close price shifted 26 bars back — use the data offset
      const chikouShift = 26;
      const chikouData = ichiData.slice(0, ichiData.length - chikouShift).map((d, idx) => ({
        time: ichiData[idx].time,
        value: d.chikou,
      }));
      chikouSeries.setData(chikouData as any);

      seriesMapRef.current.set('ICHIMOKU_tenkan',  tenkanSeries);
      seriesMapRef.current.set('ICHIMOKU_kijun',   kijunSeries);
      seriesMapRef.current.set('ICHIMOKU_senkouA', senkouASeries);
      seriesMapRef.current.set('ICHIMOKU_senkouB', senkouBSeries);
      seriesMapRef.current.set('ICHIMOKU_chikou',  chikouSeries);

    // ── Overlay: VWAP ───────────────────────────────────────────────────────
    } else if (ind.type === 'VWAP') {
      const vwapData = calculateVWAP(data);
      const series = chart.addSeries(LineSeries, {
        color: ind.color || '#ff4081',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      series.setData(vwapData as any);
      seriesMapRef.current.set('VWAP', series);

    // ── Sub-Pane: RSI ───────────────────────────────────────────────────────
    } else if (ind.type === 'RSI' && paneIndex !== null) {
      const period = Number(ind.params.period) || 14;
      const rsiData = calculateRSI(data, period);
      const series = chart.addSeries(LineSeries, {
        color: '#ffffff',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        crosshairMarkerVisible: true,
        autoscaleInfoProvider: fixedRange(0, 100),
      }, paneIndex);
      series.setData(rsiData as any);
      series.createPriceLine({ price: 70, color: 'rgba(255,80,80,0.7)',   lineWidth: 1, lineStyle: 2, axisLabelVisible: true,  title: 'OB' });
      series.createPriceLine({ price: 30, color: 'rgba(80,200,120,0.7)', lineWidth: 1, lineStyle: 2, axisLabelVisible: true,  title: 'OS' });
      series.createPriceLine({ price: 50, color: 'rgba(255,255,255,0.15)', lineWidth: 1, lineStyle: 1, axisLabelVisible: false, title: '' });
      seriesMapRef.current.set(`RSI_${period}`, series);

    // ── Sub-Pane: ATR ───────────────────────────────────────────────────────
    } else if (ind.type === 'ATR' && paneIndex !== null) {
      const period = Number(ind.params.period) || 14;
      const atrData = calculateATR(data, period);
      const series = chart.addSeries(LineSeries, {
        color: ind.color || '#00d4aa',
        lineWidth: 2,
              }, paneIndex);
      series.setData(atrData as any);
      seriesMapRef.current.set(`ATR_${period}`, series);

    // ── Sub-Pane: Stochastic ────────────────────────────────────────────────
    } else if (ind.type === 'STOCHASTIC' && paneIndex !== null) {
      const periodK = Number(ind.params.periodK) || 14;
      const periodD = Number(ind.params.periodD) || 3;
      const stochData = calculateStochastic(data, periodK, periodD);
      const kSeries   = chart.addSeries(LineSeries, { color: '#00b4d8', lineWidth: 2, autoscaleInfoProvider: fixedRange(0, 100) }, paneIndex);
      const dSeries   = chart.addSeries(LineSeries, { color: '#fca311', lineWidth: 1 }, paneIndex);
      kSeries.setData(stochData.map((d: any) => ({ time: d.time, value: d.k })) as any);
      dSeries.setData(stochData.map((d: any) => ({ time: d.time, value: d.d })) as any);
      seriesMapRef.current.set(`STOCHASTIC_${periodK}_k`, kSeries);
      seriesMapRef.current.set(`STOCHASTIC_${periodD}_d`, dSeries);

    // ── Sub-Pane: Volume ────────────────────────────────────────────────────
    } else if (ind.type === 'VOLUME' && paneIndex !== null) {
      const series  = chart.addSeries(HistogramSeries, {
        color: '#26a69a',
        priceFormat: { type: 'volume' },
        autoscaleInfoProvider: nonNegativeRange(),
      }, paneIndex);
      const volSeen = new Set<number | string>();
      const volData: any[] = [];
      for (const d of data) {
        if (!volSeen.has(d.time)) {
          volSeen.add(d.time);
          const val = typeof d.volume === 'number' && !isNaN(d.volume) ? d.volume : 0;
          volData.push({ time: d.time, value: val, color: d.close >= d.open ? '#00e676' : '#ff1744' });
        }
      }
      series.setData(volData as any);
      seriesMapRef.current.set('VOLUME', series);

    // ── Sub-Pane: MACD ──────────────────────────────────────────────────────
    } else if (ind.type === 'MACD' && paneIndex !== null) {
      const fast = Number(ind.params.fastPeriod) || 12;
      const slow = Number(ind.params.slowPeriod) || 26;
      const sig  = Number(ind.params.signalPeriod) || 9;
      const macdData = calculateMACD(data, fast, slow, sig);
      const macdLine = chart.addSeries(LineSeries,      { color: '#00b4d8', lineWidth: 2 }, paneIndex);
      const sigLine  = chart.addSeries(LineSeries,      { color: '#fca311', lineWidth: 1 }, paneIndex);
      const histLine = chart.addSeries(HistogramSeries, { color: '#e0a96d' }, paneIndex);
      macdLine.setData(macdData.map((d: any) => ({ time: d.time, value: d.macd })) as any);
      sigLine.setData(macdData.map((d: any) => ({ time: d.time, value: d.signal })) as any);
      histLine.setData(macdData.map((d: any) => ({ time: d.time, value: d.histogram, color: d.histogram >= 0 ? '#00e676' : '#ff1744' })) as any);
      seriesMapRef.current.set(`MACD_${fast}_${slow}_${sig}_macd`,      macdLine);
      seriesMapRef.current.set(`MACD_${fast}_${slow}_${sig}_signal`,    sigLine);
      seriesMapRef.current.set(`MACD_${fast}_${slow}_${sig}_histogram`, histLine);

    // ── Sub-Pane: ADX ───────────────────────────────────────────────────────
    } else if (ind.type === 'ADX' && paneIndex !== null) {
      const period = Number(ind.params.period) || 14;
      const adxData = calculateADX(data, period);
      const plusDI   = chart.addSeries(LineSeries, { color: '#00e676', lineWidth: 1.5, autoscaleInfoProvider: fixedRange(0, 100) }, paneIndex);
      const minusDI  = chart.addSeries(LineSeries, { color: '#ff1744', lineWidth: 1.5 }, paneIndex);
      const adxLine  = chart.addSeries(LineSeries, { color: '#ffd700', lineWidth: 2 }, paneIndex);
      plusDI.setData(adxData.map(d  => ({ time: d.time, value: d.plusDI  })) as any);
      minusDI.setData(adxData.map(d => ({ time: d.time, value: d.minusDI })) as any);
      adxLine.setData(adxData.map(d => ({ time: d.time, value: d.adx     })) as any);
      seriesMapRef.current.set(`ADX_${period}_plusDI`,  plusDI);
      seriesMapRef.current.set(`ADX_${period}_minusDI`, minusDI);
      seriesMapRef.current.set(`ADX_${period}_adx`,     adxLine);

    // ── Sub-Pane: CCI ───────────────────────────────────────────────────────
    } else if (ind.type === 'CCI' && paneIndex !== null) {
      const period  = Number(ind.params.period) || 20;
      const cciData = calculateCCI(data, period);
      const series  = chart.addSeries(LineSeries, {
        color: '#ab47bc',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
      }, paneIndex);
      series.setData(cciData as any);
      series.createPriceLine({ price:  100, color: 'rgba(255,80,80,0.6)',   lineWidth: 1, lineStyle: 2, axisLabelVisible: true,  title: 'OB' });
      series.createPriceLine({ price: -100, color: 'rgba(80,200,120,0.6)', lineWidth: 1, lineStyle: 2, axisLabelVisible: true,  title: 'OS' });
      series.createPriceLine({ price:    0, color: 'rgba(255,255,255,0.2)', lineWidth: 1, lineStyle: 1, axisLabelVisible: false, title: '' });
      seriesMapRef.current.set(`CCI_${period}`, series);

    // ── Sub-Pane: Williams %R ───────────────────────────────────────────────
    } else if (ind.type === 'WILLR' && paneIndex !== null) {
      const period    = Number(ind.params.period) || 14;
      const willrData = calculateWilliamsR(data, period);
      const series    = chart.addSeries(LineSeries, {
        color: '#26c6da',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        autoscaleInfoProvider: fixedRange(-100, 0),
      }, paneIndex);
      series.setData(willrData as any);
      series.createPriceLine({ price:  -20, color: 'rgba(255,80,80,0.6)',   lineWidth: 1, lineStyle: 2, axisLabelVisible: true,  title: 'OB' });
      series.createPriceLine({ price:  -80, color: 'rgba(80,200,120,0.6)', lineWidth: 1, lineStyle: 2, axisLabelVisible: true,  title: 'OS' });
      series.createPriceLine({ price:  -50, color: 'rgba(255,255,255,0.2)', lineWidth: 1, lineStyle: 1, axisLabelVisible: false, title: '' });
      seriesMapRef.current.set(`WILLR_${period}`, series);

    // ── Sub-Pane: OBV ───────────────────────────────────────────────────────
    } else if (ind.type === 'OBV' && paneIndex !== null) {
      const obvData = calculateOBV(data);
      const series  = chart.addSeries(LineSeries, {
        color: '#66bb6a',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
      }, paneIndex);
      series.setData(obvData as any);
      seriesMapRef.current.set('OBV', series);

    // ── Sub-Pane: CMF ───────────────────────────────────────────────────────
    } else if (ind.type === 'CMF' && paneIndex !== null) {
      const period  = Number(ind.params.period) || 20;
      const cmfData = calculateCMF(data, period);
      const series  = chart.addSeries(HistogramSeries, {
        color: '#42a5f5',
        priceLineVisible: false,
        lastValueVisible: true,
      }, paneIndex);
      series.setData(cmfData.map(d => ({
        time:  d.time,
        value: d.value,
        color: d.value >= 0 ? 'rgba(0,230,118,0.7)' : 'rgba(255,23,68,0.7)',
      })) as any);
      seriesMapRef.current.set(`CMF_${period}`, series);

    // ── Sub-Pane: MFI ───────────────────────────────────────────────────────
    } else if (ind.type === 'MFI' && paneIndex !== null) {
      const period  = Number(ind.params.period) || 14;
      const mfiData = calculateMFI(data, period);
      const series  = chart.addSeries(LineSeries, {
        color: '#ffa726',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        autoscaleInfoProvider: fixedRange(0, 100),
      }, paneIndex);
      series.setData(mfiData as any);
      series.createPriceLine({ price:  80, color: 'rgba(255,80,80,0.6)',   lineWidth: 1, lineStyle: 2, axisLabelVisible: true,  title: 'OB' });
      series.createPriceLine({ price:  20, color: 'rgba(80,200,120,0.6)', lineWidth: 1, lineStyle: 2, axisLabelVisible: true,  title: 'OS' });
      series.createPriceLine({ price:  50, color: 'rgba(255,255,255,0.2)', lineWidth: 1, lineStyle: 1, axisLabelVisible: false, title: '' });
      seriesMapRef.current.set(`MFI_${period}`, series);

    // ── Sub-Pane: ROC ───────────────────────────────────────────────────────
    } else if (ind.type === 'ROC' && paneIndex !== null) {
      const period  = Number(ind.params.period) || 12;
      const rocData = calculateROC(data, period);
      const series  = chart.addSeries(LineSeries, {
        color: '#ef5350',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
      }, paneIndex);
      series.setData(rocData as any);
      series.createPriceLine({ price: 0, color: 'rgba(255,255,255,0.25)', lineWidth: 1, lineStyle: 1, axisLabelVisible: false, title: '' });
      seriesMapRef.current.set(`ROC_${period}`, series);

    // ── Sub-Pane: Momentum ──────────────────────────────────────────────────
    } else if (ind.type === 'MOM' && paneIndex !== null) {
      const period  = Number(ind.params.period) || 10;
      const momData = calculateMomentum(data, period);
      const series  = chart.addSeries(HistogramSeries, {
        color: '#78909c',
        priceLineVisible: false,
        lastValueVisible: true,
      }, paneIndex);
      series.setData(momData.map(d => ({
        time:  d.time,
        value: d.value,
        color: d.value >= 0 ? 'rgba(0,230,118,0.65)' : 'rgba(255,23,68,0.65)',
      })) as any);
      seriesMapRef.current.set(`MOM_${period}`, series);

    // ── Sub-Pane: Aroon ─────────────────────────────────────────────────────
    } else if (ind.type === 'AROON' && paneIndex !== null) {
      const period    = Number(ind.params.period) || 25;
      const aroonData = calculateAroon(data, period);
      const upSeries  = chart.addSeries(LineSeries, { color: '#00e676', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: true, autoscaleInfoProvider: fixedRange(0, 100) }, paneIndex);
      const dnSeries  = chart.addSeries(LineSeries, { color: '#ff1744', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false }, paneIndex);
      upSeries.setData(aroonData.map(d => ({ time: d.time, value: d.up   })) as any);
      dnSeries.setData(aroonData.map(d => ({ time: d.time, value: d.down })) as any);
      seriesMapRef.current.set(`AROON_${period}_up`,   upSeries);
      seriesMapRef.current.set(`AROON_${period}_down`, dnSeries);
    }
  });

  // Weight the panes so price keeps most of the canvas. Without this the library
  // splits height evenly and three oscillators leave price with a quarter of the chart.
  //
  // Stretch factors rather than setHeight: setHeight is absolute pixels, and the
  // ResizeObserver in ChartContainer re-lays-out the chart on every container resize,
  // which redistributes height and squashes fixed-height panes back down. Stretch
  // factors are proportional, so the split survives resizing.
  const panes = chart.panes();
  if (panes.length > 1) {
    panes[0].setStretchFactor(PRICE_PANE_STRETCH);
    for (let p = 1; p < panes.length; p++) {
      panes[p].setStretchFactor(SUB_PANE_STRETCH);
    }
  }

  // ── Fibonacci overlay ─────────────────────────────────────────────────────
  const fibIndicator = activeIndicators.find(ind => ind.type === 'FIBONACCI');
  if (fibIndicator) {
    const fibLevels = calculateFibonacci(data);
    fibLevels.forEach((fib) => {
      const color     = fib.level === 0.5 || fib.level === 0.618 ? '#ffd700' : 'rgba(255,215,0,0.4)';
      const lineWidth = fib.level === 0.5 || fib.level === 0.618 ? 2 : 1;
      const series    = chart.addSeries(LineSeries, {
        color,
        lineWidth,
        lineStyle: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
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
