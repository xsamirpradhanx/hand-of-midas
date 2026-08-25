import type { FactorInput, FactorResult, PredictiveFactor } from './types.js';

const LOOKBACK_BARS = 252;
const SKIP_BARS = 21;
export const RMOM_MIN_BARS = LOOKBACK_BARS + SKIP_BARS + 2;

/**
 * Risk-Adjusted Momentum (12-1 month)
 * 
 * Computes 12-month momentum (skipping the most recent month) divided by the 
 * volatility it was earned through over the same 12-month window.
 * 
 * Formula: log(close[t-21] / close[t-21-252]) / (stdDev(returns, 252) * sqrt(252))
 * 
 * In the out-of-sample indicator lab, this candidate held a strong positive 
 * Information Coefficient (IC = 0.0449, t = 2.3).
 */
export class RiskAdjustedMomentumFactor implements PredictiveFactor {
  readonly name = 'Risk-Adjusted Momentum (12-1)';
  readonly bucket = 'MOMENTUM' as const;
  readonly correlationGroup = 'TREND_COMPLEX';

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    const { bars } = input;
    if (bars.length < RMOM_MIN_BARS) return null;

    const end = bars.length - 1;
    const skipIndex = end - SKIP_BARS;
    const startIndex = skipIndex - LOOKBACK_BARS;

    const b = bars[skipIndex].close;
    const a = bars[startIndex].close;
    if (a <= 0 || b <= 0) return null;

    // Calculate standard deviation of returns over the lookback window
    let sumRet = 0;
    let countRet = 0;
    for (let i = startIndex + 1; i <= skipIndex; i++) {
      const prev = bars[i - 1].close;
      const curr = bars[i].close;
      if (prev > 0 && curr > 0) {
        sumRet += Math.log(curr / prev);
        countRet++;
      }
    }
    
    if (countRet < LOOKBACK_BARS / 2) return null;
    
    const meanRet = sumRet / countRet;
    let sumSqRet = 0;
    for (let i = startIndex + 1; i <= skipIndex; i++) {
      const prev = bars[i - 1].close;
      const curr = bars[i].close;
      if (prev > 0 && curr > 0) {
        const diff = Math.log(curr / prev) - meanRet;
        sumSqRet += diff * diff;
      }
    }
    const stdRet = countRet > 1 ? Math.sqrt(sumSqRet / (countRet - 1)) : 0;
    
    if (stdRet < 1e-12) return null;

    const logRet = Math.log(b / a);
    const annualizedVol = stdRet * Math.sqrt(LOOKBACK_BARS);
    
    const rmom = logRet / annualizedVol;

    // IC is positive, so positive values are bullish.
    const VOTE_THRESHOLD = 0.15; // Requires at least a 0.15 Sharpe-like drift to vote

    const bias: FactorResult['bias'] = 
      rmom > VOTE_THRESHOLD ? 'bullish' : rmom < -VOTE_THRESHOLD ? 'bearish' : 'neutral';

    // Weight caps out at 0.35 for an exceptionally strong, clean trend.
    const weight = bias === 'neutral' ? 0.05 : Math.min(0.35, 0.10 + (Math.abs(rmom) - VOTE_THRESHOLD) * 0.2);
    
    const direction = logRet >= 0 ? 'rose' : 'fell';
    const pct = (Math.exp(Math.abs(logRet)) - 1) * 100;

    return {
      factorName: this.name,
      bias,
      weight: Number(weight.toFixed(3)),
      bucket: this.bucket,
      correlationGroup: this.correlationGroup,
      reasoning:
        `Over the trailing 12 months (excluding the last month), price ${direction} ${pct.toFixed(1)}%. ` +
        `Adjusted for volatility, the trend quality score is ${rmom.toFixed(2)}. ` +
        (bias === 'neutral'
          ? `Trend is too choppy or flat to constitute an edge.`
          : `Clean ${bias === 'bullish' ? 'upward' : 'downward'} trends historically persist at a statistically significant rate.`),
    };
  }
}
