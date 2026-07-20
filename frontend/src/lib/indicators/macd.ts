/**
 * Moving Average Convergence Divergence (MACD) indicator.
 *
 * MACD is a trend-following momentum indicator consisting of:
 * - **MACD line**: EMA(fastPeriod) − EMA(slowPeriod)
 * - **Signal line**: EMA(signalPeriod) of the MACD line
 * - **Histogram**: MACD line − Signal line
 *
 * @module macd
 */

import type { OHLCVBar, MACDValue } from './types';
import { calculateEMA, calculateEMAFromValues } from './ema';

/** Default fast EMA period */
const DEFAULT_FAST = 12;
/** Default slow EMA period */
const DEFAULT_SLOW = 26;
/** Default signal line EMA period */
const DEFAULT_SIGNAL = 9;

/**
 * Calculate MACD for a series of OHLCV bars.
 *
 * @param data         - Array of OHLCV bars in chronological order.
 * @param fastPeriod   - Period for the fast EMA. Defaults to 12.
 * @param slowPeriod   - Period for the slow EMA. Defaults to 26.
 * @param signalPeriod - Period for the signal line EMA. Defaults to 9.
 * @returns Array of {@link MACDValue}. Output length is determined by
 *          the slowest component: we need enough bars for the slow EMA,
 *          plus enough MACD values for the signal EMA. Returns an empty
 *          array if there is insufficient data.
 *
 * @example
 * ```ts
 * const macd = calculateMACD(bars);                // 12, 26, 9
 * const macd8 = calculateMACD(bars, 8, 17, 9);     // custom periods
 * ```
 */
export function calculateMACD(
  data: OHLCVBar[],
  fastPeriod: number = DEFAULT_FAST,
  slowPeriod: number = DEFAULT_SLOW,
  signalPeriod: number = DEFAULT_SIGNAL,
): MACDValue[] {
  if (
    !data ||
    data.length === 0 ||
    fastPeriod < 1 ||
    slowPeriod < 1 ||
    signalPeriod < 1
  ) {
    return [];
  }

  // Ensure fast < slow
  const actualFast = Math.min(fastPeriod, slowPeriod);
  const actualSlow = Math.max(fastPeriod, slowPeriod);

  // Calculate fast and slow EMAs
  const fastEMA = calculateEMA(data, actualFast);
  const slowEMA = calculateEMA(data, actualSlow);

  if (fastEMA.length === 0 || slowEMA.length === 0) {
    return [];
  }

  // Align the two EMA arrays by time.
  // The slow EMA starts later (at index slowPeriod-1 of the original data),
  // and the fast EMA starts at index fastPeriod-1.
  // The difference in start indices is (slowPeriod - fastPeriod).
  const offset = actualSlow - actualFast;

  // MACD line values: one per slow EMA point
  const macdLine: number[] = [];
  const macdTimes: string[] = [];

  for (let i = 0; i < slowEMA.length; i++) {
    const fastValue = fastEMA[i + offset].value;
    const slowValue = slowEMA[i].value;
    macdLine.push(fastValue - slowValue);
    macdTimes.push(slowEMA[i].time);
  }

  if (macdLine.length === 0) {
    return [];
  }

  // Signal line = EMA of MACD line
  const signalLine = calculateEMAFromValues(macdLine, signalPeriod);

  if (signalLine.length === 0) {
    return [];
  }

  // The signal line starts at index (signalPeriod - 1) of the macdLine array
  const signalOffset = macdLine.length - signalLine.length;

  const result: MACDValue[] = [];
  for (let i = 0; i < signalLine.length; i++) {
    const macdVal = macdLine[i + signalOffset];
    const signalVal = signalLine[i];
    result.push({
      time: macdTimes[i + signalOffset],
      macd: macdVal,
      signal: signalVal,
      histogram: macdVal - signalVal,
    });
  }

  return result;
}
