import type { OHLCVBar } from './types';

export interface AroonPoint {
  time: number | string;
  up: number;
  down: number;
  oscillator: number;
}

/**
 * Aroon Indicator — measures how recently the highest high / lowest low occurred.
 * Range: 0–100. Aroon Up > 70 = uptrend, Aroon Down > 70 = downtrend.
 */
export function calculateAroon(data: OHLCVBar[], period: number = 25): AroonPoint[] {
  if (!data || data.length < period + 1) return [];
  const result: AroonPoint[] = [];

  for (let i = period; i < data.length; i++) {
    let highestIdx = i, lowestIdx = i;
    for (let j = i - period; j <= i; j++) {
      if (data[j].high >= data[highestIdx].high) highestIdx = j;
      if (data[j].low  <= data[lowestIdx].low)   lowestIdx  = j;
    }
    const up   = ((period - (i - highestIdx)) / period) * 100;
    const down = ((period - (i - lowestIdx))  / period) * 100;
    result.push({ time: data[i].time, up, down, oscillator: up - down });
  }
  return result;
}
