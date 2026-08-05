import type { OHLCVBar, IndicatorValue } from './types';

/** On Balance Volume — cumulative volume direction indicator. */
export function calculateOBV(data: OHLCVBar[]): IndicatorValue[] {
  if (!data || data.length < 2) return [];
  const result: IndicatorValue[] = [];
  let obv = 0;

  result.push({ time: data[0].time, value: 0 });

  for (let i = 1; i < data.length; i++) {
    const vol = typeof data[i].volume === 'number' && !isNaN(data[i].volume) ? data[i].volume : 0;
    if (data[i].close > data[i - 1].close)      obv += vol;
    else if (data[i].close < data[i - 1].close) obv -= vol;
    result.push({ time: data[i].time, value: obv });
  }
  return result;
}
