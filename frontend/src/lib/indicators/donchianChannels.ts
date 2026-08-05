import type { OHLCVBar } from './types';

export interface DonchianPoint {
  time: number | string;
  upper: number;
  middle: number;
  lower: number;
}

/** Donchian Channels — highest high and lowest low over N periods. */
export function calculateDonchianChannels(
  data: OHLCVBar[],
  period: number = 20,
): DonchianPoint[] {
  if (!data || data.length < period) return [];
  const result: DonchianPoint[] = [];

  for (let i = period - 1; i < data.length; i++) {
    let upper = -Infinity;
    let lower = Infinity;
    for (let j = 0; j < period; j++) {
      if (data[i - j].high > upper) upper = data[i - j].high;
      if (data[i - j].low  < lower) lower = data[i - j].low;
    }
    result.push({ time: data[i].time, upper, middle: (upper + lower) / 2, lower });
  }
  return result;
}
