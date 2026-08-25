import type { BacktestPlan, BacktestStrategy, DecisionContext } from './types.js';

/** Wilder-style ATR over the trailing window, from visible bars only. */
function atr(bars: DecisionContext['bars'], period = 14): number {
  const window = bars.slice(-(period + 1));
  if (window.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < window.length; i++) {
    const p = window[i - 1], c = window[i];
    sum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  return sum / (window.length - 1);
}

// Pseudo-random number generator to keep the run deterministic.
// The engine's R/DD bootstrap resamples rely on deterministic outcomes.
class LCG {
  private state: number;
  constructor(seed: number) { this.state = seed; }
  nextFloat(): number {
    this.state = (this.state * 1664525 + 1013904223) >>> 0;
    return this.state / 4294967296;
  }
}

export class RandomControlStrategy implements BacktestStrategy {
  readonly name = 'random-control';
  private rng = new LCG(42);

  async plan(ctx: DecisionContext): Promise<BacktestPlan | null> {
    const bars = ctx.bars;
    if (bars.length < 2) return null;
    
    // The Composite engine traded 12,286 plans out of 390,733 symbol-bars,
    // which is exactly a 3.144% trading rate.
    // Of those, ~68% were LONG.
    if (this.rng.nextFloat() > 0.03144) {
      return null;
    }

    const isLong = this.rng.nextFloat() < 0.68;
    const spot = bars[bars.length - 1].close;
    const currentAtr = atr(bars);

    // Give it the same nominal 2:1 risk reward profile that the real engine defaults to
    // when it lacks structure (target = atr * 2, stop = atr * 1).
    let target, stop;
    if (isLong) {
      target = spot + currentAtr * 2.0;
      stop = spot - currentAtr * 1.0;
    } else {
      target = spot - currentAtr * 2.0;
      stop = spot + currentAtr * 1.0;
    }

    return {
      bias: isLong ? 'LONG' : 'SHORT',
      entry: spot,
      stop,
      target,
      setupKey: 'RANDOM|' + (isLong ? 'LONG' : 'SHORT'),
      atr: currentAtr,
      conviction: 0.5,
      sizeMultiplier: 1.0,
      coverage: 1.0,
    };
  }
}
