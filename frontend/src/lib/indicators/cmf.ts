import type { OHLCVBar, IndicatorValue } from './types';

/**
 * Chaikin Money Flow — measures buying/selling pressure over N periods.
 * Range: -1 to +1 (zero-line crossovers are signals).
 */
export function calculateCMF(data: OHLCVBar[], period: number = 20): IndicatorValue[] {
  if (!data || data.length < period) return [];
  const result: IndicatorValue[] = [];

  for (let i = period - 1; i < data.length; i++) {
    let sumMFV = 0;
    let sumVol = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const bar = data[j];
      const vol = typeof bar.volume === 'number' && !isNaN(bar.volume) ? bar.volume : 0;
      const hl = bar.high - bar.low;
      // Money Flow Multiplier: ((close - low) - (high - close)) / (high - low)
      const mfm = hl === 0 ? 0 : ((bar.close - bar.low) - (bar.high - bar.close)) / hl;
      sumMFV += mfm * vol;
      sumVol += vol;
    }
    result.push({ time: data[i].time, value: sumVol === 0 ? 0 : sumMFV / sumVol });
  }
  return result;
}
