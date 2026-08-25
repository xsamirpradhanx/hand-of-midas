import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';

export class GammaExposureFactor implements PredictiveFactor {
  name = 'Gamma Exposure (GEX)';
  bucket = 'OPTIONS' as const;
  correlationGroup = 'SENTIMENT_FLOW';

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    const { optionsChain, currentPrice } = input;
    if (!optionsChain || !optionsChain.contracts || optionsChain.contracts.length === 0) {
      return null;
    }

    try {
      let callGEX = 0;
      let putGEX = 0;

      for (const contract of optionsChain.contracts) {
        const type = contract.details?.contract_type;
        const oi = contract.day?.open_interest || 0;
        const gamma = contract.greeks?.gamma || 0;

        if (oi === 0 || gamma === 0) {
          continue;
        }

        // Dollar GEX Formula per 1% move:
        // OI * Gamma * 100 * Spot * 0.01 = OI * Gamma * Spot
        // We calculate raw Gamma Exposure first.
        if (type === 'put') {
          putGEX += oi * gamma;
        } else if (type === 'call') {
          callGEX += oi * gamma;
        }
      }

      // SqueezeMetrics Assumption: Dealers are LONG Calls and SHORT Puts.
      // Net Dealer GEX = Call GEX - Put GEX
      const netGamma = callGEX - putGEX;

      // Convert to Dollar GEX per 1% move
      const dollarGEX = netGamma * 100 * currentPrice * 0.01;

      // To normalize across different market caps, we scale Dollar GEX.
      // Since we don't have access to volume in this scope directly for average dollar volume,
      // we'll use a dynamic relative threshold or a fixed threshold if appropriate.
      // Wait, we have average volume available via `input.bars`!
      let avgVolume = 0;
      const bars = input.bars;
      if (bars && bars.length > 20) {
          // Average volume over last 20 days
          for (let i = bars.length - 20; i < bars.length; i++) {
              avgVolume += bars[i].volume;
          }
          avgVolume /= 20;
      }
      
      if (avgVolume === 0) return null;
      
      const avgDollarVolume = avgVolume * currentPrice;
      
      // Calculate Dollar GEX as a percentage of Average Daily Dollar Volume
      const gexRatio = dollarGEX / avgDollarVolume;

      let bias: 'bullish' | 'bearish' | 'neutral' = 'neutral';
      let reasoning = `Total Dollar GEX: $${(dollarGEX / 1e6).toFixed(1)}M (${(gexRatio * 100).toFixed(2)}% of ADV).`;
      let weight = 0;

      // Thresholds:
      // If GEX ratio > 0.05 (5% of daily volume), pinning is strong -> Volatility dampening (bullish base rate drift)
      // If GEX ratio < -0.02 (-2% of daily volume), dealer selling accelerates -> Volatility expansion (bearish trend)
      if (gexRatio > 0.05) {
        bias = 'bullish';
        weight = 0.20; // Modest weight for bullish drift
        reasoning = `High positive Gamma exposure (${reasoning}) Expecting volatility suppression and upward drift.`;
      } else if (gexRatio < -0.02) {
        bias = 'bearish';
        weight = 0.25; // Higher weight for bearish squeze
        reasoning = `Negative Gamma exposure (${reasoning}) Expecting volatility expansion and downward pressure.`;
      } else {
        // Not extreme enough
        return null;
      }

      const buyTarget = bias === 'bearish' ? currentPrice * 0.98 : currentPrice * 0.99;
      const sellTarget = bias === 'bullish' ? currentPrice * 1.02 : currentPrice * 1.01;

      return {
        factorName: this.name,
        buyTarget,
        sellTarget,
        bias,
        weight,
        bucket: this.bucket,
        correlationGroup: this.correlationGroup,
        reasoning,
      };
    } catch {
      return null;
    }
  }
}
