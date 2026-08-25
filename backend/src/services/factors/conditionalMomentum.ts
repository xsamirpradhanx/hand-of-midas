import type { FactorInput, FactorResult, PredictiveFactor } from './types.js';

const LOOKBACK_BARS = 252;
const SKIP_BARS = 21;
export const COND_MOM_MIN_BARS = LOOKBACK_BARS + SKIP_BARS + 2;
const VIX_LOOKBACK = 252;

/**
 * High-VIX Conditional Momentum
 * 
 * Computes 12-month momentum (skipping the most recent month) but only casts
 * a vote when the market's implied volatility (VIX) is unusually high 
 * (z-score >= 1.0 against its trailing 252-day mean).
 * 
 * In the out-of-sample indicator lab, this candidate held a strong positive 
 * Information Coefficient (IC = 0.0748, t = 2.5). 
 */
export class ConditionalMomentumFactor implements PredictiveFactor {
  readonly name = 'High-VIX Conditional Momentum';
  readonly bucket = 'MOMENTUM' as const;
  readonly correlationGroup = 'TREND_COMPLEX';

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    const { bars, vixBars } = input;
    if (bars.length < COND_MOM_MIN_BARS) return null;
    
    // VIX bars are best-effort; abstain if missing
    if (!vixBars || vixBars.length < VIX_LOOKBACK + 1) return null;

    const end = bars.length - 1;
    const vixEnd = vixBars.length - 1;

    // 1. Calculate VIX state (z-score of log VIX)
    let sumLogVix = 0;
    let countVix = 0;
    for (let i = vixEnd - VIX_LOOKBACK; i < vixEnd; i++) {
      const v = vixBars[i].close;
      if (v > 0) {
        sumLogVix += Math.log(v);
        countVix++;
      }
    }
    
    if (countVix < VIX_LOOKBACK / 2) return null;
    
    const meanLogVix = sumLogVix / countVix;
    let sumSqVix = 0;
    for (let i = vixEnd - VIX_LOOKBACK; i < vixEnd; i++) {
      const v = vixBars[i].close;
      if (v > 0) {
        const diff = Math.log(v) - meanLogVix;
        sumSqVix += diff * diff;
      }
    }
    const stdLogVix = countVix > 1 ? Math.sqrt(sumSqVix / (countVix - 1)) : 0;
    
    if (stdLogVix < 1e-12) return null;
    
    const currentVix = vixBars[vixEnd].close;
    if (currentVix <= 0) return null;
    
    const vixZScore = (Math.log(currentVix) - meanLogVix) / stdLogVix;

    // 2. Calculate Momentum
    const skipIndex = end - SKIP_BARS;
    const startIndex = skipIndex - LOOKBACK_BARS;
    
    const b = bars[skipIndex].close;
    const a = bars[startIndex].close;
    if (a <= 0 || b <= 0) return null;
    
    const logRet = Math.log(b / a);
    const direction = logRet >= 0 ? 'rose' : 'fell';
    const pct = (Math.exp(Math.abs(logRet)) - 1) * 100;

    // 3. Conditional voting logic
    // The VIX threshold for "high volatility" state is 1.0 standard deviations
    const VIX_THRESHOLD = 1.0;
    const MOM_VOTE_THRESHOLD = 0.05; // 5% absolute move required to vote

    const bias: FactorResult['bias'] = 
      (vixZScore >= VIX_THRESHOLD && logRet > MOM_VOTE_THRESHOLD) ? 'bullish' 
      : (vixZScore >= VIX_THRESHOLD && logRet < -MOM_VOTE_THRESHOLD) ? 'bearish' 
      : 'neutral';

    // Weight is zeroed basically if neutral, otherwise scales with momentum up to 0.35
    const weight = bias === 'neutral' ? 0.05 : Math.min(0.35, 0.15 + (Math.abs(logRet) - MOM_VOTE_THRESHOLD) * 0.5);

    return {
      factorName: this.name,
      bias,
      weight: Number(weight.toFixed(3)),
      bucket: this.bucket,
      correlationGroup: this.correlationGroup,
      reasoning:
        `Market volatility is ${vixZScore >= VIX_THRESHOLD ? 'elevated' : 'normal'} (VIX z-score: ${vixZScore.toFixed(2)}). ` +
        `Over the trailing 12 months (excluding the last month), price ${direction} ${pct.toFixed(1)}%. ` +
        (bias === 'neutral'
          ? (vixZScore < VIX_THRESHOLD 
              ? `Abstaining: VIX is not in an elevated panic state.` 
              : `Momentum is too weak to assert an edge despite high VIX.`)
          : `During periods of high market panic, long-term ${bias === 'bullish' ? 'winners' : 'losers'} historically continue their trend significantly (t=2.5) as capital re-allocates.`),
    };
  }
}
