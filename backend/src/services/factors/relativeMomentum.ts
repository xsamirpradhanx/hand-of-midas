import type { FactorInput, FactorResult, PredictiveFactor } from './types.js';
import type { OHLCVDataPoint } from '../../types.js';

/**
 * Twelve-month momentum, measured against the benchmark.
 *
 * WHY THIS ONE. Across 76 candidate indicators scored over 2.2M daily bars in a
 * symbol x era grid, this is the only construction that keeps its sign in every
 * cell — both symbol splits, all three eras — with a market-beta loading near
 * zero. Everything else either decayed after 2012 (short-horizon reversal, at
 * t=7.4 before and t=0.4 after), or turned out to be a disguised market bet
 * (ranking by beta, loading -0.55), or never worked.
 *
 * WHY RELATIVE, AND NOT PLAIN MOMENTUM. Momentum is a CROSS-SECTIONAL level: it
 * says this name is a winner compared with other names. A `PredictiveFactor` is
 * handed one symbol, so it cannot see other names. The obvious substitute —
 * z-scoring the symbol's momentum against its own history — was measured and
 * destroys the effect outright, dropping a t of +3.7 to sign-flipping noise,
 * because "unusually strong for itself" is a different question with a different
 * answer.
 *
 * Subtracting the benchmark's move over the same window is the one relative
 * construction a single-symbol factor can compute, and it keeps the information:
 * ranks within a date are unchanged (every name subtracts the same term, so the
 * cross-sectional IC is identical to plain momentum), while the SIGN becomes far
 * better calibrated, because positive now means "beat the market" rather than
 * "went up". Out of sample on held-out symbols in the most recent era, its
 * drift-adjusted directional accuracy is 53.2% against plain momentum's 50.7%.
 *
 * HONEST SIZE. The effect is small and not individually significant in any one
 * cell — |t| runs 0.8 to 2.3 per cell, ~2.1 pooled with Newey-West errors at the
 * horizon lag, and a block bootstrap keeps its sign in 97.8% of resamples. What
 * earns it a place is consistency across every split, not the strength of any
 * single number. Do not present it as a win probability.
 *
 * SKIP MONTH. The last 21 bars are excluded from the lookback. The two horizons
 * carry opposite signs — the last month reverses while the year before it
 * continues — so a lookback spanning both measures their sum and reads weaker
 * than either.
 */

/** Trading days in the lookback, and the recent window excluded from it. */
const LOOKBACK_BARS = 252;
const SKIP_BARS = 21;

/**
 * Bars needed before the factor will speak.
 *
 * Note this exceeds the 126 the live engine used to fetch — the fetch was raised
 * for this factor. A factor that silently never fires is worse than one that
 * abstains loudly, so this returns null rather than shortening its own window.
 */
export const RELATIVE_MOMENTUM_MIN_BARS = LOOKBACK_BARS + SKIP_BARS + 1;

/**
 * Vote threshold, in log-return terms.
 *
 * 5% of relative move over a year. Below that the estimate is dominated by the
 * noise in two long return series and the direction is not worth asserting;
 * measured on the research panel this leaves the factor voting on roughly
 * two-thirds of bars, which matches how often a year of relative performance is
 * actually decisive.
 */
const VOTE_THRESHOLD = 0.05;

/** Log return between two closes `bars.length - 1 - offset` apart. */
function windowReturn(bars: readonly OHLCVDataPoint[], lookback: number, skip: number): number | null {
  const end = bars.length - 1 - skip;
  const start = end - lookback;
  if (start < 0) return null;
  const a = bars[start]?.close, b = bars[end]?.close;
  if (!(a > 0) || !(b > 0)) return null;
  return Math.log(b / a);
}

export class RelativeMomentumFactor implements PredictiveFactor {
  readonly name = 'Relative Momentum (12-1 vs Benchmark)';
  readonly bucket = 'MOMENTUM' as const;
  /**
   * Grouped with the other trend reads so IndependentEvidenceEngine does not
   * count this and a KAMA trend call as two independent pieces of evidence for
   * the same thing.
   */
  readonly correlationGroup = 'TREND_COMPLEX';

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    const { bars, benchmarkBars } = input;
    // Best-effort input, like intradayBars and sentiment: abstain rather than
    // degrade into a plain-momentum read, which measured as noise.
    if (!benchmarkBars || bars.length < RELATIVE_MOMENTUM_MIN_BARS || benchmarkBars.length < RELATIVE_MOMENTUM_MIN_BARS) {
      return null;
    }

    const own = windowReturn(bars, LOOKBACK_BARS, SKIP_BARS);
    const bench = windowReturn(benchmarkBars, LOOKBACK_BARS, SKIP_BARS);
    if (own === null || bench === null) return null;

    const relative = own - bench;
    const pct = (Math.exp(relative) - 1) * 100;

    const bias: FactorResult['bias'] =
      relative > VOTE_THRESHOLD ? 'bullish' : relative < -VOTE_THRESHOLD ? 'bearish' : 'neutral';

    /**
     * Weight rises with the size of the relative move and saturates.
     *
     * Capped low on purpose. The measured edge is a fraction of a percentage
     * point of directional accuracy, and a weight that let one factor dominate
     * the composite would be asserting far more than the evidence supports.
     */
    const weight = bias === 'neutral' ? 0.05 : Math.min(0.32, 0.12 + Math.abs(relative) * 0.6);

    const direction = relative >= 0 ? 'outperformed' : 'underperformed';
    return {
      factorName: this.name,
      bias,
      weight: Number(weight.toFixed(3)),
      bucket: this.bucket,
      correlationGroup: this.correlationGroup,
      reasoning:
        `Over the trailing 12 months excluding the last month, ${input.symbol} ${direction} the ` +
        `benchmark by ${Math.abs(pct).toFixed(1)}%. ` +
        (bias === 'neutral'
          ? 'Too close to call — no directional vote.'
          : `Relative strength of this size has continued over the next 20 sessions slightly more ` +
            `often than not (53.2% out-of-sample, drift-adjusted). A small edge, not a forecast.`),
    };
  }
}
