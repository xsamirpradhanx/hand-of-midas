import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';

/**
 * Smart Money Flow Ratio Factor
 *
 * Trading Edge:
 * Decouples retail order flow (small lot, 1-10 contracts, often OTM) from institutional
 * flow (large block, 50+ contracts, typically near-ATM or with structured spread pricing).
 *
 * Using the OI distribution of the options chain as a proxy:
 * - Contracts with large OI (> 90th percentile) and moderate strike (near ATM ±10%)
 *   represent institutional positioning and structured notes.
 * - Contracts with small OI (< 25th percentile) at extreme OTM strikes represent
 *   retail lottery-ticket speculation.
 *
 * Smart Money Flow Ratio (SMFR):
 *   InstitutionalOI = sum of OI for contracts in top OI decile within 10% of spot
 *   RetailOI = sum of OI for contracts with OI < 25th percentile beyond 10% OTM
 *   SMFR = InstitutionalOI / max(1, RetailOI)
 *   SMFR > 3: institutional dominance (directional smart money positioning)
 *   SMFR < 1: retail dominated (contrarian signal — fade the move)
 *
 * Call vs Put SMFR split identifies directional institutional intent:
 *   SmartCallRatio = InstitutionalCallOI / (InstitutionalCallOI + InstitutionalPutOI)
 *   SmartCallRatio > 0.65 → institutions positioned bullish
 *   SmartCallRatio < 0.35 → institutions positioned bearish
 */
export class SmartMoneyFlowFactor implements PredictiveFactor {
  name = 'Smart Money Flow Ratio';

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    const { optionsChain, currentPrice } = input;
    if (!optionsChain?.contracts?.length) return null;

    try {
      const contracts = optionsChain.contracts;

      // Collect all OI values to compute percentile thresholds
      const allOI = contracts
        .map(c => c.day?.open_interest || 0)
        .filter(oi => oi > 0)
        .sort((a, b) => a - b);

      if (allOI.length < 10) return null;

      const p90 = allOI[Math.floor(allOI.length * 0.9)] || 0;
      const p25 = allOI[Math.floor(allOI.length * 0.25)] || 0;

      // Institutional flow: large OI (>90th pct) within 10% of spot
      let institutionalCallOI = 0;
      let institutionalPutOI = 0;

      // Retail flow: small OI (<25th pct) far OTM (>10% from spot)
      let retailCallOI = 0;
      let retailPutOI = 0;

      for (const c of contracts) {
        const strike = c.details?.strike_price || 0;
        const type = c.details?.contract_type as 'call' | 'put';
        const oi = c.day?.open_interest || 0;

        if (strike <= 0 || oi <= 0) continue;

        const distFromSpot = Math.abs(strike - currentPrice) / currentPrice;
        const isNearATM = distFromSpot <= 0.10;
        const isFarOTM = distFromSpot > 0.15;

        if (oi >= p90 && isNearATM) {
          // Large block near-ATM → institutional
          if (type === 'call') institutionalCallOI += oi;
          else institutionalPutOI += oi;
        } else if (oi <= p25 && isFarOTM) {
          // Small OI far OTM → retail speculation
          if (type === 'call') retailCallOI += oi;
          else retailPutOI += oi;
        }
      }

      const institutionalTotal = institutionalCallOI + institutionalPutOI;
      const retailTotal = retailCallOI + retailPutOI;

      if (institutionalTotal === 0) return null;

      const smfr = institutionalTotal / Math.max(1, retailTotal);

      // Smart Call Ratio: institutional call/put split
      const smartCallRatio = institutionalCallOI / Math.max(1, institutionalTotal);

      // Classify
      const isInstitutionalDominated = smfr > 3.0;
      const isRetailDominated = smfr < 1.0;
      const isSmartBullish = smartCallRatio > 0.65;
      const isSmartBearish = smartCallRatio < 0.35;

      let bias: 'bullish' | 'bearish' | 'neutral';
      let reasoning: string;
      let buyTarget: number;
      let sellTarget: number;

      if (isInstitutionalDominated && isSmartBullish) {
        bias = 'bullish';
        buyTarget = currentPrice * 0.99;
        sellTarget = currentPrice * 1.03;
        reasoning = `Smart Money Flow Ratio = ${smfr.toFixed(1)}x (Institutional ${institutionalTotal.toLocaleString()} OI vs Retail ${retailTotal.toLocaleString()} OI). Smart Call Ratio = ${(smartCallRatio * 100).toFixed(0)}% — INSTITUTIONAL BULLISH positioning dominates. Follow the smart money up.`;
      } else if (isInstitutionalDominated && isSmartBearish) {
        bias = 'bearish';
        buyTarget = currentPrice * 0.97;
        sellTarget = currentPrice * 1.01;
        reasoning = `Smart Money Flow Ratio = ${smfr.toFixed(1)}x. Smart Call Ratio = ${(smartCallRatio * 100).toFixed(0)}% — INSTITUTIONAL BEARISH put positioning dominates. Smart money hedged/short.`;
      } else if (isRetailDominated) {
        // Contrarian: retail dominance often signals a fading opportunity
        bias = isSmartBullish ? 'bearish' : 'bullish'; // Fade retail direction
        buyTarget = currentPrice * 0.985;
        sellTarget = currentPrice * 1.015;
        reasoning = `Smart Money Flow Ratio = ${smfr.toFixed(1)}x — RETAIL DOMINATED. Small-lot OTM speculation (${retailTotal.toLocaleString()} OI) outpaces institutional (${institutionalTotal.toLocaleString()} OI). Contrarian fade signal.`;
      } else {
        bias = 'neutral';
        buyTarget = currentPrice * 0.985;
        sellTarget = currentPrice * 1.015;
        reasoning = `Smart Money Flow Ratio = ${smfr.toFixed(1)}x. Institutional OI (${institutionalTotal.toLocaleString()}) vs Retail OI (${retailTotal.toLocaleString()}). No clear smart money directional bias. Smart Call Ratio ${(smartCallRatio * 100).toFixed(0)}%.`;
      }

      return {
        factorName: this.name,
        buyTarget,
        sellTarget,
        bias,
        weight: 0.20,
        reasoning,
      };
    } catch (err) {
      return null;
    }
  }
}
