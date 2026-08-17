import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';

export class KamaZScoreFactor implements PredictiveFactor {
  name = 'KAMA & Z-Score Distance';
  bucket = 'PRICE_STRUCTURE' as const;
  correlationGroup = 'MEAN_REVERSION';

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    const { bars, currentPrice } = input;
    const period = 20;
    // Needs period+1 closes: prices[n-period-1] (the KAMA seed) must be in bounds.
    // Was `bars.length < 20`, which let n=20 through and read prices[-1] (undefined),
    // silently producing NaN for KAMA/z-score on the minimum-length input.
    if (!bars || bars.length < period + 1) return null;

    const prices = bars.map(b => b.close);
    const n = prices.length;

    // KAMA Efficiency Ratio (ER)
    const change = Math.abs(prices[n - 1] - prices[n - 1 - period]);
    let volatilitySum = 0;
    for (let i = n - period; i < n; i++) {
      volatilitySum += Math.abs(prices[i] - prices[i - 1]);
    }

    const er = volatilitySum > 0 ? change / volatilitySum : 0;
    const fastSC = 2 / (2 + 1);
    const slowSC = 2 / (30 + 1);
    const sc = Math.pow(er * (fastSC - slowSC) + slowSC, 2);

    let kama = prices[n - period - 1];
    for (let i = n - period; i < n; i++) {
      kama = kama + sc * (prices[i] - kama);
    }

    // 20-period Standard Deviation
    const slice = prices.slice(-period);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / period;
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) return null;

    const zScore = (currentPrice - kama) / stdDev;
    // ±2.0σ is the standard statistical threshold for meaningful mean-reversion extremes.
    // Previously ±1.8σ fired too frequently (top/bottom 7.2% of observations vs 4.6% at ±2σ).
    const isOversold = zScore < -2.0;
    const isOverbought = zScore > 2.0;

    const bias = isOversold ? 'bullish' : isOverbought ? 'bearish' : 'neutral';

    // This factor measures *how stretched* price is from its adaptive mean — it has
    // no opinion on where support or resistance sits. It previously emitted
    // currentPrice * 0.98 / 1.02, a fabricated ±2% band that carried no information
    // yet still fed compositeScore's zone clustering. Because this factor is in the
    // PRICE_STRUCTURE bucket it passes the isPriceLocation gate, so on volatile
    // symbols that invented band was one of the few "levels" close enough to survive
    // MAX_ZONE_DISTANCE — crowding out the genuine structure it sat in front of.
    // Bias and weight still count as evidence; price levels are left to factors that
    // actually derive them. (KAMA itself is a real adaptive-mean level and could be
    // re-introduced as one deliberately — but as a computed level, not a spot offset.)

    return {
      factorName: this.name,
      bias,
      weight: 0.20,
      bucket: 'PRICE_STRUCTURE',
      correlationGroup: 'MEAN_REVERSION',
      reasoning: `KAMA Z-Score Distance is ${zScore >= 0 ? '+' : ''}${zScore.toFixed(2)}σ (KAMA at $${kama.toFixed(2)}). ${isOversold ? 'OVERSOLD (< −2σ): High statistical probability of mean-reversion rally.' : isOverbought ? 'OVERBOUGHT (> +2σ): High probability of mean-reversion pullback.' : 'Price within normal ±2σ statistical distribution.'}`,
    };
  }
}
