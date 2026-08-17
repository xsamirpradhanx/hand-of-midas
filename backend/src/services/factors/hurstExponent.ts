import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';

/**
 * Trend-persistence regime classification.
 *
 * WHY NOT HURST/R-S ANYMORE: this factor previously classified regime from a
 * single-window rescaled-range (R/S) Hurst estimate, which does not work on ~125
 * daily bars. Measured against synthetic series it fails in the one direction the
 * engine actually depends on:
 *
 *   relentless uptrend  -> H = 0.53   (should be ~1.0)
 *   pure random walk    -> H = 0.58   (should be ~0.5)
 *   perfect alternation -> H = 0.09   (correct)
 *
 * A random walk scored HIGHER than a strong trend, and both landed under the 0.55
 * "trending" threshold — so `detectRegime` in compositeScore.ts could never return
 * 'trending', leaving the entire REGIME_MULTIPLIERS.trending branch dead. The cause
 * is structural, not a tuning issue: R/S subtracts the window mean, which removes
 * constant drift, so pure trend registers as no signal. A proper multi-window R/S
 * regression barely helps (uptrend 0.62 vs random walk 0.56 — not separable).
 *
 * Kaufman's Efficiency Ratio separates them cleanly on the same series:
 *
 *   ER = |net displacement| / sum(|bar-to-bar moves|)
 *   relentless uptrend 1.00 | random walk 0.14 | perfect alternation 0.00
 *
 * ER is what regime is now classified from. The R/S value is still computed and
 * reported as secondary colour, clearly labelled, since it does carry information
 * about mean-reversion (its one reliable end).
 */
export class HurstExponentFactor implements PredictiveFactor {
  name = 'Trend Persistence (Regime Classification)';
  bucket = 'POSITIONING' as const;
  correlationGroup = 'REGIME';

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    const { bars, currentPrice } = input;
    if (!bars || bars.length < 30) return null;

    const prices = bars.map(b => b.close);
    const returns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      returns.push(Math.log(prices[i] / prices[i - 1]));
    }

    const n = returns.length;
    if (n < 20) return null;

    // ── Efficiency Ratio: the regime signal ────────────────────────────────
    // Net distance travelled over the window divided by the total path walked.
    // 1.0 = every bar moved the same way; ~0 = the path cancelled itself out.
    const netMove = Math.abs(prices[prices.length - 1] - prices[0]);
    let grossMove = 0;
    for (let i = 1; i < prices.length; i++) {
      grossMove += Math.abs(prices[i] - prices[i - 1]);
    }
    if (grossMove === 0) return null;
    const efficiencyRatio = netMove / grossMove;

    // ── Rescaled range: reported, not used for classification ──────────────
    const mean = returns.reduce((a, b) => a + b, 0) / n;
    let cumDev = 0;
    let maxDev = -Infinity;
    let minDev = Infinity;
    let sqDiffSum = 0;

    for (const r of returns) {
      const dev = r - mean;
      cumDev += dev;
      sqDiffSum += dev * dev;
      if (cumDev > maxDev) maxDev = cumDev;
      if (cumDev < minDev) minDev = cumDev;
    }

    const range = maxDev - minDev;
    const stdDev = Math.sqrt(sqDiffSum / n);
    const rescaledRange = stdDev > 0 && range > 0
      ? Math.max(0, Math.min(1, Math.log(range / stdDev) / Math.log(n)))
      : null;

    // Thresholds calibrated against the synthetic series above: real equities rarely
    // exceed ~0.35 ER over a 6-month window, and sustained chop sits under ~0.10.
    const isTrending = efficiencyRatio > 0.30;
    const isChoppy = efficiencyRatio < 0.10;

    const direction = prices[prices.length - 1] > prices[0] ? 'bullish' : 'bearish';
    const bias: 'bullish' | 'bearish' | 'neutral' = isTrending ? direction : 'neutral';

    const regimeLabel = isTrending
      ? `Trending / Persistent — ${direction === 'bullish' ? 'up' : 'down'}-trend continuation favoured`
      : isChoppy
        ? 'Choppy / Mean-Reverting — path cancels itself out, continuation setups have no edge'
        : 'Mixed / Weak Trend — no decisive regime';

    const rsNote = rescaledRange === null
      ? ''
      : ` (R/S rescaled range ${rescaledRange.toFixed(2)} — reported for reference only; it cannot detect drift.)`;

    return {
      factorName: this.name,
      // Only a decisive trend implies anything about location; a choppy or mixed
      // tape has no view on where support and resistance sit.
      buyTarget: isTrending && bias === 'bullish' ? currentPrice * 0.99 : undefined,
      sellTarget: isTrending && bias === 'bearish' ? currentPrice * 1.01 : undefined,
      bias,
      weight: 0.20,
      bucket: 'POSITIONING',
      correlationGroup: 'REGIME',
      reasoning: `Efficiency Ratio = ${efficiencyRatio.toFixed(2)} over ${prices.length} bars (net move is ${(efficiencyRatio * 100).toFixed(0)}% of the total distance travelled). ${regimeLabel}.${rsNote}`,
    };
  }
}
