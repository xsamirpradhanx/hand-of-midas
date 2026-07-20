/**
 * Exponential Moving Average (EMA) indicator.
 *
 * The EMA gives more weight to recent prices using the recursive formula:
 *
 *   EMA_today = close × k + EMA_yesterday × (1 − k)
 *
 * where `k = 2 / (period + 1)`.
 *
 * The first EMA value is seeded with the SMA of the first `period` bars.
 * Output begins at index `period - 1`.
 *
 * @module ema
 */

import type { OHLCVBar, IndicatorValue } from './types';

/**
 * Calculate the Exponential Moving Average for a series of OHLCV bars.
 *
 * @param data   - Array of OHLCV bars in chronological order.
 * @param period - Number of bars for the smoothing period. Must be ≥ 1.
 * @returns Array of {@link IndicatorValue} with `data.length - period + 1`
 *          entries, or an empty array if `data` is empty or
 *          `period > data.length`.
 *
 * @example
 * ```ts
 * const values = calculateEMA(bars, 12);
 * ```
 */
export function calculateEMA(data: OHLCVBar[], period: number): IndicatorValue[] {
  if (!data || data.length === 0 || period < 1 || period > data.length) {
    return [];
  }

  const result: IndicatorValue[] = [];
  const k = 2 / (period + 1);

  // Seed with SMA of first `period` closes
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += data[i].close;
  }
  let ema = sum / period;

  result.push({
    time: data[period - 1].time,
    value: ema,
  });

  // Recursive EMA calculation
  for (let i = period; i < data.length; i++) {
    ema = data[i].close * k + ema * (1 - k);
    result.push({
      time: data[i].time,
      value: ema,
    });
  }

  return result;
}

/**
 * Calculate EMA from an array of raw numeric values.
 *
 * This is an internal helper used by other indicators (e.g., MACD)
 * that need to compute EMA on derived series rather than raw OHLCV bars.
 *
 * @param values - Array of numeric values in chronological order.
 * @param period - Number of values for the smoothing period. Must be ≥ 1.
 * @returns Array of EMA values with `values.length - period + 1` entries,
 *          or an empty array if input is insufficient.
 *
 * @internal
 */
export function calculateEMAFromValues(values: number[], period: number): number[] {
  if (!values || values.length === 0 || period < 1 || period > values.length) {
    return [];
  }

  const result: number[] = [];
  const k = 2 / (period + 1);

  // Seed with SMA
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += values[i];
  }
  let ema = sum / period;
  result.push(ema);

  // Recursive EMA
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    result.push(ema);
  }

  return result;
}
