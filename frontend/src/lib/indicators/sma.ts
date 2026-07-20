/**
 * Simple Moving Average (SMA) indicator.
 *
 * Computes the arithmetic mean of closing prices over a sliding window
 * of the specified period. Output begins at index `period - 1` so that
 * every returned value is computed from a full window (no NaN values).
 *
 * @module sma
 */

import type { OHLCVBar, IndicatorValue } from './types';

/**
 * Calculate the Simple Moving Average for a series of OHLCV bars.
 *
 * Uses an efficient sliding-window approach: the first SMA is computed
 * by summing the first `period` closes, and each subsequent value is
 * derived by adding the new close and subtracting the oldest close from
 * the running sum.
 *
 * @param data  - Array of OHLCV bars in chronological order.
 * @param period - Number of bars in the averaging window. Must be ≥ 1.
 * @returns Array of {@link IndicatorValue} with `data.length - period + 1`
 *          entries, or an empty array if `data` is empty or
 *          `period > data.length`.
 *
 * @example
 * ```ts
 * const values = calculateSMA(bars, 20);
 * // values[0].time === bars[19].time
 * ```
 */
export function calculateSMA(data: OHLCVBar[], period: number): IndicatorValue[] {
  if (!data || data.length === 0 || period < 1 || period > data.length) {
    return [];
  }

  const result: IndicatorValue[] = [];

  // Compute the initial window sum
  let windowSum = 0;
  for (let i = 0; i < period; i++) {
    windowSum += data[i].close;
  }
  result.push({
    time: data[period - 1].time,
    value: windowSum / period,
  });

  // Slide the window forward
  for (let i = period; i < data.length; i++) {
    windowSum += data[i].close - data[i - period].close;
    result.push({
      time: data[i].time,
      value: windowSum / period,
    });
  }

  return result;
}
