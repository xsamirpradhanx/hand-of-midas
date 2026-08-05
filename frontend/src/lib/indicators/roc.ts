import type { OHLCVBar, IndicatorValue } from './types';

/** Rate of Change — percentage price change over N periods. Zero-centered. */
export function calculateROC(data: OHLCVBar[], period: number = 12): IndicatorValue[] {
  if (!data || data.length < period + 1) return [];
  const result: IndicatorValue[] = [];

  for (let i = period; i < data.length; i++) {
    const prev = data[i - period].close;
    const roc  = prev === 0 ? 0 : ((data[i].close - prev) / prev) * 100;
    result.push({ time: data[i].time, value: roc });
  }
  return result;
}
