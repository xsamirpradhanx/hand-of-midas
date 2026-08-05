import type { OHLCVBar, IndicatorValue } from './types';

/**
 * Money Flow Index — volume-weighted RSI.
 * Range: 0 to 100. Overbought ≥ 80, Oversold ≤ 20.
 */
export function calculateMFI(data: OHLCVBar[], period: number = 14): IndicatorValue[] {
  if (!data || data.length < period + 1) return [];
  const result: IndicatorValue[] = [];

  // Typical price and raw money flow for each bar
  const tp: number[]  = data.map(d => (d.high + d.low + d.close) / 3);
  const rmf: number[] = data.map((d, i) => {
    const vol = typeof d.volume === 'number' && !isNaN(d.volume) ? d.volume : 0;
    return tp[i] * vol;
  });

  for (let i = period; i < data.length; i++) {
    let posMF = 0, negMF = 0;
    for (let j = i - period + 1; j <= i; j++) {
      if (tp[j] > tp[j - 1])      posMF += rmf[j];
      else if (tp[j] < tp[j - 1]) negMF += rmf[j];
    }
    const mfi = negMF === 0 ? 100 : 100 - (100 / (1 + posMF / negMF));
    result.push({ time: data[i].time, value: mfi });
  }
  return result;
}
