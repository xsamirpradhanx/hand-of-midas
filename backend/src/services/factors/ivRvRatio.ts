import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';

/**
 * IV Rank vs Realized Volatility Ratio Factor
 *
 * Trading Edge:
 * - When IV >> RV (ratio > 1.3): options are expensive → premium collectors short vol,
 *   market makers hedge less aggressively → price pinning behavior.
 * - When IV << RV (ratio < 0.7): options are cheap → breakout expected → expand sell zone.
 * - IV Rank (IVR) places current ATM IV in its 6-month historical percentile context.
 *
 * Formula:
 *   RV_30 = stddev(log(P_t / P_{t-1})) * sqrt(252) [annualized]
 *   IV_atm = OI-weighted ATM implied volatility (nearest expiry)
 *   IV/RV Ratio = IV_atm / RV_30
 *   IVR = (IV_atm - IV_6m_low) / (IV_6m_high - IV_6m_low) * 100
 */
export class IvRvRatioFactor implements PredictiveFactor {
  name = 'IV/RV Ratio (Volatility Premium)';
  bucket = 'OPTIONS' as const;
  correlationGroup = 'IV_STRUCTURE';

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    const { bars, optionsChain, currentPrice } = input;
    if (!bars || bars.length < 30) return null;

    // 1. Compute 30-Day Realized Volatility
    const prices = bars.map(b => b.close);
    const returns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      returns.push(Math.log(prices[i] / prices[i - 1]));
    }

    const recent30 = returns.slice(-30);
    const mean30 = recent30.reduce((a, b) => a + b, 0) / recent30.length;
    const variance30 = recent30.reduce((sum, r) => sum + Math.pow(r - mean30, 2), 0) / (recent30.length - 1);
    const rv30 = Math.sqrt(variance30 * 252); // Annualized realized vol

    if (rv30 <= 0) return null;

    // 2. Compute rolling periodic vols for IVR approximation
    const windowSize = 21;
    const periodicVols: number[] = [];
    for (let i = windowSize; i <= returns.length; i++) {
      const slice = returns.slice(i - windowSize, i);
      const m = slice.reduce((a, b) => a + b, 0) / slice.length;
      const v = slice.reduce((sum, r) => sum + Math.pow(r - m, 2), 0) / (slice.length - 1);
      periodicVols.push(Math.sqrt(v * 252));
    }

    const iv6mHigh = Math.max(...periodicVols);
    const iv6mLow = Math.min(...periodicVols);

    // 3. Get ATM Implied Volatility from options chain
    let atmIV: number | null = null;

    if (optionsChain?.contracts && optionsChain.contracts.length > 0) {
      const nearExpiry = optionsChain.expirations?.[0];
      const nearContracts = optionsChain.contracts.filter(
        c => c.details?.expiration_date === nearExpiry && c.implied_volatility && c.implied_volatility > 0,
      );

      let ivSum = 0;
      let oiSum = 0;
      for (const c of nearContracts) {
        const strike = c.details?.strike_price || 0;
        const oi = c.day?.open_interest || 0;
        const iv = c.implied_volatility || 0;
        if (iv > 0 && oi > 0 && Math.abs(strike - currentPrice) / currentPrice < 0.05) {
          ivSum += iv * oi;
          oiSum += oi;
        }
      }
      if (oiSum > 0) atmIV = ivSum / oiSum;
    }

    const impliedVol = atmIV ?? rv30;

    // 4. Compute IV/RV Ratio and IVR
    const ivRvRatio = impliedVol / rv30;

    const ivRange = iv6mHigh - iv6mLow;
    const ivr = ivRange > 0 ? Math.round(((impliedVol - iv6mLow) / ivRange) * 100) : 50;
    const ivrClamped = Math.max(0, Math.min(100, ivr));

    // 5. Classify signal
    const isExpensive = ivRvRatio > 1.3 || ivrClamped > 80;
    const isCheap = ivRvRatio < 0.7 || ivrClamped < 20;

    let bias: 'bullish' | 'bearish' | 'neutral';
    let reasoning: string;
    let buyTarget: number;
    let sellTarget: number;

    if (isExpensive) {
      bias = 'bearish';
      buyTarget = currentPrice * 0.99;
      sellTarget = currentPrice * 1.015;
      reasoning = `IV/RV Ratio = ${ivRvRatio.toFixed(2)}x (IVR ${ivrClamped}%) — Options EXPENSIVE vs realized vol (RV=${(rv30 * 100).toFixed(1)}%, IV=${(impliedVol * 100).toFixed(1)}%). Premium compression likely → tighter range. Sell vol / mean-reversion bias.`;
    } else if (isCheap) {
      bias = 'bullish';
      buyTarget = currentPrice * 0.975;
      sellTarget = currentPrice * 1.025;
      reasoning = `IV/RV Ratio = ${ivRvRatio.toFixed(2)}x (IVR ${ivrClamped}%) — Options CHEAP vs realized vol (RV=${(rv30 * 100).toFixed(1)}%, IV=${(impliedVol * 100).toFixed(1)}%). Vol expansion likely → directional breakout expected. Expand targets.`;
    } else {
      bias = 'neutral';
      buyTarget = currentPrice * 0.985;
      sellTarget = currentPrice * 1.015;
      reasoning = `IV/RV Ratio = ${ivRvRatio.toFixed(2)}x (IVR ${ivrClamped}%) — IV and RV in equilibrium (RV=${(rv30 * 100).toFixed(1)}%, IV=${(impliedVol * 100).toFixed(1)}%). No vol premium edge detected.`;
    }

    return {
      factorName: this.name,
      buyTarget,
      sellTarget,
      bias,
      weight: 0.20,
      bucket: 'OPTIONS',
      correlationGroup: 'IV_STRUCTURE',
      reasoning,
    };
  }
}
