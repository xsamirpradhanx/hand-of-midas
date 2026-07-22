import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';
import { evaluateTermStructureFactor } from '../optionsAnalyticsService.js';

export class TermStructureFactor implements PredictiveFactor {
  name = 'Volatility Term Structure Slope';

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    const { optionsChain, currentPrice } = input;
    if (!optionsChain?.expirations || optionsChain.expirations.length < 2) {
      return null;
    }

    try {
      const result = await evaluateTermStructureFactor(
        optionsChain.contracts,
        optionsChain.expirations,
      );
      if (!result) return null;

      const isBackwardation = result.state === 'backwardation';
      const bias = isBackwardation ? 'bearish' : 'neutral';
      const buyTarget = isBackwardation ? currentPrice * 0.965 : currentPrice * 0.985;
      const sellTarget = isBackwardation ? currentPrice * 1.035 : currentPrice * 1.015;

      return {
        factorName: this.name,
        buyTarget,
        sellTarget,
        bias,
        weight: 0.15,
        reasoning: result.narrative,
      };
    } catch {
      return null;
    }
  }
}
