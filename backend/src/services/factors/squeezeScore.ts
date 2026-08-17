import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';

export class OptionsSqueezeFactor implements PredictiveFactor {
  name = 'Options Squeeze Score (Gamma Compression)';
  bucket = 'OPTIONS' as const;
  // Matches the correlationGroup actually returned by evaluate() below
  // ('GEX_COMPLEX') — was declared as 'OPTIONS_SQUEEZE' here, which nothing
  // reads (IndependentEvidenceEngine groups by the returned FactorResult
  // field, not this class-level one), but the mismatch was misleading.
  correlationGroup = 'GEX_COMPLEX';

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    const { optionsChain, currentPrice } = input;
    if (!optionsChain || !optionsChain.contracts || optionsChain.contracts.length === 0) {
      return null;
    }

    try {
      let callOI = 0;
      let putOI = 0;
      let nearMoneyCallOI = 0;

      for (const c of optionsChain.contracts) {
        const strike = c.details?.strike_price || 0;
        const type = c.details?.contract_type as 'call' | 'put';
        const oi = c.day?.open_interest || 0;

        if (type === 'call') callOI += oi;
        if (type === 'put') putOI += oi;

        // OTM Calls within 10% of spot (Squeeze Trigger Zone)
        if (type === 'call' && strike >= currentPrice && strike <= currentPrice * 1.10) {
          nearMoneyCallOI += oi;
        }
      }

      const totalOI = callOI + putOI;
      if (totalOI === 0) return null;

      // Squeeze Score formula: Near-money Call OI density relative to total OI
      const nearCallRatio = (nearMoneyCallOI / totalOI) * 100;
      const callPutRatio = putOI > 0 ? callOI / putOI : 1;

      // Score between 0 and 100%
      const squeezeScore = Math.min(100, Math.round((nearCallRatio * 2) + (callPutRatio * 15)));

      const isHighSqueezeRisk = squeezeScore >= 60;
      const bias = isHighSqueezeRisk ? 'bullish' : 'neutral';

      // High squeeze risk expands sell target upward to prevent getting stopped out early on a breakout
      const sellTarget = isHighSqueezeRisk ? currentPrice * 1.05 : currentPrice * 1.02;
      const buyTarget = currentPrice * 0.985;

      return {
        factorName: this.name,
        buyTarget,
        sellTarget,
        bias,
        weight: 0.20,
        bucket: 'OPTIONS',
        correlationGroup: 'GEX_COMPLEX',
        reasoning: `Squeeze Potential Score is ${squeezeScore}% (Call/Put Ratio: ${callPutRatio.toFixed(2)}, Near-Money Call OI: ${nearMoneyCallOI.toLocaleString()} contracts). ${isHighSqueezeRisk ? 'HIGH GAMMA SQUEEZE RISK: Expanding Sell Zone upward.' : 'Normal options gamma compression.'}`,
      };
    } catch (err) {
      return null;
    }
  }
}
