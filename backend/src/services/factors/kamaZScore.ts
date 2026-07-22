import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';

export class KamaZScoreFactor implements PredictiveFactor {
  name = 'KAMA & Z-Score Distance';

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    const { bars, currentPrice } = input;
    if (!bars || bars.length < 20) return null;

    const prices = bars.map(b => b.close);
    const n = prices.length;
    const period = 20;

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
    const isOversold = zScore < -1.8;
    const isOverbought = zScore > 1.8;

    const bias = isOversold ? 'bullish' : isOverbought ? 'bearish' : 'neutral';
    const buyTarget = isOversold ? currentPrice * 0.995 : currentPrice * 0.98;
    const sellTarget = isOverbought ? currentPrice * 1.005 : currentPrice * 1.02;

    return {
      factorName: this.name,
      buyTarget,
      sellTarget,
      bias,
      weight: 0.20,
      reasoning: `KAMA Z-Score Distance is ${zScore >= 0 ? '+' : ''}${zScore.toFixed(2)}σ (KAMA at $${kama.toFixed(2)}). ${isOversold ? 'OVERSOLD: High statistical probability of mean-reversion rally.' : isOverbought ? 'OVERBOUGHT: High probability of mean-reversion pullback.' : 'Price within normal 2σ statistical distribution.'}`,
    };
  }
}
