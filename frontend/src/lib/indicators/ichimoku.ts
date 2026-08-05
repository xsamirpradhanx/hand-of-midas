import type { OHLCVBar } from './types';

export interface IchimokuPoint {
  time: number | string;
  tenkan: number | null;
  kijun: number | null;
  senkouA: number | null;
  senkouB: number | null;
  chikou: number | null;
}

function midpoint(data: OHLCVBar[], start: number, end: number): number {
  let hi = -Infinity, lo = Infinity;
  for (let i = start; i <= end; i++) {
    if (data[i].high > hi) hi = data[i].high;
    if (data[i].low  < lo) lo = data[i].low;
  }
  return (hi + lo) / 2;
}

/**
 * Ichimoku Cloud (Ichimoku Kinko Hyo)
 * - Tenkan-sen (Conversion): (9-period high + low) / 2
 * - Kijun-sen  (Base):       (26-period high + low) / 2
 * - Senkou Span A:           (Tenkan + Kijun) / 2, plotted 26 bars ahead
 * - Senkou Span B:           (52-period high + low) / 2, plotted 26 bars ahead
 * - Chikou Span:             Current close, plotted 26 bars behind
 *
 * Values are returned WITHOUT displacement (aligned to current bar).
 * The renderer handles the visual offset for Senkou / Chikou.
 */
export function calculateIchimoku(data: OHLCVBar[]): IchimokuPoint[] {
  const tenkanPeriod = 9;
  const kijunPeriod  = 26;
  const senkouBPeriod = 52;

  if (!data || data.length < senkouBPeriod) return [];

  const result: IchimokuPoint[] = [];

  for (let i = 0; i < data.length; i++) {
    const tenkan = i >= tenkanPeriod - 1
      ? midpoint(data, i - tenkanPeriod + 1, i)
      : null;
    const kijun = i >= kijunPeriod - 1
      ? midpoint(data, i - kijunPeriod + 1, i)
      : null;
    const senkouA = tenkan !== null && kijun !== null ? (tenkan + kijun) / 2 : null;
    const senkouB = i >= senkouBPeriod - 1
      ? midpoint(data, i - senkouBPeriod + 1, i)
      : null;
    const chikou = data[i].close;

    result.push({ time: data[i].time, tenkan, kijun, senkouA, senkouB, chikou });
  }

  return result;
}
