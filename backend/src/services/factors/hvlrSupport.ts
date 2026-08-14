import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';

export class HvlrSupportFactor implements PredictiveFactor {
  name = 'High-Volume Low-Range (HVLR) Support Proxy';
  bucket = 'PRICE_STRUCTURE' as const;
  correlationGroup = 'VOLUME_PROFILE';

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    const { bars, currentPrice } = input;
    if (!bars || bars.length < 20) return null;

    // Detect High-Volume / Low-Range bars: heavy volume compressed into a tight
    // price range typically marks a level where large participants transacted
    // and are likely to defend on retest. Public OHLCV data cannot distinguish
    // on-exchange from off-exchange (dark-pool) activity, so no such claim is
    // made in the narrative.
    const volumeSorted = [...bars].sort((a, b) => (b.volume || 0) - (a.volume || 0));
    const highVolThreshold = volumeSorted[Math.floor(bars.length * 0.2)]?.volume || 0; // Top 20% volume

    const hvlrClusters: { price: number; volume: number }[] = [];

    for (const b of bars) {
      const vol = b.volume || 0;
      const range = b.high - b.low;
      const avgPrice = (b.high + b.low + b.close) / 3;

      // High volume relative to small price range = a level of concentrated interest
      if (vol >= highVolThreshold && range < (currentPrice * 0.015)) {
        hvlrClusters.push({ price: avgPrice, volume: vol });
      }
    }

    if (hvlrClusters.length === 0) return null;

    // Find nearest HVLR cluster below and above current price
    const supportClusters = hvlrClusters.filter(c => c.price < currentPrice).sort((a, b) => b.price - a.price);
    const resistanceClusters = hvlrClusters.filter(c => c.price > currentPrice).sort((a, b) => a.price - b.price);

    const hvlrSupport = supportClusters.length > 0 ? supportClusters[0].price : currentPrice * 0.98;
    const hvlrResistance = resistanceClusters.length > 0 ? resistanceClusters[0].price : currentPrice * 1.02;

    const bias = supportClusters.length >= resistanceClusters.length ? 'bullish' : 'bearish';

    return {
      factorName: this.name,
      buyTarget: hvlrSupport,
      sellTarget: hvlrResistance,
      bias,
      weight: 0.20,
      bucket: 'PRICE_STRUCTURE',
      correlationGroup: 'VOLUME_PROFILE',
      reasoning: `Identified ${hvlrClusters.length} high-volume, tight-range bars indicating levels of concentrated interest. Nearest level below current price: $${hvlrSupport.toFixed(2)}.`,
    };
  }
}
