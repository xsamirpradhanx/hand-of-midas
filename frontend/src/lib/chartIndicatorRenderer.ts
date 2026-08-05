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

export function renderIndicators(
  chart: IChartApi,
  indicatorData: InternalOHLCV[],
  activeIndicators: IndicatorConfig[],
  seriesMapRef: React.MutableRefObject<Map<string, ISeriesApi<any>>>
) {
  const data = indicatorData as unknown as OHLCVBar[];

  // Allocate sub-pane vertical space
  const activeSubPanes = activeIndicators.filter(ind => SUB_PANE_TYPES.includes(ind.type));
  const subPaneCount = activeSubPanes.length;
  const paneHeight = 0.15;
  const totalSubHeight = Math.min(subPaneCount * paneHeight, 0.6);
  chart.priceScale('right').applyOptions({
    scaleMargins: { top: 0.1, bottom: totalSubHeight + 0.02 },
  });

  let currentBottom = 0;

  activeIndicators.forEach((ind, i) => {
    let margins: { top: number; bottom: number } | null = null;
    if (SUB_PANE_TYPES.includes(ind.type)) {
      margins = {
        top:    1.0 - totalSubHeight + currentBottom + 0.02,
        bottom: Math.max(0, totalSubHeight - currentBottom - paneHeight),
      };
      currentBottom += paneHeight;
    }

    // ── Overlay: SMA / EMA ─────────────────────────────────────────────────
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

    // ── Overlay: WMA ────────────────────────────────────────────────────────
    } else if (ind.type === 'WMA') {
      const period = Number(ind.params.period) || 14;
      const wmaData = calculateWMA(data, period);
      const series = chart.addSeries(LineSeries, {
        color: ind.color || '#ff9800',
        lineWidth: 2,
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
      });
      series.setData(hmaData as any);
      seriesMapRef.current.set(`HMA_${period}`, series);

    // ── Overlay: Bollinger Bands ────────────────────────────────────────────
    } else if (ind.type === 'BOLLINGER') {
      const period = Number(ind.params.period) || 20;
      const stdDev = Number(ind.params.stdDev) || 2;
      const bbData = calculateBollingerBands(data, period, stdDev);
      const color  = ind.color || '#2962FF';
      const upper  = chart.addSeries(LineSeries, { color, lineWidth: 1, lineStyle: 2 });
      const middle = chart.addSeries(LineSeries, { color, lineWidth: 1 });
      const lower  = chart.addSeries(LineSeries, { color, lineWidth: 1, lineStyle: 2 });
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
      const upper  = chart.addSeries(LineSeries, { color, lineWidth: 1, lineStyle: 2 });
      const middle = chart.addSeries(LineSeries, { color, lineWidth: 1 });
      const lower  = chart.addSeries(LineSeries, { color, lineWidth: 1, lineStyle: 2 });
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
      const upper  = chart.addSeries(LineSeries, { color, lineWidth: 1, lineStyle: 2 });
      const middle = chart.addSeries(LineSeries, { color: `${color}88`, lineWidth: 1, lineStyle: 1 });
      const lower  = chart.addSeries(LineSeries, { color, lineWidth: 1, lineStyle: 2 });
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
      const tenkanSeries  = chart.addSeries(LineSeries, { color: '#e91e63', lineWidth: 1 });
      const kijunSeries   = chart.addSeries(LineSeries, { color: '#2196f3', lineWidth: 1 });
      const senkouASeries = chart.addSeries(LineSeries, { color: 'rgba(0,230,118,0.5)', lineWidth: 1, lineStyle: 2 });
      const senkouBSeries = chart.addSeries(LineSeries, { color: 'rgba(255,23,68,0.5)',  lineWidth: 1, lineStyle: 2 });
      const chikouSeries  = chart.addSeries(LineSeries, { color: '#795548', lineWidth: 1 });

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
      });
      series.setData(vwapData as any);
      seriesMapRef.current.set('VWAP', series);

    // ── Sub-Pane: RSI ───────────────────────────────────────────────────────
    } else if (ind.type === 'RSI' && margins) {
      const period = Number(ind.params.period) || 14;
      const rsiData = calculateRSI(data, period);
      const scaleId = `rsi_${i}`;
      const series = chart.addSeries(LineSeries, {
        color: '#ffffff',
        lineWidth: 2,
        priceScaleId: scaleId,
        priceLineVisible: false,
        lastValueVisible: true,
        crosshairMarkerVisible: true,
      });
      chart.priceScale(scaleId).applyOptions({ scaleMargins: margins });
      series.setData(rsiData as any);
      series.createPriceLine({ price: 70, color: 'rgba(255,80,80,0.7)',   lineWidth: 1, lineStyle: 2, axisLabelVisible: true,  title: 'OB' });
      series.createPriceLine({ price: 30, color: 'rgba(80,200,120,0.7)', lineWidth: 1, lineStyle: 2, axisLabelVisible: true,  title: 'OS' });
      series.createPriceLine({ price: 50, color: 'rgba(255,255,255,0.15)', lineWidth: 1, lineStyle: 1, axisLabelVisible: false, title: '' });
      seriesMapRef.current.set(`RSI_${period}`, series);

    // ── Sub-Pane: ATR ───────────────────────────────────────────────────────
    } else if (ind.type === 'ATR' && margins) {
      const period = Number(ind.params.period) || 14;
      const atrData = calculateATR(data, period);
      const scaleId = `atr_${i}`;
      const series = chart.addSeries(LineSeries, {
        color: ind.color || '#00d4aa',
        lineWidth: 2,
        priceScaleId: scaleId,
      });
      chart.priceScale(scaleId).applyOptions({ scaleMargins: margins });
      series.setData(atrData as any);
      seriesMapRef.current.set(`ATR_${period}`, series);

    // ── Sub-Pane: Stochastic ────────────────────────────────────────────────
    } else if (ind.type === 'STOCHASTIC' && margins) {
      const periodK = Number(ind.params.periodK) || 14;
      const periodD = Number(ind.params.periodD) || 3;
      const stochData = calculateStochastic(data, periodK, periodD);
      const scaleId   = `stoch_${i}`;
      const kSeries   = chart.addSeries(LineSeries, { color: '#00b4d8', lineWidth: 2, priceScaleId: scaleId });
      const dSeries   = chart.addSeries(LineSeries, { color: '#fca311', lineWidth: 1, priceScaleId: scaleId });
      chart.priceScale(scaleId).applyOptions({ scaleMargins: margins });
      kSeries.setData(stochData.map((d: any) => ({ time: d.time, value: d.k })) as any);
      dSeries.setData(stochData.map((d: any) => ({ time: d.time, value: d.d })) as any);
      seriesMapRef.current.set(`STOCHASTIC_${periodK}_k`, kSeries);
      seriesMapRef.current.set(`STOCHASTIC_${periodD}_d`, dSeries);

    // ── Sub-Pane: Volume ────────────────────────────────────────────────────
    } else if (ind.type === 'VOLUME' && margins) {
      const scaleId = `volume_${i}`;
      const series  = chart.addSeries(HistogramSeries, {
        color: '#26a69a',
        priceFormat: { type: 'volume' },
        priceScaleId: scaleId,
      });
      chart.priceScale(scaleId).applyOptions({ scaleMargins: margins });
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
    } else if (ind.type === 'MACD' && margins) {
      const fast = Number(ind.params.fastPeriod) || 12;
      const slow = Number(ind.params.slowPeriod) || 26;
      const sig  = Number(ind.params.signalPeriod) || 9;
      const macdData = calculateMACD(data, fast, slow, sig);
      const scaleId  = `macd_${i}`;
      const macdLine = chart.addSeries(LineSeries,      { color: '#00b4d8', lineWidth: 2, priceScaleId: scaleId });
      const sigLine  = chart.addSeries(LineSeries,      { color: '#fca311', lineWidth: 1, priceScaleId: scaleId });
      const histLine = chart.addSeries(HistogramSeries, { color: '#e0a96d', priceScaleId: scaleId });
      chart.priceScale(scaleId).applyOptions({ scaleMargins: margins });
      macdLine.setData(macdData.map((d: any) => ({ time: d.time, value: d.macd })) as any);
      sigLine.setData(macdData.map((d: any) => ({ time: d.time, value: d.signal })) as any);
      histLine.setData(macdData.map((d: any) => ({ time: d.time, value: d.histogram, color: d.histogram >= 0 ? '#00e676' : '#ff1744' })) as any);
      seriesMapRef.current.set(`MACD_${fast}_${slow}_${sig}_macd`,      macdLine);
      seriesMapRef.current.set(`MACD_${fast}_${slow}_${sig}_signal`,    sigLine);
      seriesMapRef.current.set(`MACD_${fast}_${slow}_${sig}_histogram`, histLine);

    // ── Sub-Pane: ADX ───────────────────────────────────────────────────────
    } else if (ind.type === 'ADX' && margins) {
      const period = Number(ind.params.period) || 14;
      const adxData = calculateADX(data, period);
      const scaleId  = `adx_${i}`;
      const plusDI   = chart.addSeries(LineSeries, { color: '#00e676', lineWidth: 1.5, priceScaleId: scaleId });
      const minusDI  = chart.addSeries(LineSeries, { color: '#ff1744', lineWidth: 1.5, priceScaleId: scaleId });
      const adxLine  = chart.addSeries(LineSeries, { color: '#ffd700', lineWidth: 2,   priceScaleId: scaleId });
      chart.priceScale(scaleId).applyOptions({ scaleMargins: margins });
      plusDI.setData(adxData.map(d  => ({ time: d.time, value: d.plusDI  })) as any);
      minusDI.setData(adxData.map(d => ({ time: d.time, value: d.minusDI })) as any);
      adxLine.setData(adxData.map(d => ({ time: d.time, value: d.adx     })) as any);
      seriesMapRef.current.set(`ADX_${period}_plusDI`,  plusDI);
      seriesMapRef.current.set(`ADX_${period}_minusDI`, minusDI);
      seriesMapRef.current.set(`ADX_${period}_adx`,     adxLine);

    // ── Sub-Pane: CCI ───────────────────────────────────────────────────────
    } else if (ind.type === 'CCI' && margins) {
      const period  = Number(ind.params.period) || 20;
      const cciData = calculateCCI(data, period);
      const scaleId = `cci_${i}`;
      const series  = chart.addSeries(LineSeries, {
        color: '#ab47bc',
        lineWidth: 2,
        priceScaleId: scaleId,
        priceLineVisible: false,
        lastValueVisible: true,
      });
      chart.priceScale(scaleId).applyOptions({ scaleMargins: margins });
      series.setData(cciData as any);
      series.createPriceLine({ price:  100, color: 'rgba(255,80,80,0.6)',   lineWidth: 1, lineStyle: 2, axisLabelVisible: true,  title: 'OB' });
      series.createPriceLine({ price: -100, color: 'rgba(80,200,120,0.6)', lineWidth: 1, lineStyle: 2, axisLabelVisible: true,  title: 'OS' });
      series.createPriceLine({ price:    0, color: 'rgba(255,255,255,0.2)', lineWidth: 1, lineStyle: 1, axisLabelVisible: false, title: '' });
      seriesMapRef.current.set(`CCI_${period}`, series);

    // ── Sub-Pane: Williams %R ───────────────────────────────────────────────
    } else if (ind.type === 'WILLR' && margins) {
      const period    = Number(ind.params.period) || 14;
      const willrData = calculateWilliamsR(data, period);
      const scaleId   = `willr_${i}`;
      const series    = chart.addSeries(LineSeries, {
        color: '#26c6da',
        lineWidth: 2,
        priceScaleId: scaleId,
        priceLineVisible: false,
        lastValueVisible: true,
      });
      chart.priceScale(scaleId).applyOptions({ scaleMargins: margins });
      series.setData(willrData as any);
      series.createPriceLine({ price:  -20, color: 'rgba(255,80,80,0.6)',   lineWidth: 1, lineStyle: 2, axisLabelVisible: true,  title: 'OB' });
      series.createPriceLine({ price:  -80, color: 'rgba(80,200,120,0.6)', lineWidth: 1, lineStyle: 2, axisLabelVisible: true,  title: 'OS' });
      series.createPriceLine({ price:  -50, color: 'rgba(255,255,255,0.2)', lineWidth: 1, lineStyle: 1, axisLabelVisible: false, title: '' });
      seriesMapRef.current.set(`WILLR_${period}`, series);

    // ── Sub-Pane: OBV ───────────────────────────────────────────────────────
    } else if (ind.type === 'OBV' && margins) {
      const obvData = calculateOBV(data);
      const scaleId = `obv_${i}`;
      const series  = chart.addSeries(LineSeries, {
        color: '#66bb6a',
        lineWidth: 2,
        priceScaleId: scaleId,
        priceLineVisible: false,
        lastValueVisible: true,
      });
      chart.priceScale(scaleId).applyOptions({ scaleMargins: margins });
      series.setData(obvData as any);
      seriesMapRef.current.set('OBV', series);

    // ── Sub-Pane: CMF ───────────────────────────────────────────────────────
    } else if (ind.type === 'CMF' && margins) {
      const period  = Number(ind.params.period) || 20;
      const cmfData = calculateCMF(data, period);
      const scaleId = `cmf_${i}`;
      const series  = chart.addSeries(HistogramSeries, {
        color: '#42a5f5',
        priceScaleId: scaleId,
        priceLineVisible: false,
        lastValueVisible: true,
      });
      chart.priceScale(scaleId).applyOptions({ scaleMargins: margins });
      series.setData(cmfData.map(d => ({
        time:  d.time,
        value: d.value,
        color: d.value >= 0 ? 'rgba(0,230,118,0.7)' : 'rgba(255,23,68,0.7)',
      })) as any);
      seriesMapRef.current.set(`CMF_${period}`, series);

    // ── Sub-Pane: MFI ───────────────────────────────────────────────────────
    } else if (ind.type === 'MFI' && margins) {
      const period  = Number(ind.params.period) || 14;
      const mfiData = calculateMFI(data, period);
      const scaleId = `mfi_${i}`;
      const series  = chart.addSeries(LineSeries, {
        color: '#ffa726',
        lineWidth: 2,
        priceScaleId: scaleId,
        priceLineVisible: false,
        lastValueVisible: true,
      });
      chart.priceScale(scaleId).applyOptions({ scaleMargins: margins });
      series.setData(mfiData as any);
      series.createPriceLine({ price:  80, color: 'rgba(255,80,80,0.6)',   lineWidth: 1, lineStyle: 2, axisLabelVisible: true,  title: 'OB' });
      series.createPriceLine({ price:  20, color: 'rgba(80,200,120,0.6)', lineWidth: 1, lineStyle: 2, axisLabelVisible: true,  title: 'OS' });
      series.createPriceLine({ price:  50, color: 'rgba(255,255,255,0.2)', lineWidth: 1, lineStyle: 1, axisLabelVisible: false, title: '' });
      seriesMapRef.current.set(`MFI_${period}`, series);

    // ── Sub-Pane: ROC ───────────────────────────────────────────────────────
    } else if (ind.type === 'ROC' && margins) {
      const period  = Number(ind.params.period) || 12;
      const rocData = calculateROC(data, period);
      const scaleId = `roc_${i}`;
      const series  = chart.addSeries(LineSeries, {
        color: '#ef5350',
        lineWidth: 2,
        priceScaleId: scaleId,
        priceLineVisible: false,
        lastValueVisible: true,
      });
      chart.priceScale(scaleId).applyOptions({ scaleMargins: margins });
      series.setData(rocData as any);
      series.createPriceLine({ price: 0, color: 'rgba(255,255,255,0.25)', lineWidth: 1, lineStyle: 1, axisLabelVisible: false, title: '' });
      seriesMapRef.current.set(`ROC_${period}`, series);

    // ── Sub-Pane: Momentum ──────────────────────────────────────────────────
    } else if (ind.type === 'MOM' && margins) {
      const period  = Number(ind.params.period) || 10;
      const momData = calculateMomentum(data, period);
      const scaleId = `mom_${i}`;
      const series  = chart.addSeries(HistogramSeries, {
        color: '#78909c',
        priceScaleId: scaleId,
        priceLineVisible: false,
        lastValueVisible: true,
      });
      chart.priceScale(scaleId).applyOptions({ scaleMargins: margins });
      series.setData(momData.map(d => ({
        time:  d.time,
        value: d.value,
        color: d.value >= 0 ? 'rgba(0,230,118,0.65)' : 'rgba(255,23,68,0.65)',
      })) as any);
      seriesMapRef.current.set(`MOM_${period}`, series);

    // ── Sub-Pane: Aroon ─────────────────────────────────────────────────────
    } else if (ind.type === 'AROON' && margins) {
      const period    = Number(ind.params.period) || 25;
      const aroonData = calculateAroon(data, period);
      const scaleId   = `aroon_${i}`;
      const upSeries  = chart.addSeries(LineSeries, { color: '#00e676', lineWidth: 1.5, priceScaleId: scaleId, priceLineVisible: false, lastValueVisible: true });
      const dnSeries  = chart.addSeries(LineSeries, { color: '#ff1744', lineWidth: 1.5, priceScaleId: scaleId, priceLineVisible: false, lastValueVisible: false });
      chart.priceScale(scaleId).applyOptions({ scaleMargins: margins });
      upSeries.setData(aroonData.map(d => ({ time: d.time, value: d.up   })) as any);
      dnSeries.setData(aroonData.map(d => ({ time: d.time, value: d.down })) as any);
      seriesMapRef.current.set(`AROON_${period}_up`,   upSeries);
      seriesMapRef.current.set(`AROON_${period}_down`, dnSeries);
    }
  });

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
