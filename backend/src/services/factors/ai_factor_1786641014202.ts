import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';

/**
 * Fractal Efficiency Liquidity Sweep (FELS) Factor
 *
 * Combines Kaufman Efficiency Ratio (KER), Relative Volume Intensity,
 * and Microstructure Liquidity Sweep detection to identify high-probability
 * institutional absorption traps (mean-reversion) and true liquidity vacuum breakouts (trend).
 */
export class FractalEfficiencyLiquiditySweepFactor implements PredictiveFactor {
  name = 'Fractal Efficiency Liquidity Sweep';

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    const { bars, currentPrice } = input;

    // Require at least 40 periods of historical OHLCV data
    if (!bars || bars.length < 40) {
      return null;
    }

    const price = currentPrice ?? bars[bars.length - 1].close;
    const lookback = 20;
    const kerPeriod = 10;
    const len = bars.length;

    // 1. Calculate Kaufman Efficiency Ratio (KER) over kerPeriod
    // KER = |Net Change| / Sum of Absolute Bar-to-Bar Changes
    const netChange = Math.abs(bars[len - 1].close - bars[len - 1 - kerPeriod].close);
    let pathSum = 0;
    for (let i = len - kerPeriod; i < len; i++) {
      pathSum += Math.abs(bars[i].close - bars[i - 1].close);
    }
    const ker = pathSum > 0 ? netChange / pathSum : 0;

    // 2. Compute Relative Volume (RVOL) against 20-period SMA
    let volSum = 0;
    for (let i = len - 1 - lookback; i < len - 1; i++) {
      volSum += bars[i].volume;
    }
    const avgVol = volSum / lookback;
    const currentVol = bars[len - 1].volume;
    const rvol = avgVol > 0 ? currentVol / avgVol : 1.0;

    // 3. Compute Average True Range (ATR-14)
    let atrSum = 0;
    for (let i = len - 14; i < len; i++) {
      const tr = Math.max(
        bars[i].high - bars[i].low,
        Math.abs(bars[i].high - bars[i - 1].close),
        Math.abs(bars[i].low - bars[i - 1].close)
      );
      atrSum += tr;
    }
    const atr = atrSum / 14;

    // 4. Identify Liquidity Boundaries (Prior 20-bar Max/Min excluding current bar)
    let highestHigh = -Infinity;
    let lowestLow = Infinity;
    for (let i = len - 1 - lookback; i < len - 1; i++) {
      if (bars[i].high > highestHigh) highestHigh = bars[i].high;
      if (bars[i].low < lowestLow) lowestLow = bars[i].low;
    }

    const currentBar = bars[len - 1];
    const isSweepingHigh = currentBar.high > highestHigh;
    const isSweepingLow = currentBar.low < lowestLow;
    const barRange = currentBar.high - currentBar.low;
    const closeRelativePos = barRange > 0 ? (currentBar.close - currentBar.low) / barRange : 0.5;

    // 5. Evaluate Microstructure Dynamics
    // Scenario A: Bullish Absorption Sweep (Institutional Trap of Short Sellers)
    // Price sweeps previous low, volume spikes, but fractal efficiency is low (choppy absorption)
    // and close recovers into upper half of the bar.
    if (isSweepingLow && rvol >= 1.6 && ker < 0.40 && closeRelativePos > 0.55) {
      const weight = Math.min(0.92, 0.65 + (rvol - 1.6) * 0.1 + (0.40 - ker) * 0.5);
      const stopLevel = Math.min(currentBar.low, price - atr * 0.8);
      const targetLevel = price + atr * 2.5;

      return {
        factorName: this.name,
        bias: 'bullish',
        weight: Number(weight.toFixed(2)),
        reasoning: `Bullish Liquidity Absorption Sweep detected. Swept 20-bar low (${lowestLow.toFixed(2)}) on high RVOL (${rvol.toFixed(2)}x) with low Fractal Efficiency (KER: ${ker.toFixed(2)}), signaling heavy limit-order absorption.`,
        buyTarget: Number((price * 0.9985).toFixed(4)),
        sellTarget: Number(targetLevel.toFixed(4)),
      };
    }

    // Scenario B: Bearish Absorption Sweep (Institutional Trap of Longs)
    // Price sweeps previous high, volume spikes, fractal efficiency is low, close drops into lower half.
    if (isSweepingHigh && rvol >= 1.6 && ker < 0.40 && closeRelativePos < 0.45) {
      const weight = Math.min(0.92, 0.65 + (rvol - 1.6) * 0.1 + (0.40 - ker) * 0.5);
      const targetLevel = price - atr * 2.5;

      return {
        factorName: this.name,
        bias: 'bearish',
        weight: Number(weight.toFixed(2)),
        reasoning: `Bearish Liquidity Absorption Sweep detected. Swept 20-bar high (${highestHigh.toFixed(2)}) on high RVOL (${rvol.toFixed(2)}x) with low Fractal Efficiency (KER: ${ker.toFixed(2)}), signaling institutional distribution.`,
        buyTarget: Number(targetLevel.toFixed(4)),
        sellTarget: Number((price * 1.0015).toFixed(4)),
      };
    }

    // Scenario C: Bullish Liquidity Vacuum Breakout (High KER + High Volume Expansion)
    if (isSweepingHigh && ker > 0.72 && rvol >= 1.4 && closeRelativePos > 0.75) {
      const weight = Math.min(0.88, 0.60 + (ker - 0.72) * 0.8);
      return {
        factorName: this.name,
        bias: 'bullish',
        weight: Number(weight.toFixed(2)),
        reasoning: `Bullish Liquidity Vacuum Breakout. Strong directional trend efficiency (KER: ${ker.toFixed(2)}) clearing major high (${highestHigh.toFixed(2)}) with expanding volume (${rvol.toFixed(2)}x).`,
        buyTarget: Number(price.toFixed(4)),
        sellTarget: Number((price + atr * 3.0).toFixed(4)),
      };
    }

    // Scenario D: Bearish Liquidity Vacuum Breakdown (High KER + High Volume Expansion)
    if (isSweepingLow && ker > 0.72 && rvol >= 1.4 && closeRelativePos < 0.25) {
      const weight = Math.min(0.88, 0.60 + (ker - 0.72) * 0.8);
      return {
        factorName: this.name,
        bias: 'bearish',
        weight: Number(weight.toFixed(2)),
        reasoning: `Bearish Liquidity Vacuum Breakdown. High structural trend efficiency (KER: ${ker.toFixed(2)}) slicing below support (${lowestLow.toFixed(2)}) with volume confirmation (${rvol.toFixed(2)}x).`,
        buyTarget: Number((price - atr * 3.0).toFixed(4)),
        sellTarget: Number(price.toFixed(4)),
      };
    }

    // Default: Neutral signal if no actionable edge conditions met
    return {
      factorName: this.name,
      bias: 'neutral',
      weight: 0.10,
      reasoning: `No structural liquidity sweep or efficiency divergence detected. Current KER: ${ker.toFixed(2)}, RVOL: ${rvol.toFixed(2)}. Market is in equilibrium.`,
    };
  }
}
