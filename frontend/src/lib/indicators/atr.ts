/**
 * Average True Range (ATR) indicator.
 *
 * ATR measures market volatility by decomposing the entire range of an asset price for that period.
 *
 * True Range (TR) is the greatest of the following:
 * 1. Current High minus Current Low
 * 2. Absolute value of Current High minus Previous Close
 * 3. Absolute value of Current Low minus Previous Close
 *
 * ATR is typically smoothed using Wilder's Smoothing Method (RMA).
 *
 * @module atr
 */

import type { OHLCVBar, IndicatorValue } from './types';

/**
 * Calculate the Average True Range (ATR) for a series of OHLCV bars.
 *
 * @param data - Array of OHLCV bars in chronological order.
 * @param period - Number of bars for the smoothing period. Must be ≥ 1. Default is 14.
 * @returns Array of {@link IndicatorValue} with `data.length` entries, padded with empty logic or calculated from the start.
 *          Output begins after the first bar (which lacks a previous close for full TR).
 *          Values before index `period` will be NaN or unshifted. We'll start output at index `period`.
 */
export function calculateATR(data: OHLCVBar[], period: number = 14): IndicatorValue[] {
  if (!data || data.length === 0 || period < 1 || period > data.length) {
    return [];
  }

  const result: IndicatorValue[] = [];
  const trValues: number[] = [];

  // Calculate True Range (TR) for each bar.
  // The first bar has no previous close, so its TR is just High - Low.
  for (let i = 0; i < data.length; i++) {
    const currentHigh = data[i].high;
    const currentLow = data[i].low;

    let tr = currentHigh - currentLow;

    if (i > 0) {
      const prevClose = data[i - 1].close;
      const hl = currentHigh - currentLow;
      const hpc = Math.abs(currentHigh - prevClose);
      const lpc = Math.abs(currentLow - prevClose);
      tr = Math.max(hl, hpc, lpc);
    }

    trValues.push(tr);
  }

  // Smooth TR using Wilder's Moving Average (RMA)
  // The first RMA value is a simple average of the first `period` TR values.
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += trValues[i];
  }
  let atr = sum / period;

  result.push({
    time: data[period - 1].time,
    value: atr,
  });

  // Recursive RMA
  for (let i = period; i < data.length; i++) {
    atr = (atr * (period - 1) + trValues[i]) / period;
    result.push({
      time: data[i].time,
      value: atr,
    });
  }

  return result;
}
