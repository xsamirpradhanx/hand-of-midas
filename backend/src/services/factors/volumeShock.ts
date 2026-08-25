import type { FactorInput, FactorResult, PredictiveFactor } from './types.js';
import type { OHLCVDataPoint } from '../../types.js';

const LOOKBACK_BARS = 21;
export const VOLUME_SHOCK_MIN_BARS = LOOKBACK_BARS + 2;

/**
 * Volume Shock (21-day)
 * 
 * Computes today's volume against its own 21-day trailing norm (z-score of log volume),
 * then scales it by the z-scored log return of the day.
 *
 * Formula: zScore21(log(volume)) * (logReturn / stdDev21(logReturn))
 *
 * In the out-of-sample indicator lab, this candidate held a consistent negative 
 * Information Coefficient (IC = -0.0137, t = -3.2). 
 * This means a massive volume spike on an up day (high positive shock) forecasts 
 * a downward reversal, and a massive volume spike on a down day (highly negative shock)
 * forecasts an upward reversal.
 */
export class VolumeShockFactor implements PredictiveFactor {
  readonly name = 'Volume Shock (21-day)';
  readonly bucket = 'ORDER_FLOW' as const;

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    const { bars } = input;
    if (bars.length < VOLUME_SHOCK_MIN_BARS) return null;

    const n = bars.length;
    const end = n - 1;

    // Calculate rolling volume z-score
    let sumLogVol = 0;
    let countVol = 0;
    for (let i = end - LOOKBACK_BARS; i < end; i++) {
      const v = bars[i].volume;
      if (v > 0) {
        sumLogVol += Math.log(v);
        countVol++;
      }
    }
    
    if (countVol < LOOKBACK_BARS / 2 || bars[end].volume <= 0) return null;
    
    const meanLogVol = sumLogVol / countVol;
    let sumSqVol = 0;
    for (let i = end - LOOKBACK_BARS; i < end; i++) {
      const v = bars[i].volume;
      if (v > 0) {
        const diff = Math.log(v) - meanLogVol;
        sumSqVol += diff * diff;
      }
    }
    const stdLogVol = countVol > 1 ? Math.sqrt(sumSqVol / (countVol - 1)) : 0;
    
    if (stdLogVol < 1e-12) return null;
    
    const currentLogVol = Math.log(bars[end].volume);
    const volZScore = (currentLogVol - meanLogVol) / stdLogVol;

    // Calculate rolling return stddev
    let sumRet = 0;
    let countRet = 0;
    for (let i = end - LOOKBACK_BARS; i < end; i++) {
      const prev = bars[i - 1];
      const curr = bars[i];
      if (prev && prev.close > 0 && curr.close > 0) {
        sumRet += Math.log(curr.close / prev.close);
        countRet++;
      }
    }
    
    if (countRet < LOOKBACK_BARS / 2) return null;
    
    const meanRet = sumRet / countRet;
    let sumSqRet = 0;
    for (let i = end - LOOKBACK_BARS; i < end; i++) {
      const prev = bars[i - 1];
      const curr = bars[i];
      if (prev && prev.close > 0 && curr.close > 0) {
        const diff = Math.log(curr.close / prev.close) - meanRet;
        sumSqRet += diff * diff;
      }
    }
    const stdRet = countRet > 1 ? Math.sqrt(sumSqRet / (countRet - 1)) : 0;
    
    if (stdRet < 1e-12) return null;

    const prevEnd = bars[end - 1];
    if (!prevEnd || prevEnd.close <= 0 || bars[end].close <= 0) return null;
    const currentRet = Math.log(bars[end].close / prevEnd.close);
    
    const retScaled = currentRet / stdRet;
    const volShock = volZScore * retScaled;

    // The threshold for voting is a volShock magnitude of 2.0.
    // e.g., Volume is 1.5 standard deviations high AND return is 1.5 standard deviations.
    // Since IC is negative, high positive values are bearish (reversal), low negative values are bullish (reversal).
    const VOTE_THRESHOLD = 2.0;

    const bias: FactorResult['bias'] = 
      volShock < -VOTE_THRESHOLD ? 'bullish' : volShock > VOTE_THRESHOLD ? 'bearish' : 'neutral';

    // Weight scales with the extremity of the shock, capped at 0.3
    const weight = bias === 'neutral' ? 0.05 : Math.min(0.3, 0.10 + (Math.abs(volShock) - VOTE_THRESHOLD) * 0.05);

    return {
      factorName: this.name,
      bias,
      weight: Number(weight.toFixed(3)),
      bucket: this.bucket,
      reasoning:
        `Volume shock magnitude is ${volShock.toFixed(2)} (volume z-score: ${volZScore.toFixed(2)}, normalized return: ${retScaled.toFixed(2)}). ` +
        (bias === 'neutral'
          ? `Within ±${VOTE_THRESHOLD} threshold, indicating no extreme volume-accompanied move.`
          : `A strong ${bias === 'bullish' ? 'downward' : 'upward'} price move on unusually high volume historically points to a ${bias === 'bullish' ? 'reversal upward' : 'reversal downward'} over the next 20 bars.`),
    };
  }
}
