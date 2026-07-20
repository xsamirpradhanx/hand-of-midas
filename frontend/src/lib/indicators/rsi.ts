/**
 * Relative Strength Index (RSI) indicator.
 *
 * Uses Wilder's smoothing method (exponential moving average with
 * a smoothing factor of `1/period`), which differs from a simple SMA.
 *
 * Algorithm:
 * 1. Calculate price changes between consecutive closes.
 * 2. Separate into gains (positive changes) and losses (absolute
 *    value of negative changes).
 * 3. Seed the first average gain/loss as the SMA of the first
 *    `period` changes.
 * 4. Subsequent averages use Wilder's smoothing:
 *    `avg = (prevAvg × (period - 1) + current) / period`
 * 5. RS = avgGain / avgLoss
 * 6. RSI = 100 − (100 / (1 + RS))
 *
 * Special case: if avgLoss is 0, RSI = 100 (no downward movement).
 *
 * @module rsi
 */

import type { OHLCVBar, IndicatorValue } from './types';

/** Default RSI look-back period */
const DEFAULT_PERIOD = 14;

/**
 * Calculate the Relative Strength Index for a series of OHLCV bars.
 *
 * @param data   - Array of OHLCV bars in chronological order.
 * @param period - RSI look-back period. Defaults to 14.
 * @returns Array of {@link IndicatorValue}. The output starts at index
 *          `period` (we need `period` price changes, which requires
 *          `period + 1` bars). Returns an empty array if there is
 *          insufficient data.
 *
 * @example
 * ```ts
 * const rsi = calculateRSI(bars);        // period = 14
 * const rsi7 = calculateRSI(bars, 7);    // period = 7
 * ```
 */
export function calculateRSI(
  data: OHLCVBar[],
  period: number = DEFAULT_PERIOD,
): IndicatorValue[] {
  // We need at least period + 1 bars to compute 1 RSI value
  if (!data || data.length === 0 || period < 1 || data.length < period + 1) {
    return [];
  }

  const result: IndicatorValue[] = [];

  // Step 1: Calculate price changes
  const changes: number[] = [];
  for (let i = 1; i < data.length; i++) {
    changes.push(data[i].close - data[i - 1].close);
  }

  // Step 2: Separate gains and losses
  const gains: number[] = changes.map((c) => (c > 0 ? c : 0));
  const losses: number[] = changes.map((c) => (c < 0 ? -c : 0));

  // Step 3: First average gain/loss = SMA of first `period` changes
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    avgGain += gains[i];
    avgLoss += losses[i];
  }
  avgGain /= period;
  avgLoss /= period;

  // First RSI value
  const firstRS = avgLoss === 0 ? Infinity : avgGain / avgLoss;
  const firstRSI = avgLoss === 0 ? 100 : 100 - 100 / (1 + firstRS);
  result.push({
    time: data[period].time,
    value: firstRSI,
  });

  // Step 4-6: Subsequent values using Wilder's smoothing
  for (let i = period; i < changes.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;

    let rsi: number;
    if (avgLoss === 0) {
      rsi = 100;
    } else {
      const rs = avgGain / avgLoss;
      rsi = 100 - 100 / (1 + rs);
    }

    result.push({
      time: data[i + 1].time,
      value: rsi,
    });
  }

  return result;
}
