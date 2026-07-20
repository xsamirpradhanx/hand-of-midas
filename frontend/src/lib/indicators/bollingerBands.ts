/**
 * Bollinger Bands indicator.
 *
 * Bollinger Bands consist of three lines:
 * - **Middle band**: SMA of closing prices over the specified period.
 * - **Upper band**: Middle + multiplier × σ (population standard deviation).
 * - **Lower band**: Middle − multiplier × σ.
 *
 * The bands widen during volatile periods and contract during calm periods.
 *
 * @module bollingerBands
 */

import type { OHLCVBar, BollingerBandValue } from './types';
import { calculateSMA } from './sma';

/** Default look-back period */
const DEFAULT_PERIOD = 20;
/** Default standard deviation multiplier */
const DEFAULT_STD_DEV = 2;

/**
 * Calculate Bollinger Bands for a series of OHLCV bars.
 *
 * @param data    - Array of OHLCV bars in chronological order.
 * @param period  - SMA period / look-back window. Defaults to 20.
 * @param stdDev  - Standard deviation multiplier. Defaults to 2.
 * @returns Array of {@link BollingerBandValue} starting at index
 *          `period - 1`. Returns an empty array if there is
 *          insufficient data.
 *
 * @example
 * ```ts
 * const bands = calculateBollingerBands(bars);          // 20, 2
 * const bands10 = calculateBollingerBands(bars, 10, 1); // custom
 * ```
 */
export function calculateBollingerBands(
  data: OHLCVBar[],
  period: number = DEFAULT_PERIOD,
  stdDev: number = DEFAULT_STD_DEV,
): BollingerBandValue[] {
  if (!data || data.length === 0 || period < 1 || period > data.length) {
    return [];
  }

  // Get the SMA (middle band) values
  const smaValues = calculateSMA(data, period);

  const result: BollingerBandValue[] = [];

  for (let i = 0; i < smaValues.length; i++) {
    const smaIdx = i + period - 1; // Index into the original data array
    const middle = smaValues[i].value;

    // Calculate population standard deviation for the window
    let sumSquaredDiff = 0;
    for (let j = smaIdx - period + 1; j <= smaIdx; j++) {
      const diff = data[j].close - middle;
      sumSquaredDiff += diff * diff;
    }
    const sigma = Math.sqrt(sumSquaredDiff / period);

    result.push({
      time: smaValues[i].time,
      upper: middle + stdDev * sigma,
      middle,
      lower: middle - stdDev * sigma,
    });
  }

  return result;
}
