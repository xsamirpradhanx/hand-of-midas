import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';
import { blackScholes } from '../greeks.js';
import { getDTE, getTimeToExpiryYears } from '../tradingCalendar.js';

export class DealerHedgingFactor implements PredictiveFactor {
  name = 'Dealer Microstructure (GEX & Greeks)';

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    const { optionsChain, currentPrice } = input;
    if (!optionsChain || !optionsChain.expirations || optionsChain.expirations.length === 0 || !optionsChain.contracts || optionsChain.contracts.length === 0) {
      return null;
    }

    try {
      const nearestExpiry = optionsChain.expirations[0];
      const contracts = optionsChain.contracts.filter(c => c.details?.expiration_date === nearestExpiry);
      if (contracts.length === 0) return null;

      const dte = await getDTE(nearestExpiry);
      const t = Math.max(1 / 365, getTimeToExpiryYears(nearestExpiry));

      const gexByStrike: Record<number, number> = {};
      let atmContract: any = null;
      let minDiff = Infinity;

      for (const c of contracts) {
        const strike = c.details?.strike_price || 0;
        const type = c.details?.contract_type as 'call' | 'put';
        const oi = c.day?.open_interest || 0;
        const iv = c.implied_volatility || 0.5;

        if (oi > 0 && strike > 0) {
          const greeks = blackScholes(currentPrice, strike, t, 0.05, iv, type);
          const gex = greeks.gamma * oi * 100 * currentPrice * currentPrice * 0.01;
          gexByStrike[strike] = (gexByStrike[strike] || 0) + (type === 'call' ? gex : -gex);

          const diff = Math.abs(strike - currentPrice);
          if (diff < minDiff && type === 'call') {
            minDiff = diff;
            atmContract = { strike, iv, type };
          }
        }
      }

      const strikes = Object.keys(gexByStrike).map(Number).sort((a, b) => b - a);
      if (strikes.length === 0) return null;

      let gammaFlipStrike = 0;
      let cumulativeGex = 0;
      for (let i = 0; i < strikes.length; i++) {
        const prev = cumulativeGex;
        cumulativeGex += gexByStrike[strikes[i]];
        if (i > 0 && Math.sign(prev) !== Math.sign(cumulativeGex) && prev !== 0) {
          gammaFlipStrike = strikes[i];
          break;
        }
      }

      let vanna = 0;
      let charm = 0;
      if (atmContract) {
        const atmGreeks = blackScholes(currentPrice, atmContract.strike, t, 0.05, atmContract.iv, atmContract.type);
        vanna = atmGreeks.vanna || 0;
        charm = atmGreeks.charm || 0;
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

      return {
        factorName: this.name,
        buyTarget,
        sellTarget,
        bias,
        weight: 0.25,
        reasoning: `Gamma Flip at $${gammaFlipStrike.toFixed(2)} (${isLongGamma ? 'Long Gamma / Mean Reverting' : 'Short Gamma / High Volatility'}). ATM Vanna = ${vanna.toFixed(4)}, Charm = ${charm.toFixed(4)}.`,
      };
    } catch (err) {
      console.warn('DealerHedgingFactor error, skipping:', err);
      return null;
    }
  }
}
