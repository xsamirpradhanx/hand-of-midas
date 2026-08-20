import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';

interface Bar {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp?: number | string;
}

export class AsymmetricKinematicEfficiencyFactor implements PredictiveFactor {
  name = 'Asymmetric Kinematic Efficiency';
  bucket = 'MOMENTUM' as const;
  correlationGroup = 'AI_MICROSTRUCTURE';

  private readonly minBarsRequired = 24;
  private readonly shortWindow = 6;
  private readonly longWindow = 20;

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    const bars = input.bars as Bar[] | undefined;
    const currentPrice = input.currentPrice;

    if (!bars || bars.length < this.minBarsRequired || !currentPrice || currentPrice <= 0) {
      return null;
    }

    const recentBars = bars.slice(-this.longWindow);
    const n = recentBars.length;

    // 1. Calculate Multi-Period Kinematic Efficiency Ratio (KER)
    // Displacement / Total Path Length weighted by volume friction
    let totalPath = 0;
    let volumeWeightedPath = 0;
    let totalVolume = 0;

    for (let i = 1; i < n; i++) {
      const prev = recentBars[i - 1];
      const curr = recentBars[i];
      const trueRange = Math.max(
        curr.high - curr.low,
        Math.abs(curr.high - prev.close),
        Math.abs(curr.low - prev.close)
      );

      totalPath += trueRange;
      const v = Math.max(curr.volume, 1);
      volumeWeightedPath += trueRange * v;
      totalVolume += v;
    }

    // HAND-FIXED AFTER GENERATION: anchored on recentBars[0].OPEN while the
    // true-range loop above starts at i = 1, so bar 0's own range never entered
    // totalPath. The numerator spanned 20 bars of travel, the denominator 19,
    // and bar 0's entire body was free displacement with no matching path cost
    // — making the documented [-1, 1] bound below false (real bound:
    // ±(1 + |body(bar0)| / totalPath)).
    //
    // That matters because the weighting at the bottom of this file is
    // `absSignal * 0.35`, calibrated so |composite| = 1 maps exactly to the
    // engine's 0.35 ceiling. Reproduced: an earnings-gap bar sitting at index 0
    // of the trailing-20 window gave KER = 3.5, composite = 1.42 and a
    // maximum-weight bullish vote on a gap 19 bars stale and fully digested,
    // with both confirmation terms contributing exactly zero. They cannot
    // rescue it either — orderFlowImbalance is bounded [-1,1] and acceleration
    // passes through tanh, so their combined opposing weight caps at 0.6.
    // Every symbol with an earnings gap hits this on exactly one session.
    //
    // Anchoring on close[0] is provably bounded: close[n-1] - close[0] telescopes
    // to Σ(close_i - close_{i-1}), and |close_i - close_{i-1}| <= TR_i, so
    // |netDisplacement| <= totalPath and |KER| <= 1 by construction.
    const netDisplacement = recentBars[n - 1].close - recentBars[0].close;
    const avgVolume = totalVolume / (n - 1);
    const normalizedVwPath = volumeWeightedPath / (avgVolume || 1);

    if (totalPath === 0 || normalizedVwPath === 0) {
      return {
        factorName: this.name,
        bias: 'neutral',
        weight: 0,
        bucket: this.bucket,
        correlationGroup: this.correlationGroup,
        reasoning: 'Insufficient price path dispersion to calculate kinematic efficiency.'
      };
    }

    // Now genuinely bounded to [-1, 1] — see the close-anchor proof above.
    const kinematicEfficiency = netDisplacement / totalPath;

    // 2. Microstructure Wick Absorption Ratio (Buying vs Selling Friction)
    let bullEffort = 0;
    let bearEffort = 0;

    for (let i = Math.max(0, n - this.shortWindow); i < n; i++) {
      const b = recentBars[i];
      const barRange = Math.max(b.high - b.low, 1e-6);
      const upperWick = b.high - Math.max(b.open, b.close);
      const lowerWick = Math.min(b.open, b.close) - b.low;
      const body = Math.abs(b.close - b.open);

      // Volume attributed to aggressive absorption at structural extremities
      const upperAbsorption = (upperWick / barRange) * b.volume;
      const lowerAbsorption = (lowerWick / barRange) * b.volume;

      if (b.close >= b.open) {
        bullEffort += (body / barRange) * b.volume + lowerAbsorption;
        bearEffort += upperAbsorption;
      } else {
        bearEffort += (body / barRange) * b.volume + upperAbsorption;
        bullEffort += lowerAbsorption;
      }
    }

    const totalEffort = bullEffort + bearEffort;
    const orderFlowImbalance = totalEffort > 0 ? (bullEffort - bearEffort) / totalEffort : 0; // [-1, 1]

    // 3. Kinetic Acceleration: Short-window vs Long-window Velocity
    const shortDisplacement = recentBars[n - 1].close - recentBars[n - this.shortWindow].open;
    const shortVelocity = shortDisplacement / this.shortWindow;
    const longVelocity = netDisplacement / this.longWindow;
    const accelerationRatio = longVelocity !== 0 ? shortVelocity / Math.abs(longVelocity) : 0;

    // 4. Synthesize Composite Vector
    // Signal strengthens when Kinematic Efficiency aligns with short-term order flow imbalance and positive acceleration
    const compositeSignal = (kinematicEfficiency * 0.4) + (orderFlowImbalance * 0.4) + (Math.tanh(accelerationRatio) * 0.2);
    const absSignal = Math.abs(compositeSignal);

    // Compute ATR for dynamic target projections
    const lastBar = recentBars[n - 1];
    const prevBar = recentBars[n - 2];
    const atr = Math.max(
      lastBar.high - lastBar.low,
      Math.abs(lastBar.high - prevBar.close),
      Math.abs(lastBar.low - prevBar.close)
    );

    // Strict ceiling clamp of weight <= 0.35
    const baseWeight = Math.min(0.35, absSignal * 0.35);

    if (absSignal < 0.15) {
      return {
        factorName: this.name,
        bias: 'neutral',
        weight: 0,
        bucket: this.bucket,
        correlationGroup: this.correlationGroup,
        reasoning: `Kinematic efficiency is within equilibrium threshold (${compositeSignal.toFixed(3)}). No directional breakout confirmed.`
      };
    }

    const isBullish = compositeSignal > 0;
    const bias: 'bullish' | 'bearish' = isBullish ? 'bullish' : 'bearish';
    const dynamicOffset = Math.max(atr * 1.5, currentPrice * 0.008);

    // HAND-FIXED AFTER GENERATION: the model emitted these inverted on the
    // bullish branch (buyTarget above spot, sellTarget below), violating the
    // documented contract that buyTarget is the SUPPORT level. Measured live on
    // 3/8 symbols; every hand-written factor was clean.
    //
    // Currently LATENT rather than active: compositeScore.ts:342 gates zone
    // clustering on `bucket === 'PRICE_STRUCTURE' || PRICE_LOCATION_FACTOR_NAMES
    // .some(...)`, and this factor is MOMENTUM and matches no name, so its
    // targets are skipped before clustering. It would become live the moment
    // this factor's bucket changed or its name were added to that list.
    //
    // buyTarget is the SUPPORT/entry level and must always be the lower of the
    // two. The bearish branch was already correct and keeps its asymmetry
    // (a wider downside objective than the upside stop).
    const lowerLevel = isBullish
      ? currentPrice - dynamicOffset * 0.8
      : currentPrice - dynamicOffset * 1.5;

    const upperLevel = isBullish
      ? currentPrice + dynamicOffset
      : currentPrice + dynamicOffset * 0.8;

    const buyTarget = Number(lowerLevel.toFixed(4));
    const sellTarget = Number(upperLevel.toFixed(4));

    return {
      factorName: this.name,
      bias,
      weight: Math.min(0.35, Math.max(0.05, baseWeight)),
      bucket: this.bucket,
      correlationGroup: this.correlationGroup,
      reasoning: `Kinematic Efficiency: ${kinematicEfficiency.toFixed(2)}, Order Flow Imbalance: ${(orderFlowImbalance * 100).toFixed(1)}%, Acceleration: ${accelerationRatio.toFixed(2)}. ${isBullish ? 'Low-friction upward glide path detected' : 'Overhead absorption and downward displacement acceleration detected'}.`,
      buyTarget,
      sellTarget
    };
  }
}
