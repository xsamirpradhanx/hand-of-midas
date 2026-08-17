import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';
import { getDTE } from '../tradingCalendar.js';

/**
 * Max Pain Strike Gravitational Drift Factor
 *
 * Trading Edge:
 * Max Pain theory: at options expiration, the underlying price gravitates toward the
 * strike where the maximum number of open option contracts (both calls and puts)
 * expire worthless — minimizing payout to option buyers, maximizing profit for sellers
 * (predominantly market makers and institutional short-vol desks).
 *
 * This force is strongest in the final 5 days before expiry (DTE <= 5) and during
 * OpEx weeks. The gravitational pull weakens proportionally to DTE.
 *
 * Formula:
 *   MaxPain = strike K* where sum(call_pain(K*) + put_pain(K*)) is minimized
 *   call_pain(K) = sum over all strikes S where S > K of OI_call(S) * (S - K)
 *   put_pain(K) = sum over all strikes S where S < K of OI_put(S) * (K - S)
 *   DriftSignal = (MaxPainStrike - CurrentPrice) / CurrentPrice  [directional pull %]
 *   Strength = DriftSignal * exp(-DTE / 7)  [exponential decay away from expiry]
 */
export class MaxPainDriftFactor implements PredictiveFactor {
  name = 'Max Pain Gravitational Drift';
  bucket = 'OPTIONS' as const;
  correlationGroup = 'MAX_PAIN';

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    const { optionsChain, currentPrice } = input;
    if (!optionsChain?.contracts?.length || !optionsChain.expirations?.length) return null;

    try {
      // Use specified activeExpiry or default to nearest
      let nearExpiry = input.activeExpiry;
      if (!nearExpiry || !optionsChain.expirations.includes(nearExpiry)) {
        nearExpiry = optionsChain.expirations[0]!;
      }

      const nearContracts = optionsChain.contracts.filter(
        c => c.details?.expiration_date === nearExpiry,
      );

      if (nearContracts.length === 0) return null;

      // Calculate DTE using canonical ET-timezone-aware trading-day counter.
      // Previously used `new Date() - new Date(expiry+'T16:00:00')` which is UTC on
      // Lambda (16:00 UTC ≠ 16:00 ET), producing DTE=1 for same-day expiry.
      const dte = getDTE(nearExpiry);

      // Collect all strikes with their call and put OI
      const callOiByStrike: Record<number, number> = {};
      const putOiByStrike: Record<number, number> = {};

      for (const c of nearContracts) {
        const strike = c.details?.strike_price || 0;
        const oi = c.day?.open_interest || 0;
        const type = c.details?.contract_type as 'call' | 'put';
        if (strike <= 0 || oi <= 0) continue;

        if (type === 'call') {
          callOiByStrike[strike] = (callOiByStrike[strike] || 0) + oi;
        } else {
          putOiByStrike[strike] = (putOiByStrike[strike] || 0) + oi;
        }
      }

      const allStrikes = Array.from(
        new Set([...Object.keys(callOiByStrike), ...Object.keys(putOiByStrike)].map(Number))
      ).sort((a, b) => a - b);

      if (allStrikes.length === 0) return null;

      // Compute total pain at each potential expiry price K
      let minPain = Infinity;
      let maxPainStrike = allStrikes[Math.floor(allStrikes.length / 2)]!;

      for (const K of allStrikes) {
        let totalPain = 0;

        // Call pain: calls are ITM when expiry price K > strike, payout is (K - strike)
        for (const [s, oi] of Object.entries(callOiByStrike)) {
          const strike = Number(s);
          if (K > strike) totalPain += oi * (K - strike);
        }

        // Put pain: puts are ITM when expiry price K < strike, payout is (strike - K)
        for (const [s, oi] of Object.entries(putOiByStrike)) {
          const strike = Number(s);
          if (strike > K) totalPain += oi * (strike - K);
        }

        if (totalPain < minPain) {
          minPain = totalPain;
          maxPainStrike = K;
        }
      }

      // Compute directional drift signal
      const driftPct = (maxPainStrike - currentPrice) / currentPrice;
      // Exponential decay: strength halves every 7 DTE (strongest inside 5 DTE)
      let strength = Math.abs(driftPct) * Math.exp(-dte / 7);

      let pinningRelevance = 'Strong';
      if (Math.abs(driftPct) > 0.15) {
        strength *= 0.5; // Discount gravitation force if excessively far
        pinningRelevance = 'Low / Unconfirmed';
      } else if (Math.abs(driftPct) > 0.05) {
        pinningRelevance = 'Moderate';
      }

      // Signal is only tradeable when DTE <= 21 (OpEx gravity is detectable).
      // Keep correlationGroup 'MAX_PAIN' regardless of DTE so the independent
      // evidence engine always places this in the correct de-duplication bucket
      // (was incorrectly 'GEX_COMPLEX' for far-dated options, which caused it to
      // compete with and potentially displace the DealerHedging GEX signal).
      if (dte > 21 || strength < 0.001) {
        return {
          factorName: this.name,
          buyTarget: currentPrice * 0.985,
          sellTarget: currentPrice * 1.015,
          bias: 'neutral',
          weight: 0.10,
          bucket: 'OPTIONS',
          correlationGroup: 'MAX_PAIN',
          reasoning: `Max Pain at $${maxPainStrike.toFixed(2)} (${driftPct >= 0 ? '+' : ''}${(driftPct * 100).toFixed(1)}% from spot). DTE=${dte} is too far for OpEx gravity to dominate. Signal weight reduced.`,
        };
      }

      let bias: 'bullish' | 'bearish' | 'neutral' = 'neutral';
      let pinningType = 'Magnet / Pinning Level';

      if (Math.abs(driftPct) <= 0.03) {
        // Within 3% of spot: acts primarily as a pinning magnet/anchor at expiry (not directional push)
        bias = 'neutral';
        pinningType = 'Near-Spot Pinning Magnet';
      } else if (Math.abs(driftPct) <= 0.15) {
        bias = driftPct > 0 ? 'bullish' : 'bearish';
        pinningType = driftPct > 0 ? 'Upward Gravitational Drift' : 'Downward Gravitational Drift';
      } else {
        bias = 'neutral';
        pinningType = 'Distant / Low Relevance';
      }

      // Emit the max-pain strike itself as the level, on whichever side of spot it
      // actually sits. The previous form (min/max against currentPrice * 0.99 / 1.01)
      // guaranteed a level ~1% either side of spot regardless of where max pain was:
      // with max pain ABOVE spot the "buyTarget" became a pure spot offset with no
      // options basis at all, and that invented number was close enough to survive
      // zone clustering while the genuine structure further out was discarded.
      // A pinning magnet is one level, not a pair straddling price.
      const pinLevel = maxPainStrike;
      const buyTarget = pinLevel < currentPrice ? pinLevel : undefined;
      const sellTarget = pinLevel > currentPrice ? pinLevel : undefined;

      return {
        factorName: this.name,
        buyTarget,
        sellTarget,
        bias,
        weight: 0.20,
        bucket: 'OPTIONS',
        correlationGroup: 'MAX_PAIN',
        reasoning: `Max Pain at $${maxPainStrike.toFixed(2)} (${driftPct >= 0 ? '+' : ''}${(driftPct * 100).toFixed(1)}% from spot, DTE=${dte}). Status: ${pinningType}. Pinning relevance: ${pinningRelevance}. Gravitational strength = ${(strength * 100).toFixed(2)}%.`,
      };
    } catch (err) {
      return null;
    }
  }
}
