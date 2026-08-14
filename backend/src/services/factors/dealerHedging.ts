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
      const isNetPositive = totalNetGex >= 0;
      strikes.sort((a, b) => isNetPositive ? a - b : b - a);

      // Interpolated gamma-flip: linear zero-crossing between bracketing strikes
      let gammaFlipStrike = 0;
      let cumulativeGex = 0;
      for (let i = 0; i < strikes.length; i++) {
        const prev = cumulativeGex;
        cumulativeGex += gexByStrike[strikes[i]];
        
        if (i > 0 && Math.sign(prev) !== Math.sign(cumulativeGex) && prev !== 0) {
          const strikeA = strikes[i - 1]!;
          const strikeB = strikes[i]!;
          gammaFlipStrike = strikeA + (strikeB - strikeA) * Math.abs(prev) / (Math.abs(prev) + Math.abs(cumulativeGex));
          break;
        }
      }

      const isLongGamma = currentPrice > gammaFlipStrike && gammaFlipStrike > 0;
      const bias = isLongGamma ? 'neutral' : 'bearish';

      let buyTarget: number | undefined;
      let sellTarget: number | undefined;

      if (gammaFlipStrike > 0) {
        if (gammaFlipStrike < currentPrice) {
          buyTarget = gammaFlipStrike;
        } else {
          sellTarget = gammaFlipStrike;
        }
      }

      const vannaDirection = netVanna > 0 ? 'buy-side' : 'sell-side';

      return {
        factorName: this.name,
        buyTarget,
        sellTarget,
        bias,
        weight: 0.25,
        bucket: 'OPTIONS',
        correlationGroup: 'GEX_COMPLEX',
        reasoning: `Multi-expiry Gamma Flip at $${gammaFlipStrike.toFixed(2)} (${isLongGamma ? 'Long Gamma / Mean Reverting' : 'Short Gamma / High Volatility'}). Net Vanna Exposure: ${vannaDirection} (${netVanna > 0 ? '+' : ''}${netVanna.toFixed(0)} contracts) — dealers will ${netVanna > 0 ? 'BUY' : 'SELL'} spot as IV rises.`,
      };
    } catch (err) {
      console.warn('DealerHedgingFactor error, skipping:', err);
      return null;
    }
  }
}
