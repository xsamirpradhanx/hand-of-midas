import { getRiskFreeRate } from '../greeks.js';
import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';
import { blackScholes } from '../greeks.js';
import { getDTE, getTimeToExpiryYears } from '../tradingCalendar.js';

export class DealerHedgingFactor implements PredictiveFactor {
  name = 'Dealer Microstructure (GEX & Greeks)';
  bucket = 'OPTIONS' as const;
  correlationGroup = 'GEX_COMPLEX';

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    const { optionsChain, currentPrice } = input;
    if (!optionsChain || !optionsChain.expirations || optionsChain.expirations.length === 0 || !optionsChain.contracts || optionsChain.contracts.length === 0) {
      return null;
    }

    try {
      // Multi-expiry GEX: aggregate nearest 6 expirations weighted by 1/DTE
      const targetExpiries = new Set(optionsChain.expirations.slice(0, 6));
      const gexByStrike: Record<number, number> = {};
      let netVanna = 0;

      for (const c of optionsChain.contracts) {
        const expiry = c.details?.expiration_date;
        if (!expiry || !targetExpiries.has(expiry)) continue;

        const strike = c.details?.strike_price || 0;
        const type = c.details?.contract_type as 'call' | 'put';
        const oi = c.day?.open_interest || 0;
        const iv = c.implied_volatility || 0.5;

        if (oi > 0 && strike > 0) {
          // T_eff guard: minimum 1 calendar day to prevent 0-DTE gamma explosion
          const rawT = getTimeToExpiryYears(expiry);
          const t = Math.max(rawT, 1 / 365);
          const dte = Math.max(1, t * 365);
          const dteWeight = 1 / dte;

          const greeks = blackScholes(currentPrice, strike, t, getRiskFreeRate(), iv, type);
          const gex = greeks.gamma * oi * 100 * currentPrice * currentPrice * 0.01 * dteWeight;
          gexByStrike[strike] = (gexByStrike[strike] || 0) + (type === 'call' ? gex : -gex);

          // Aggregate vanna exposure: -n(d1)*d2/sigma * OI (signed by type)
          // Positive net vanna → dealers buy spot as IV rises; negative → dealers sell
          const vannaContrib = (greeks.vanna || 0) * oi * (type === 'call' ? 1 : -1);
          netVanna += vannaContrib;
        }
      }

      const strikes = Object.keys(gexByStrike).map(Number);
      if (strikes.length === 0) return null;

      const totalNetGex = strikes.reduce((sum, strike) => sum + gexByStrike[strike], 0);
      // Strikes must always be evaluated in ascending order (low strike to high strike)
      // to identify the transition from negative dealer gamma (puts) to positive dealer gamma (calls)
      strikes.sort((a, b) => a - b);

      // Interpolated gamma-flip: linear zero-crossing of cumulative GEX.
      //
      // Every crossing is collected rather than breaking at the first one. Cumulative
      // GEX starts near zero and wobbles across the axis over deep-OTM strikes that
      // carry almost no open interest, so the first crossing is routinely numerical
      // noise far from anything tradeable — on WULF (spot $17.38) the first crossing
      // was cumulative GEX moving from +4 to -1 at $5.81, while the real gamma
      // structure sat at $15–$21. That noise crossing was being reported as the flip.
      //
      // Two filters make the result meaningful: a crossing must be material relative
      // to the book's total gamma, and of the survivors we take the one nearest spot,
      // since the flip only matters as a level price can actually interact with.
      const totalAbsGex = strikes.reduce((sum, k) => sum + Math.abs(gexByStrike[k]!), 0);
      const MATERIALITY = 0.02; // crossing must involve >=2% of total |GEX| to count
      const candidates: number[] = [];
      let cumulativeGex = 0;
      for (let i = 0; i < strikes.length; i++) {
        const prev = cumulativeGex;
        cumulativeGex += gexByStrike[strikes[i]]!;

        if (i > 0 && Math.sign(prev) !== Math.sign(cumulativeGex) && prev !== 0) {
          const swing = Math.max(Math.abs(prev), Math.abs(cumulativeGex));
          if (totalAbsGex > 0 && swing / totalAbsGex < MATERIALITY) continue;
          const strikeA = strikes[i - 1]!;
          const strikeB = strikes[i]!;
          candidates.push(
            strikeA + (strikeB - strikeA) * Math.abs(prev) / (Math.abs(prev) + Math.abs(cumulativeGex)),
          );
        }
      }

      const gammaFlipStrike = candidates.length === 0
        ? 0
        : candidates.reduce((best, k) =>
            Math.abs(k - currentPrice) < Math.abs(best - currentPrice) ? k : best);

      // No zero-crossing in the scanned strikes means the flip point is outside
      // this range (or doesn't exist for this dataset) — fabricating a strike
      // number here would imply precision we don't have. Fall back to the sign
      // of total net GEX, which is still a valid (if less precise) read on
      // whether dealers are net long or short gamma across the board.
      const hasCrossing = gammaFlipStrike > 0;
      const isLongGamma = hasCrossing ? currentPrice > gammaFlipStrike : totalNetGex > 0;
      const bias = isLongGamma ? 'neutral' : 'bearish';

      let buyTarget: number | undefined;
      let sellTarget: number | undefined;

      if (hasCrossing) {
        if (gammaFlipStrike < currentPrice) {
          buyTarget = gammaFlipStrike;
        } else {
          sellTarget = gammaFlipStrike;
        }
      }

      const vannaDirection = netVanna > 0 ? 'buy-side' : 'sell-side';
      const flipDesc = hasCrossing
        ? `Multi-expiry Gamma Flip at $${gammaFlipStrike.toFixed(2)}`
        : `No gamma-flip crossing within scanned strikes (net GEX uniformly ${totalNetGex >= 0 ? 'positive' : 'negative'})`;

      return {
        factorName: this.name,
        buyTarget,
        sellTarget,
        bias,
        weight: 0.25,
        bucket: 'OPTIONS',
        correlationGroup: 'GEX_COMPLEX',
        reasoning: `${flipDesc} (${isLongGamma ? 'Long Gamma / Mean Reverting' : 'Short Gamma / High Volatility'}). Net Vanna Exposure: ${vannaDirection} (${netVanna > 0 ? '+' : ''}${netVanna.toFixed(0)} contracts) — dealers will ${netVanna > 0 ? 'BUY' : 'SELL'} spot as IV rises.`,
      };
    } catch (err) {
      console.warn('DealerHedgingFactor error, skipping:', err);
      return null;
    }
  }
}
