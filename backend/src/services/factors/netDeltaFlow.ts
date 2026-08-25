import { getRiskFreeRate, blackScholes } from '../greeks.js';
import { getTimeToExpiryYears } from '../tradingCalendar.js';
import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';

export class NetDeltaFlowFactor implements PredictiveFactor {
  name = 'Net Delta Flow (Directional Conviction)';
  bucket = 'OPTIONS' as const;
  correlationGroup = 'ORDER_FLOW';

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    const { optionsChain, currentPrice } = input;
    if (!optionsChain || !optionsChain.contracts || optionsChain.contracts.length === 0) {
      return null;
    }

    try {
      let netDelta = 0;
      let totalDelta = 0;

      for (const contract of optionsChain.contracts) {
        const expiry = contract.details?.expiration_date;
        const strike = contract.details?.strike_price || 0;
        const type = contract.details?.contract_type as 'call' | 'put';
        const volume = contract.day?.volume || 0;
        const iv = contract.implied_volatility || 0.3; // Fallback if missing

        if (volume > 0 && strike > 0 && expiry) {
          const t = Math.max(getTimeToExpiryYears(expiry), 1 / 365);
          
          // Use Black-Scholes to estimate Delta
          const greeks = blackScholes(currentPrice, strike, t, getRiskFreeRate(), iv, type);
          const delta = greeks.delta || 0;

          // Volume * Delta represents the directional flow
          const directionalVolume = delta * volume;
          
          netDelta += directionalVolume;
          totalDelta += Math.abs(directionalVolume);
        }
      }

      if (totalDelta === 0) return null;

      // Normalize net delta flow relative to total absolute delta flow
      // Range is [-1.0, 1.0]
      const deltaConviction = netDelta / totalDelta;

      let bias: 'bullish' | 'bearish' | 'neutral' = 'neutral';
      let weight = 0;
      let reasoning = `Net Delta Flow Conviction: ${(deltaConviction * 100).toFixed(1)}%.`;

      if (deltaConviction > 0.3) {
        bias = 'bearish';
        weight = 0.20;
        reasoning = `Options flow is heavily skewed towards positive Delta (${reasoning}) Indicating contrarian topping / retail speculation.`;
      } else if (deltaConviction < -0.3) {
        bias = 'bullish';
        weight = 0.20;
        reasoning = `Options flow is heavily skewed towards negative Delta (${reasoning}) Indicating contrarian bottoming / extreme hedging.`;
      } else {
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
