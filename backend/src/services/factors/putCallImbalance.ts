import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';

export class PutCallImbalanceFactor implements PredictiveFactor {
  name = 'Put-Call Imbalance (Contrarian Sentiment)';
  bucket = 'OPTIONS' as const;
  correlationGroup = 'SENTIMENT_FLOW';

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    const { optionsChain, currentPrice } = input;
    if (!optionsChain || !optionsChain.contracts || optionsChain.contracts.length === 0) {
      return null;
    }

    try {
      let putVolume = 0;
      let callVolume = 0;
      let putOI = 0;
      let callOI = 0;

      for (const contract of optionsChain.contracts) {
        const type = contract.details?.contract_type;
        const volume = contract.day?.volume || 0;
        const oi = contract.day?.open_interest || 0;

        if (type === 'put') {
          putVolume += volume;
          putOI += oi;
        } else if (type === 'call') {
          callVolume += volume;
          callOI += oi;
        }
      }

      if (callVolume === 0 || callOI === 0) {
        return null;
      }

      const volumePCR = putVolume / callVolume;
      const oiPCR = putOI / callOI;

      // Extreme PCR logic: 
      // High PCR = Fear/Capitulation -> Contrarian Bullish
      // Low PCR = Greed/Complacency -> Contrarian Bearish
      
      let bias: 'bullish' | 'bearish' | 'neutral' = 'neutral';
      let reasoning = `Volume PCR: ${volumePCR.toFixed(2)}, OI PCR: ${oiPCR.toFixed(2)}.`;
      let weight = 0;

      if (volumePCR > 1.2 && oiPCR > 1.0) {
        bias = 'bullish';
        weight = 0.25;
        reasoning = `Extreme fear/capitulation detected (${reasoning}) Expecting a contrarian bounce.`;
      } else if (volumePCR < 0.6 && oiPCR < 0.8) {
        bias = 'bearish';
        weight = 0.25;
        reasoning = `Excessive greed/complacency detected (${reasoning}) Expecting a contrarian pullback.`;
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
