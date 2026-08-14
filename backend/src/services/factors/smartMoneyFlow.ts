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
  bucket = 'ORDER_FLOW' as const;
  correlationGroup = 'CVD';

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

      // Accumulation / Distribution Score 0-100
      let accDistScore = 50; // Neutral baseline

      if (isInstitutionalDominated && isSmartBullish) {
        bias = 'bullish';
        reasoning = `Institutions buying near-ATM calls (SMFR: ${smfr.toFixed(1)}, Call Ratio: ${(smartCallRatio * 100).toFixed(0)}%)`;
        accDistScore = 80 + Math.min(20, smfr * 2);
      } else if (isInstitutionalDominated && isSmartBearish) {
        bias = 'bearish';
        reasoning = `Institutions buying near-ATM puts (SMFR: ${smfr.toFixed(1)}, Call Ratio: ${(smartCallRatio * 100).toFixed(0)}%)`;
        accDistScore = 20 - Math.min(20, smfr * 2);
      } else if (isRetailDominated && isSmartBullish) {
        // Retail is overwhelmingly buying calls -> contrarian bearish
        bias = 'bearish';
        reasoning = `Retail frenzy in far-OTM calls (SMFR: ${smfr.toFixed(1)}) — Fade potential`;
        accDistScore = 30;
      } else if (isRetailDominated && isSmartBearish) {
        // Retail is overwhelmingly buying puts -> contrarian bullish
        bias = 'bullish';
        reasoning = `Retail panic in far-OTM puts (SMFR: ${smfr.toFixed(1)}) — Bounce potential`;
        accDistScore = 70;
      } else {
        bias = 'neutral';
        reasoning = `Mixed order flow (SMFR: ${smfr.toFixed(1)})`;
        accDistScore = 50 + (smartCallRatio - 0.5) * 20; // Slight tilt based on call ratio
      }

      // Institutional-flow bias tilts the pullback zone slightly closer to price
      // and the target slightly further; retail-fade bias does the reverse.
      // Previously these two identifiers were referenced but never declared,
      // causing every call to throw ReferenceError (silently caught below).
      const buyTarget = bias === 'bullish' ? currentPrice * 0.99 : currentPrice * 0.985;
      const sellTarget = bias === 'bullish' ? currentPrice * 1.025 : currentPrice * 1.01;

      return {
        factorName: this.name,
        buyTarget,
        sellTarget,
        bias,
        weight: 0.20,
        bucket: 'ORDER_FLOW',
        correlationGroup: 'CVD',
        reasoning,
      };
    } catch (err) {
      // Surface unexpected failures instead of swallowing them; a silent catch
      // hid the undeclared-target bug for months.
      console.warn(`[SmartMoneyFlow] evaluation failed for ${input.symbol}:`, err);
      return null;
    }
  }
}
