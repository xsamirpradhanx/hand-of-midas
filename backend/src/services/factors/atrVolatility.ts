import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';

export class AtrVolatilityFactor implements PredictiveFactor {
  name = 'ATR Dynamic Volatility';
  bucket = 'POSITIONING' as const;
  correlationGroup = 'REGIME';

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    const { bars, currentPrice } = input;
    if (!bars || bars.length < 15) return null;

    // Calculate True Range (TR) for each bar
    const trValues: number[] = [];
    for (let i = 1; i < bars.length; i++) {
      const high = bars[i].high;
      const low = bars[i].low;
      const prevClose = bars[i - 1].close;

      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );
      trValues.push(tr);
    }

    if (trValues.length === 0) return null;

    // 14-period EMA of True Range
    const period = Math.min(14, trValues.length);
    let atr = trValues.slice(0, period).reduce((sum, val) => sum + val, 0) / period;

    for (let i = period; i < trValues.length; i++) {
      atr = ((trValues[i] - atr) * (2 / (period + 1))) + atr;
    }

    const atrPct = (atr / currentPrice) * 100;
    const buyTarget = Math.max(0, currentPrice - (1.5 * atr));
    const sellTarget = currentPrice + (1.5 * atr);

    return {
      factorName: this.name,
      buyTarget,
      sellTarget,
      bias: 'neutral',
      weight: 0.25,
      bucket: 'POSITIONING',
      correlationGroup: 'REGIME',
      reasoning: `14-Day ATR is $${atr.toFixed(2)} (${atrPct.toFixed(1)}% of price), setting 1.5x ATR volatility boundaries.`,
    };
  }
}
