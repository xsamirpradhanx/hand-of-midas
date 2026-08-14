import { blackScholes, getRiskFreeRate } from '../greeks.js';
import { getTimeToExpiryYears } from '../tradingCalendar.js';
import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';

/**
 * Vanna-Driven Market Maker Delta Hedging Pressure Factor
 *
 * Trading Edge:
 * Vanna (d²V/dS·dσ = dDelta/dσ = dVega/dS) measures how a market maker's delta
 * hedge changes as implied volatility changes. When IV rises, dealers must buy
 * (if net vanna is positive) or sell (if net vanna is negative) spot shares to
 * re-hedge — creating measurable directional flow without any underlying news.
 *
 * This is especially powerful when:
 * - VIX spikes (sudden IV expansion → dealers buy spot aggressively = bullish pulse)
 * - Volatility crush post-earnings (IV collapse → dealers sell spot = bearish drift)
 * - During VIX term structure inversions (backwardation)
 *
 * Formula:
 *   NetVannaExposure = sum over all contracts: Vanna_i * OI_i * sign(dealer_position)
 *   where sign = +1 for calls (dealer long call = long vanna) and
 *         sign = -1 for puts (dealer short put = short vanna, positive net vanna)
 *   VannaDeltaFlowEstimate = NetVannaExposure * spot * ΔIV_1day
 *   where ΔIV_1day is estimated from 30d/1d vol ratio
 */
export class VannaDeltaPressureFactor implements PredictiveFactor {
  name = 'Vanna-Delta Hedging Pressure';
  bucket = 'OPTIONS' as const;
  correlationGroup = 'VANNA_FLOW';

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    const { optionsChain, currentPrice, bars } = input;
    if (!optionsChain?.contracts?.length || !optionsChain.expirations?.length) return null;

    try {
      // Aggregate net vanna exposure across nearest 4 expirations
      const targetExpiries = new Set(optionsChain.expirations.slice(0, 4));
      let netVanna = 0;
      let totalOI = 0;

      for (const c of optionsChain.contracts) {
        const expiry = c.details?.expiration_date;
        if (!expiry || !targetExpiries.has(expiry)) continue;

        const strike = c.details?.strike_price || 0;
        const type = c.details?.contract_type as 'call' | 'put';
        const oi = c.day?.open_interest || 0;
        const iv = c.implied_volatility || 0;

        if (strike <= 0 || oi <= 0 || iv <= 0) continue;

        const rawT = getTimeToExpiryYears(expiry);
        const t = Math.max(rawT, 1 / 365);

        const greeks = blackScholes(currentPrice, strike, t, getRiskFreeRate(), iv, type);
        const vanna = greeks.vanna || 0;

        // Dealer position convention: long calls, short puts
        // Long call vanna: positive vanna → dealer buys spot as IV rises
        // Short put vanna: put vanna is negative → -(negative) = positive contribution
        const dealerVannaSigned = type === 'call' ? vanna * oi : -vanna * oi;
        netVanna += dealerVannaSigned;
        totalOI += oi;
      }

      if (totalOI === 0) return null;

      // Normalize net vanna per 1000 contracts of OI
      const normalizedVanna = (netVanna / totalOI) * 1000;

      // Estimate implied daily IV change from historical vol of vol
      // Use the standard deviation of 10-day rolling vol changes as ΔIV proxy
      let deltaIVEstimate = 0.01; // Default: 1% daily IV change
      if (bars && bars.length >= 20) {
        const prices = bars.map(b => b.close);
        const returns: number[] = [];
        for (let i = 1; i < prices.length; i++) returns.push(Math.log(prices[i] / prices[i - 1]));

        const windowSize = 5;
        const periodVols: number[] = [];
        for (let i = windowSize; i <= returns.length; i++) {
          const slice = returns.slice(i - windowSize, i);
          const m = slice.reduce((a, b) => a + b, 0) / slice.length;
          const v = slice.reduce((s, r) => s + Math.pow(r - m, 2), 0) / (slice.length - 1);
          periodVols.push(Math.sqrt(v * 252));
        }

        if (periodVols.length >= 5) {
          const volChanges = periodVols.slice(-5).map((v, i, a) => i > 0 ? Math.abs(v - a[i-1]!) : 0).slice(1);
          deltaIVEstimate = Math.max(0.005, volChanges.reduce((a, b) => a + b, 0) / volChanges.length);
        }
      }

      // Vanna flow estimate: how much spot the MM must trade as IV changes by deltaIV.
      // Flow (in $ notional) = netVanna * currentPrice * deltaIV * 100 (contract multiplier).
      // The x100 multiplier was previously omitted, understating the dollar exposure by 2 orders of magnitude.
      const CONTRACT_MULTIPLIER = 100;
      const flowNotional = netVanna * currentPrice * deltaIVEstimate * CONTRACT_MULTIPLIER;
      const flowMillions = flowNotional / 1_000_000;

      // Classify signal
      // Positive netVanna + IV rising expectation → dealers BUY spot → bullish
      // Negative netVanna → dealers SELL spot as IV rises → bearish
      const SIGNIFICANT_THRESHOLD = 50; // contracts-worth of vanna

      const isBullishVanna = normalizedVanna > SIGNIFICANT_THRESHOLD;
      const isBearishVanna = normalizedVanna < -SIGNIFICANT_THRESHOLD;

      const bias = isBullishVanna ? 'bullish' : isBearishVanna ? 'bearish' : 'neutral';
      const buyTarget = isBullishVanna ? currentPrice * 0.99 : currentPrice * 0.985;
      const sellTarget = isBullishVanna ? currentPrice * 1.025 : currentPrice * 1.01;

      return {
        factorName: this.name,
        buyTarget,
        sellTarget,
        bias,
        weight: 0.20,
        bucket: 'OPTIONS',
        correlationGroup: 'GEX_COMPLEX',
        reasoning: `Net Vanna Exposure: ${normalizedVanna > 0 ? '+' : ''}${normalizedVanna.toFixed(1)} (per 1000 OI). Assuming a ±${(deltaIVEstimate * 100).toFixed(1)}% 1-day IV move (estimated from ${bars && bars.length >= 20 ? '5-day vol-of-vol' : 'a 1% default'}), dealers would ${netVanna > 0 ? 'BUY' : 'SELL'} ~$${Math.abs(flowMillions).toFixed(1)}M of spot to re-hedge delta. ${bias.toUpperCase()} Vanna-driven flow pressure.`,
      };
    } catch (err) {
      return null;
    }
  }
}
