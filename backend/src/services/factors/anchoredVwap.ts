import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';

export class AnchoredVwapFactor implements PredictiveFactor {
  name = 'Anchored VWAP (±2σ Bands)';
  bucket = 'PRICE_STRUCTURE' as const;
  correlationGroup = 'VWAP';

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    const { bars, currentPrice } = input;
    if (!bars || bars.length < 5) return null;

    // Anchor: last 30 bars (or all available if less)
    const anchorBars = bars.slice(-30);
    
    let cumVolume = 0;
    let cumPV = 0;

    for (const b of anchorBars) {
      const typicalPrice = (b.high + b.low + b.close) / 3;
      const vol = b.volume || 1;
      cumPV += typicalPrice * vol;
      cumVolume += vol;
    }

    if (cumVolume === 0) return null;

    const vwap = cumPV / cumVolume;

    // Calculate Volume-Weighted Variance & Standard Deviation
    let cumVariance = 0;
    for (const b of anchorBars) {
      const typicalPrice = (b.high + b.low + b.close) / 3;
      const vol = b.volume || 1;
      const diff = typicalPrice - vwap;
      cumVariance += vol * (diff * diff);
    }

    const stdDev = Math.sqrt(cumVariance / cumVolume);

    const buyTarget = Math.max(0, vwap - (2 * stdDev));
    const sellTarget = vwap + (2 * stdDev);
    const bias = currentPrice > vwap ? 'bullish' : 'bearish';

    return {
      factorName: this.name,
      buyTarget,
      sellTarget,
      bias,
      weight: 0.30,
      bucket: 'PRICE_STRUCTURE',
      correlationGroup: 'VWAP',
      reasoning: `Month-Anchored VWAP is $${vwap.toFixed(2)} (±2σ Bands: Lower $${buyTarget.toFixed(2)}, Upper $${sellTarget.toFixed(2)}). Price is currently ${bias.toUpperCase()} relative to VWAP.`,
    };
  }
}
