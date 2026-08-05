import type { OHLCVBar, IndicatorValue } from './types';

/**
 * Williams %R — momentum oscillator between -100 and 0.
 * -80 and below = oversold, -20 and above = overbought.
 */
export function calculateWilliamsR(data: OHLCVBar[], period: number = 14): IndicatorValue[] {
  if (!data || data.length < period) return [];
  const result: IndicatorValue[] = [];

  for (let i = period - 1; i < data.length; i++) {
    let highestHigh = -Infinity;
    let lowestLow   = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (data[j].high > highestHigh) highestHigh = data[j].high;
      if (data[j].low  < lowestLow)  lowestLow   = data[j].low;
    }
    const range = highestHigh - lowestLow;
    const wr = range === 0 ? -50 : ((highestHigh - data[i].close) / range) * -100;
    result.push({ time: data[i].time, value: wr });
  }
  return result;
}
