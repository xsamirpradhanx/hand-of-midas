import type { FactorInput, FactorResult, PredictiveFactor } from './types.js';

const LOOKBACK_BARS = 252;
export const NORMALIZED_MOMENTUM_MIN_BARS = LOOKBACK_BARS + 2;

/**
 * Normalizes daily return against proportional range, scaled by open price,
 * then z-scored over a 1-year window.
 *
 * This factor was discovered via genetic search (invent-indicators) and 
 * successfully survived the gauntlet (out-of-sample holds sign and |t| > 2 
 * on both held-out symbols and a forward era).
 * 
 * Formula: zScore252( (logReturn / (range / close)) * open )
 * 
 * The Information Coefficient (IC) is consistently negative, meaning high
 * positive values forecast downward movement, and low negative values forecast
 * upward movement.
 */
export class NormalizedMomentumFactor implements PredictiveFactor {
  readonly name = 'Normalized Momentum (Evolved)';
  readonly bucket = 'MOMENTUM' as const;

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    const { bars } = input;
    if (bars.length < NORMALIZED_MOMENTUM_MIN_BARS) return null;

    const raw = new Float64Array(bars.length);
    for (let i = 1; i < bars.length; i++) {
      const b = bars[i];
      const prev = bars[i - 1];
      if (prev.close <= 0 || b.close <= 0) {
        raw[i] = NaN;
        continue;
      }
      
      const ret = Math.log(b.close / prev.close);
      const rangeFraction = (b.high - b.low) / b.close;
      
      if (Math.abs(rangeFraction) < 1e-12) {
        raw[i] = NaN;
      } else {
        raw[i] = (ret / rangeFraction) * b.open;
      }
    }

    // Compute rolling mean and std over the last 252 bars for the final bar
    let sum = 0;
    let count = 0;
    const end = bars.length - 1;
    for (let i = end - LOOKBACK_BARS + 1; i <= end; i++) {
      if (Number.isFinite(raw[i])) {
        sum += raw[i];
        count++;
      }
    }
    
    if (count < LOOKBACK_BARS / 2) return null; // Require at least half the window
    
    const mean = sum / count;
    let sumSq = 0;
    for (let i = end - LOOKBACK_BARS + 1; i <= end; i++) {
      if (Number.isFinite(raw[i])) {
        const diff = raw[i] - mean;
        sumSq += diff * diff;
      }
    }
    const variance = count > 1 ? sumSq / (count - 1) : 0;
    const std = Math.sqrt(variance);

    if (std < 1e-12) return null;

    const currentRaw = raw[end];
    if (!Number.isFinite(currentRaw)) return null;

    const z = (currentRaw - mean) / std;

    // Based on the negative IC, high values are bearish, low values are bullish.
    // We use a threshold of 1.0 standard deviations.
    const VOTE_THRESHOLD = 1.0;
    
    const bias: FactorResult['bias'] = 
      z < -VOTE_THRESHOLD ? 'bullish' : z > VOTE_THRESHOLD ? 'bearish' : 'neutral';
      
    // Scale weight by the extremity of the z-score, capped to prevent dominance.
    const weight = bias === 'neutral' ? 0.05 : Math.min(0.35, 0.10 + (Math.abs(z) - VOTE_THRESHOLD) * 0.1);

    return {
      factorName: this.name,
      bias,
      weight: Number(weight.toFixed(3)),
      bucket: this.bucket,
      reasoning: 
        `Normalized momentum z-score is ${z.toFixed(2)}. ` +
        (bias === 'neutral'
          ? `Within ±${VOTE_THRESHOLD} threshold, indicating no strong directional skew.`
          : `Extreme ${bias === 'bullish' ? 'negative' : 'positive'} values historically forecast a ${bias === 'bullish' ? 'reversal upward' : 'reversal downward'} across the holdout set.`),
    };
  }
}
