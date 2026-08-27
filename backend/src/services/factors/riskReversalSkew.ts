import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';
import { evaluateRiskReversalFactor } from '../optionsAnalyticsService.js';

export class RiskReversalSkewFactor implements PredictiveFactor {
  name = 'Risk Reversal Skew (25-Delta IV)';
  bucket = 'OPTIONS' as const;
  correlationGroup = 'IV_STRUCTURE';

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    const { optionsChain, currentPrice } = input;
    if (!optionsChain?.contracts?.length || !optionsChain.expirations?.length) {
      return null;
    }

    try {
      // The decision date, not real "now" — see the note in termStructure.ts.
      const asOf = input.bars.length ? new Date(input.bars[input.bars.length - 1]!.datetime) : undefined;
      const result = await evaluateRiskReversalFactor(
        optionsChain.contracts,
        optionsChain.expirations,
        currentPrice,
        asOf,
      );
      if (!result) return null;

      const { skew, bias, putIV, callIV, narrative } = result;
      const buyTarget = bias === 'bearish' ? currentPrice * 0.975 : currentPrice * 0.99;
      const sellTarget = bias === 'bullish' ? currentPrice * 1.025 : currentPrice * 1.01;

      return {
        factorName: this.name,
        buyTarget,
        sellTarget,
        bias,
        weight: 0.20,
        bucket: 'OPTIONS',
        correlationGroup: 'IV_STRUCTURE',
        reasoning: `${narrative} (OTM Put IV ${(putIV * 100).toFixed(1)}% vs OTM Call IV ${(callIV * 100).toFixed(1)}%, skew ${skew >= 0 ? '+' : ''}${skew.toFixed(2)}pp).`,
      };
    } catch {
      return null;
    }
  }
}
