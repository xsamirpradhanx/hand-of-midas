import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';

export class HurstExponentFactor implements PredictiveFactor {
  name = 'Hurst Exponent (Regime Classification)';

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

    // Rescaled Range (R/S) Hurst estimation
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
    if (stdDev === 0 || range === 0) return null;

    const rs = range / stdDev;
    // H = log(R/S) / log(N)
    const hurst = Math.max(0, Math.min(1, Math.log(rs) / Math.log(n)));

    const isMeanReverting = hurst < 0.45;
    const isTrending = hurst > 0.55;

    const bias = isTrending ? (prices[prices.length - 1] > prices[0] ? 'bullish' : 'bearish') : 'neutral';
    const reasoning = `Hurst Exponent H = ${hurst.toFixed(2)} (${isMeanReverting ? 'Mean-Reverting Regime: Range-bound trading' : isTrending ? 'Persistent/Trending Regime: Trend continuation' : 'Random Walk / Neutral'}).`;

    return {
      factorName: this.name,
      buyTarget: isTrending && bias === 'bullish' ? currentPrice * 0.99 : currentPrice * 0.975,
      sellTarget: isTrending && bias === 'bearish' ? currentPrice * 1.01 : currentPrice * 1.025,
      bias,
      weight: 0.20,
      reasoning,
    };
  }
}
