import type { OHLCVBar, IndicatorValue } from './types';

/** Momentum — raw price difference over N periods. */
export function calculateMomentum(data: OHLCVBar[], period: number = 10): IndicatorValue[] {
  if (!data || data.length < period + 1) return [];
  const result: IndicatorValue[] = [];

  for (let i = period; i < data.length; i++) {
    result.push({ time: data[i].time, value: data[i].close - data[i - period].close });
  }
  return result;
}
