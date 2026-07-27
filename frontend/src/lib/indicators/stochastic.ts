/**
 * Stochastic Oscillator indicator.
 *
 * The Stochastic Oscillator measures momentum by comparing a particular closing
 * price of an asset to a range of its prices over a certain period of time.
 *
 * %K = (Current Close - Lowest Low)/(Highest High - Lowest Low) * 100
 * %D = 3-day SMA of %K
 *
 * @module stochastic
 */

import type { OHLCVBar } from './types';

export interface StochasticResult {
  time: string | number;
  k: number;
  d: number;
}

/**
 * Calculate the Stochastic Oscillator (%K and %D) for a series of OHLCV bars.
 *
 * @param data - Array of OHLCV bars in chronological order.
 * @param periodK - Lookback period for %K. Default 14.
 * @param periodD - Smoothing period for %D (SMA of %K). Default 3.
 * @returns Array of {@link StochasticResult}
 */
export function calculateStochastic(
  data: OHLCVBar[],
  periodK: number = 14,
  periodD: number = 3
): StochasticResult[] {
  if (!data || data.length === 0 || periodK < 1 || periodK > data.length) {
    return [];
  }

  const kValues: number[] = [];
  const kTimes: (string | number)[] = [];

  // Calculate %K
  for (let i = periodK - 1; i < data.length; i++) {
    // Find Highest High and Lowest Low over the periodK window
    let highestHigh = -Infinity;
    let lowestLow = Infinity;
    
    for (let j = i - periodK + 1; j <= i; j++) {
      if (data[j].high > highestHigh) highestHigh = data[j].high;
      if (data[j].low < lowestLow) lowestLow = data[j].low;
    }

    const currentClose = data[i].close;
    
    let k = 0;
    if (highestHigh - lowestLow !== 0) {
      k = ((currentClose - lowestLow) / (highestHigh - lowestLow)) * 100;
    }

    kValues.push(k);
    kTimes.push(data[i].time);
  }

  // Calculate %D (SMA of %K)
  const dValues: number[] = [];
  if (kValues.length >= periodD) {
    let windowSum = 0;
    for (let i = 0; i < periodD; i++) {
      windowSum += kValues[i];
    }
    dValues.push(windowSum / periodD);

    for (let i = periodD; i < kValues.length; i++) {
      windowSum += kValues[i] - kValues[i - periodD];
      dValues.push(windowSum / periodD);
    }
  }
  const result: StochasticResult[] = [];
  
  // %D calculation starts at index `periodD - 1` of the %K array.
  for (let i = periodD - 1; i < kValues.length; i++) {
    result.push({
      time: kTimes[i],
      k: kValues[i],
      d: dValues[i - (periodD - 1)] // dValues aligns with kValues starting at periodD-1
    });
  }

  return result;
}
