import type { OHLCVBar, IndicatorValue } from './types';

/**
 * Commodity Channel Index — measures deviation of price from its average.
 * Typical value: ±100 (overbought/oversold), ±200 (extreme).
 */
export function calculateCCI(data: OHLCVBar[], period: number = 20): IndicatorValue[] {
  if (!data || data.length < period) return [];
  const result: IndicatorValue[] = [];
  const constant = 0.015;

  for (let i = period - 1; i < data.length; i++) {
    // Typical price for each bar in window
    const typicals: number[] = [];
    for (let j = i - period + 1; j <= i; j++) {
      typicals.push((data[j].high + data[j].low + data[j].close) / 3);
    }
    const meanTP = typicals.reduce((s, v) => s + v, 0) / period;
    const meanDev = typicals.reduce((s, v) => s + Math.abs(v - meanTP), 0) / period;
    const cci = meanDev === 0 ? 0 : (typicals[typicals.length - 1] - meanTP) / (constant * meanDev);
    result.push({ time: data[i].time, value: cci });
  }
  return result;
}
