/**
 * Volume-Weighted Average Price (VWAP) indicator.
 *
 * VWAP is a cumulative indicator that resets at the start of each
 * trading day:
 *
 *   VWAP = Σ(typical_price × volume) / Σ(volume)
 *
 * where `typical_price = (high + low + close) / 3`.
 *
 * Day boundaries are detected by comparing the date portion (YYYY-MM-DD)
 * of consecutive time strings. If the time string is a pure date
 * (e.g. "2024-01-15"), each bar is treated as its own day.
 *
 * @module vwap
 */

import type { OHLCVBar, IndicatorValue } from './types';

/**
 * Extract the date portion from a time string for day-boundary detection.
 *
 * Supports:
 * - ISO-8601 date-time: "2024-01-15T09:30:00Z" → "2024-01-15"
 * - Plain date: "2024-01-15" → "2024-01-15"
 * - Unix timestamp (seconds or milliseconds): converted via `new Date()`
 *
 * @param time - The time string from an {@link OHLCVBar}.
 * @returns A "YYYY-MM-DD" string suitable for equality comparison.
 *
 * @internal
 */
function extractDate(time: string): string {
  // If it looks like a unix timestamp (all digits, possibly with a leading minus)
  if (/^-?\d+$/.test(time)) {
    const ts = Number(time);
    // Heuristic: if < 1e12, assume seconds; otherwise milliseconds
    const ms = ts < 1e12 ? ts * 1000 : ts;
    const d = new Date(ms);
    return d.toISOString().slice(0, 10);
  }

  // If it contains a 'T' or space separator, take everything before it
  const tIdx = time.indexOf('T');
  if (tIdx !== -1) {
    return time.slice(0, tIdx);
  }
  const spaceIdx = time.indexOf(' ');
  if (spaceIdx !== -1) {
    return time.slice(0, spaceIdx);
  }

  // Otherwise assume it's already a date-only string
  return time;
}

/**
 * Calculate VWAP for a series of OHLCV bars.
 *
 * The calculation resets at every detected day boundary.
 *
 * @param data - Array of OHLCV bars in chronological order.
 * @returns Array of {@link IndicatorValue} with the same length as `data`.
 *          Returns an empty array if `data` is empty.
 *
 * @example
 * ```ts
 * const vwap = calculateVWAP(intradayBars);
 * ```
 */
export function calculateVWAP(data: OHLCVBar[]): IndicatorValue[] {
  if (!data || data.length === 0) {
    return [];
  }

  const result: IndicatorValue[] = [];
  let cumulativeTPV = 0; // Σ(typical_price × volume)
  let cumulativeVolume = 0; // Σ(volume)
  let currentDate = extractDate(data[0].time);

  for (let i = 0; i < data.length; i++) {
    const bar = data[i];
    const barDate = extractDate(bar.time);

    // Reset accumulators on a new day
    if (barDate !== currentDate) {
      cumulativeTPV = 0;
      cumulativeVolume = 0;
      currentDate = barDate;
    }

    const typicalPrice = (bar.high + bar.low + bar.close) / 3;
    const vol = typeof bar.volume === 'number' && !isNaN(bar.volume) ? bar.volume : 0;
    
    cumulativeTPV += typicalPrice * vol;
    cumulativeVolume += vol;

    // If cumulativeVolume is 0 (e.g. pre-market or illiquid stock), fallback to typicalPrice instead of 0
    // to prevent the indicator line from plunging to the bottom of the chart.
    const vwap = cumulativeVolume === 0 ? typicalPrice : cumulativeTPV / cumulativeVolume;
    
    result.push({
      time: bar.time,
      value: vwap,
    });
  }

  return result;
}
