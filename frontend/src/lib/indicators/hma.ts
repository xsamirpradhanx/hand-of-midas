import type { OHLCVBar, IndicatorValue } from './types';
import { calculateWMA } from './wma';

/**
 * Hull Moving Average — drastically reduces lag while maintaining smoothness.
 * HMA(n) = WMA(2×WMA(n/2) − WMA(n), sqrt(n))
 */
export function calculateHMA(data: OHLCVBar[], period: number = 9): IndicatorValue[] {
  if (!data || data.length < period) return [];

  const halfPeriod = Math.floor(period / 2);
  const sqrtPeriod = Math.round(Math.sqrt(period));

  const wmaFull = calculateWMA(data, period);
  const wmaHalf = calculateWMA(data, halfPeriod);

  // Align arrays — wmaFull starts at index (period-1), wmaHalf at (halfPeriod-1)
  const offset = (period - 1) - (halfPeriod - 1); // how many extra bars wmaFull has skipped
  if (wmaFull.length === 0 || wmaHalf.length < wmaFull.length) return [];

  // Build 2×WMA(n/2) − WMA(n) series, aligned on wmaFull's time stamps
  const diffBars: OHLCVBar[] = wmaFull.map((v, i) => ({
    time: v.time,
    open: 0, high: 0, low: 0, volume: 0,
    close: 2 * wmaHalf[i + offset].value - v.value,
  }));

  return calculateWMA(diffBars, sqrtPeriod);
}
