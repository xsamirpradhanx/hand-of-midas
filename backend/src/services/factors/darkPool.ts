import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';

export class DarkPoolFactor implements PredictiveFactor {
  name = 'Dark Pool Block Trade Density';

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    const { bars, currentPrice } = input;
    if (!bars || bars.length < 20) return null;

    // Detect High-Volume / Low-Range (HVLR) Stealth Dark Pool Accumulation
    const volumeSorted = [...bars].sort((a, b) => (b.volume || 0) - (a.volume || 0));
    const highVolThreshold = volumeSorted[Math.floor(bars.length * 0.2)]?.volume || 0; // Top 20% volume

    const darkPoolClusters: { price: number; volume: number }[] = [];

    for (const b of bars) {
      const vol = b.volume || 0;
      const range = b.high - b.low;
      const avgPrice = (b.high + b.low + b.close) / 3;

      // High volume relative to small price range = Dark Pool block crossing
      if (vol >= highVolThreshold && range < (currentPrice * 0.015)) {
        darkPoolClusters.push({ price: avgPrice, volume: vol });
      }
    }

    if (darkPoolClusters.length === 0) return null;

    // Find nearest dark pool support cluster below current price
    const supportClusters = darkPoolClusters.filter(c => c.price < currentPrice).sort((a, b) => b.price - a.price);
    const resistanceClusters = darkPoolClusters.filter(c => c.price > currentPrice).sort((a, b) => a.price - b.price);

    const darkPoolSupport = supportClusters.length > 0 ? supportClusters[0].price : currentPrice * 0.98;
    const darkPoolResistance = resistanceClusters.length > 0 ? resistanceClusters[0].price : currentPrice * 1.02;

    const bias = supportClusters.length >= resistanceClusters.length ? 'bullish' : 'bearish';

    return {
      factorName: this.name,
      buyTarget: darkPoolSupport,
      sellTarget: darkPoolResistance,
      bias,
      weight: 0.20,
      reasoning: `Identified ${darkPoolClusters.length} stealth Dark Pool block-cross clusters. Nearest off-exchange accumulation support at $${darkPoolSupport.toFixed(2)}.`,
    };
  }
}
