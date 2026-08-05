import type { OHLCVBar } from './types';
import { calculateEMA } from './ema';
import { calculateATR } from './atr';

export interface KeltnerPoint {
  time: number | string;
  upper: number;
  middle: number;
  lower: number;
}

/**
 * Keltner Channels — EMA ± (multiplier × ATR).
 * @param period   EMA period (default 20)
 * @param mult     ATR multiplier (default 2)
 */
export function calculateKeltnerChannels(
  data: OHLCVBar[],
  period: number = 20,
  mult: number = 2,
): KeltnerPoint[] {
  if (!data || data.length < period + 1) return [];

  const emaData = calculateEMA(data, period);
  const atrData = calculateATR(data, period);

  // Align: both start at different offsets. EMA starts at period-1, ATR at period.
  // Use whichever is shorter, walking from the end.
  const len = Math.min(emaData.length, atrData.length);
  const result: KeltnerPoint[] = [];

  for (let i = 0; i < len; i++) {
    const emaVal = emaData[emaData.length - len + i].value;
    const atrVal = atrData[atrData.length - len + i].value;
    const time  = emaData[emaData.length - len + i].time;
    result.push({
      time,
      upper:  emaVal + mult * atrVal,
      middle: emaVal,
      lower:  emaVal - mult * atrVal,
    });
  }
  return result;
}
