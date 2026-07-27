import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';

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

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    const { optionsChain, currentPrice } = input;
    if (!optionsChain?.contracts?.length || !optionsChain.expirations?.length) return null;

    try {
      // Use nearest expiry only — max pain is an expiry-specific phenomenon
      const nearExpiry = optionsChain.expirations[0]!;
      const nearContracts = optionsChain.contracts.filter(
        c => c.details?.expiration_date === nearExpiry,
      );

      if (nearContracts.length === 0) return null;

      // Calculate DTE (approximate from expiry string)
      const today = new Date();
      const expDate = new Date(nearExpiry + 'T16:00:00');
      const dte = Math.max(0, Math.ceil((expDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)));

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

        // Call pain: all calls with strike > K are ITM for holders at price K
        for (const [s, oi] of Object.entries(callOiByStrike)) {
          const strike = Number(s);
          if (strike > K) totalPain += oi * (strike - K);
        }

        // Put pain: all puts with strike < K are ITM for holders at price K
        for (const [s, oi] of Object.entries(putOiByStrike)) {
          const strike = Number(s);
          if (strike < K) totalPain += oi * (K - strike);
        }

        if (totalPain < minPain) {
          minPain = totalPain;
          maxPainStrike = K;
        }
      }

      // Compute directional drift signal
      const driftPct = (maxPainStrike - currentPrice) / currentPrice;
      // Exponential decay: strength halves every 7 DTE (strongest inside 5 DTE)
      const strength = Math.abs(driftPct) * Math.exp(-dte / 7);

      // Signal is only tradeable when DTE <= 14 (OpEx gravity is detectable)
      if (dte > 21 || strength < 0.001) {
        return {
          factorName: this.name,
          buyTarget: currentPrice * 0.985,
          sellTarget: currentPrice * 1.015,
          bias: 'neutral',
          weight: 0.10, // Low weight when far from expiry
          reasoning: `Max Pain at $${maxPainStrike.toFixed(2)} (${driftPct >= 0 ? '+' : ''}${(driftPct * 100).toFixed(1)}% from spot). DTE=${dte} is too far for OpEx gravity to dominate. Signal weight reduced.`,
        };
      }

      const bias = driftPct > 0.005 ? 'bullish' : driftPct < -0.005 ? 'bearish' : 'neutral';
      const buyTarget = Math.min(currentPrice * 0.99, maxPainStrike * 0.995);
      const sellTarget = Math.max(currentPrice * 1.01, maxPainStrike * 1.005);

      return {
        factorName: this.name,
        buyTarget,
        sellTarget,
        bias,
        weight: 0.20,
        reasoning: `Max Pain at $${maxPainStrike.toFixed(2)} (${driftPct >= 0 ? '+' : ''}${(driftPct * 100).toFixed(1)}% from spot, DTE=${dte}). Gravitational strength = ${(strength * 100).toFixed(2)}%. OpEx pinning pressure is ${driftPct > 0 ? 'UPWARD (bullish bias toward max pain)' : driftPct < 0 ? 'DOWNWARD (bearish bias toward max pain)' : 'NEUTRAL'}.`,
      };
    } catch (err) {
      return null;
    }
  }
}
