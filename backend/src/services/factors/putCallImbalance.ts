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

      if (callVolume === 0) {
        return null;
      }

      const volumePCR = putVolume / callVolume;
      // Open interest is a standing-position signal a purely volume-based feed
      // (e.g. the ThetaData-backfilled S3 chains) cannot supply — `callOI`/
      // `putOI` stay 0 there. Gating on `oiPCR` as well as `volumePCR`
      // (the original design) made this factor permanently dead on that data,
      // even though volume-only PCR is a legitimate, standard sentiment read
      // on its own (it's what CBOE's headline put/call ratio actually is).
      // Fold OI in as corroborating color when it's actually available,
      // never as a hard requirement.
      const haveOi = callOI > 0 || putOI > 0;
      const oiPCR = callOI > 0 ? putOI / callOI : null;

      let bias: 'bullish' | 'bearish' | 'neutral' = 'neutral';
      let reasoning = `Volume PCR: ${volumePCR.toFixed(2)}${oiPCR !== null ? `, OI PCR: ${oiPCR.toFixed(2)}` : ''}.`;
      let weight = 0;

      if (volumePCR > 1.2) {
        bias = 'bullish';
        weight = haveOi && oiPCR !== null && oiPCR > 1.0 ? 0.25 : 0.15;
        reasoning = `Extreme fear/capitulation detected (${reasoning}) Expecting a contrarian bounce.`;
      } else if (volumePCR < 0.6) {
        bias = 'bearish';
        weight = haveOi && oiPCR !== null && oiPCR < 0.8 ? 0.25 : 0.15;
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
