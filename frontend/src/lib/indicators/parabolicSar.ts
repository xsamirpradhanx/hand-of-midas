import type { OHLCVBar, IndicatorValue } from './types';

/**
 * Parabolic SAR — trend-following stop-and-reverse indicator.
 * @param step   Acceleration Factor step (default 0.02)
 * @param max    Maximum Acceleration Factor (default 0.2)
 */
export function calculateParabolicSAR(
  data: OHLCVBar[],
  step: number = 0.02,
  max: number = 0.2,
): IndicatorValue[] {
  if (!data || data.length < 2) return [];

  const result: IndicatorValue[] = [];
  let isUpTrend = true;
  let af = step;
  let ep = data[0].high; // extreme point
  let sar = data[0].low;

  for (let i = 1; i < data.length; i++) {
    const bar = data[i];
    const prevSar = sar;

    if (isUpTrend) {
      sar = prevSar + af * (ep - prevSar);
      // SAR must not be above the two prior lows
      sar = Math.min(sar, data[i - 1].low, i >= 2 ? data[i - 2].low : data[i - 1].low);

      if (bar.low < sar) {
        // Switch to downtrend
        isUpTrend = false;
        sar = ep;
        ep = bar.low;
        af = step;
      } else {
        if (bar.high > ep) {
          ep = bar.high;
          af = Math.min(af + step, max);
        }
      }
    } else {
      sar = prevSar + af * (ep - prevSar);
      // SAR must not be below the two prior highs
      sar = Math.max(sar, data[i - 1].high, i >= 2 ? data[i - 2].high : data[i - 1].high);

      if (bar.high > sar) {
        // Switch to uptrend
        isUpTrend = true;
        sar = ep;
        ep = bar.high;
        af = step;
      } else {
        if (bar.low < ep) {
          ep = bar.low;
          af = Math.min(af + step, max);
        }
      }
    }

    result.push({ time: bar.time, value: sar });
  }

  return result;
}
