import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';
import { evaluateTermStructureFactor } from '../optionsAnalyticsService.js';

export class TermStructureFactor implements PredictiveFactor {
  name = 'Volatility Term Structure Slope';
  bucket = 'OPTIONS' as const;
  correlationGroup = 'IV_STRUCTURE';

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    const { optionsChain, currentPrice } = input;
    if (!optionsChain?.expirations || optionsChain.expirations.length < 2) {
      return null;
    }

    try {
      // The decision date, not real "now" — getDTE/getTimeToExpiryYears
      // measure against real "now" unless told otherwise, and every
      // historical expiry predates that during a backtest/audit.
      const asOf = input.bars.length ? new Date(input.bars[input.bars.length - 1]!.datetime) : undefined;
      const result = await evaluateTermStructureFactor(
        input.symbol,
        optionsChain.contracts,
        optionsChain.expirations,
        currentPrice,
        asOf,
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
        bucket: 'OPTIONS',
        correlationGroup: 'IV_STRUCTURE',
        reasoning: result.narrative,
      };
    } catch {
      return null;
    }
  }
}
