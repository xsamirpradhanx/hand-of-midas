import type { OHLCVBar, IndicatorValue } from './types';

/** Weighted Moving Average — linearly-weighted, recent prices get higher weight. */
export function calculateWMA(data: OHLCVBar[], period: number = 14): IndicatorValue[] {
  if (!data || data.length < period) return [];
  const result: IndicatorValue[] = [];
  const weight = (period * (period + 1)) / 2;

  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += data[i - j].close * (period - j);
    }
    result.push({ time: data[i].time, value: sum / weight });
  }
  return result;
}
