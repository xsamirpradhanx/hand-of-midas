import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';
import { resolveContractIv, excludeZeroDte } from '../optionsAnalyticsService.js';

/**
 * IV Rank vs Realized Volatility Ratio Factor
 *
 * Trading Edge:
 * - When IV >> RV (ratio > 1.3): options are expensive → premium collectors short vol,
 *   market makers hedge less aggressively → price pinning behavior.
 * - When IV << RV (ratio < 0.7): options are cheap → breakout expected → expand sell zone.
 * - IV-vs-RV percentile places current ATM IV inside the trailing REALIZED vol range.
 *   (This is deliberately not called IV Rank — see the note in evaluate().)
 *
 * Formula:
 *   RV_30 = stddev(log(P_t / P_{t-1})) * sqrt(252) [annualized]
 *   IV_atm = OI-weighted ATM implied volatility (nearest expiry)
 *   IV/RV Ratio = IV_atm / RV_30
 *   IVvsRV%ile = (IV_atm - RV_low) / (RV_high - RV_low) * 100
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

    // 2. Rolling REALIZED vols, used as the reference range below.
    //
    // NOT IV Rank. A true IV Rank places current implied vol inside its own historical
    // *implied* vol range, which needs stored IV history this pipeline does not keep.
    // What is computed here is the percentile of current IV inside the range of trailing
    // *realized* vol — a different quantity that answers "is the option market pricing
    // vol high or low relative to how this name has actually moved". That is a
    // legitimate read, but it was previously labelled "IVR" and the variables named
    // iv6mHigh/iv6mLow, which stated the wrong thing: on WULF it reported "IVR 38%"
    // when 38% was IV's position inside a 69.4%–117.4% realized-vol range.
    const windowSize = 21;
    const realizedVols: number[] = [];
    for (let i = windowSize; i <= returns.length; i++) {
      const slice = returns.slice(i - windowSize, i);
      const m = slice.reduce((a, b) => a + b, 0) / slice.length;
      const v = slice.reduce((sum, r) => sum + Math.pow(r - m, 2), 0) / (slice.length - 1);
      realizedVols.push(Math.sqrt(v * 252));
    }

    const rvHigh = Math.max(...realizedVols);
    const rvLow = Math.min(...realizedVols);

    // 3. Get ATM Implied Volatility from options chain
    let atmIV: number | null = null;

    if (optionsChain?.contracts && optionsChain.contracts.length > 0) {
      // The decision date, not real "now" — resolveContractIv's time-to-expiry
      // measures against real "now" unless told otherwise, and every historical
      // expiry predates that during a backtest/audit (see tradingCalendar.ts).
      const asOf = bars.length ? new Date(bars[bars.length - 1]!.datetime) : undefined;
      // Same-day expirations excluded before picking "near" — see the note on
      // excludeZeroDte in optionsAnalyticsService.ts.
      const tradeableExpirations = optionsChain.expirations ? excludeZeroDte(optionsChain.expirations, asOf) : [];
      const nearExpiry = tradeableExpirations[0];
      // Real IV when the feed reports one, else solved from the EOD close via
      // Black-Scholes inversion (resolveContractIv) — without this, every
      // contract from a feed that doesn't report IV (e.g. the
      // ThetaData-backfilled S3 chains) was excluded before reaching the
      // liquidity filter below, so this factor was unconditionally dead on
      // that data.
      const nearContracts = nearExpiry
        ? optionsChain.contracts.filter(c => c.details?.expiration_date === nearExpiry)
        : [];

      // Pick the strikes actually closest to spot rather than everything inside a
      // fixed ±5% band.
      //
      // A percentage band assumes strike spacing scales with price, which it does not.
      // UWMC at $1.61 has $0.50 strike spacing, so its nearest strikes ($1.50 and
      // $2.00) sit 6.8% and 24% away and the ±5% window caught nothing at all —
      // leaving this factor with no ATM IV on every low-priced name. Taking the two
      // distinct strikes nearest spot is scale-free and brackets the money at any
      // price level.
      const usable = nearContracts
        .map(c => ({ c, iv: resolveContractIv(c, currentPrice, asOf) }))
        .filter(({ c, iv }) => (c.details?.strike_price || 0) > 0 && iv > 0);
      const distinctStrikes = [...new Set(usable.map(({ c }) => c.details!.strike_price as number))]
        .sort((a, b) => Math.abs(a - currentPrice) - Math.abs(b - currentPrice))
        .slice(0, 2);
      const atmStrikes = new Set(distinctStrikes);

      // Weight by open interest when the feed reports it (real standing size);
      // otherwise fall back to volume (today's flow) — same fallback as
      // optionsAnalyticsService's oiWeightedAvgIV, for the same reason.
      let ivSum = 0;
      let weightSum = 0;
      for (const { c, iv } of usable) {
        if (!atmStrikes.has(c.details!.strike_price as number)) continue;
        const weight = c.day?.open_interest ?? c.day?.volume ?? 0;
        if (weight <= 0) continue;
        ivSum += iv * weight;
        weightSum += weight;
      }
      if (weightSum > 0) atmIV = ivSum / weightSum;
    }

    // No usable ATM implied vol means there is nothing to compare realized vol
    // against, and this factor has no reading to give.
    //
    // This previously fell back to `atmIV ?? rv30` — substituting realized vol for
    // implied vol. That makes the ratio exactly 1.00x by construction and prints
    // "IV and RV in equilibrium — Normal volatility environment" as though it were a
    // finding. On UWMC, which has no options chain at all (every other OPTIONS-bucket
    // factor correctly dropped out), it reported "IV/RV Ratio = 1.00x (RV=61.0%,
    // IV=61.0%)" — an implied-vol figure invented from the realized-vol input.
    if (atmIV === null) return null;
    const impliedVol = atmIV;

    // 4. Compute IV/RV Ratio and the IV-vs-realized percentile
    const ivRvRatio = impliedVol / rv30;

    const rvRange = rvHigh - rvLow;
    const ivPctile = rvRange > 0 ? Math.round(((impliedVol - rvLow) / rvRange) * 100) : 50;
    const ivPctileClamped = Math.max(0, Math.min(100, ivPctile));

    // 5. Classify signal
    const isExpensive = ivRvRatio > 1.3 || ivPctileClamped > 80;
    const isCheap = ivRvRatio < 0.7 || ivPctileClamped < 20;

    let bias: 'bullish' | 'bearish' | 'neutral' = 'neutral';
    let reasoning: string;
    let buyTarget: number;
    let sellTarget: number;

    if (isExpensive) {
      buyTarget = currentPrice * 0.99;
      sellTarget = currentPrice * 1.015;
      reasoning = `IV/RV Ratio = ${ivRvRatio.toFixed(2)}x (IV sits at the ${ivPctileClamped}th pct of trailing realized vol) — Options EXPENSIVE vs realized vol (RV=${(rv30 * 100).toFixed(1)}%, IV=${(impliedVol * 100).toFixed(1)}%). Premium compression expected → pinning / range-bound behavior.`;
    } else if (isCheap) {
      buyTarget = currentPrice * 0.975;
      sellTarget = currentPrice * 1.025;
      reasoning = `IV/RV Ratio = ${ivRvRatio.toFixed(2)}x (IV sits at the ${ivPctileClamped}th pct of trailing realized vol) — Options CHEAP vs realized vol (RV=${(rv30 * 100).toFixed(1)}%, IV=${(impliedVol * 100).toFixed(1)}%). Volatility expansion likely → potential breakout / range widening (non-directional).`;
    } else {
      buyTarget = currentPrice * 0.985;
      sellTarget = currentPrice * 1.015;
      reasoning = `IV/RV Ratio = ${ivRvRatio.toFixed(2)}x (IV sits at the ${ivPctileClamped}th pct of trailing realized vol) — IV and RV in equilibrium (RV=${(rv30 * 100).toFixed(1)}%, IV=${(impliedVol * 100).toFixed(1)}%). Normal volatility environment.`;
    }

    return {
      factorName: this.name,
      buyTarget,
      sellTarget,
      bias,
      // Volatility-premium read: every branch above is expensive/cheap/equilibrium,
      // none of which implies a direction (the "cheap" branch says so outright).
      // `bias` is declared `let` here but never reassigned. See
      // FactorResult.directional.
      directional: false,
      weight: 0.20,
      bucket: 'OPTIONS',
      correlationGroup: 'IV_STRUCTURE',
      reasoning,
    };
  }
}
