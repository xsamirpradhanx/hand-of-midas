import { describe, it, expect } from 'vitest';
import { RelativeMomentumFactor, RELATIVE_MOMENTUM_MIN_BARS } from './relativeMomentum.js';
import type { FactorInput } from './types.js';
import type { OHLCVDataPoint } from '../../types.js';

const DAY = 86_400_000;

/** A series compounding at a constant daily rate, so its window return is exact. */
function series(n: number, dailyLogReturn: number, start = 100): OHLCVDataPoint[] {
  const out: OHLCVDataPoint[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    out.push({
      datetime: new Date(Date.parse('2020-01-02') + i * DAY).toISOString(),
      open: p, high: p * 1.01, low: p * 0.99, close: p, volume: 1e6,
    } as OHLCVDataPoint);
    p *= Math.exp(dailyLogReturn);
  }
  return out;
}

const N = RELATIVE_MOMENTUM_MIN_BARS + 10;
const factor = new RelativeMomentumFactor();
const evaluate = (own: OHLCVDataPoint[], bench?: OHLCVDataPoint[]) =>
  factor.evaluate({
    symbol: 'TEST', currentPrice: own[own.length - 1].close, bars: own, benchmarkBars: bench,
  } as FactorInput);

describe('RelativeMomentumFactor', () => {
  it('votes bullish when the symbol clearly outperformed the benchmark', async () => {
    const r = await evaluate(series(N, 0.001), series(N, 0));
    expect(r?.bias).toBe('bullish');
    expect(r?.reasoning).toMatch(/outperformed/);
  });

  it('votes bearish when it clearly underperformed', async () => {
    const r = await evaluate(series(N, -0.001), series(N, 0));
    expect(r?.bias).toBe('bearish');
    expect(r?.reasoning).toMatch(/underperformed/);
  });

  /**
   * The point of the whole construction. A name up 30% in a market up 30% has
   * no relative strength and the factor must say so. Plain momentum would call
   * this strongly bullish — and plain momentum, once z-scored into a form a
   * single-symbol factor can actually compute, measured as noise.
   */
  it('is neutral when the symbol merely kept pace with a rising market', async () => {
    const r = await evaluate(series(N, 0.001), series(N, 0.001));
    expect(r?.bias).toBe('neutral');
  });

  it('is neutral when both fell together', async () => {
    const r = await evaluate(series(N, -0.001), series(N, -0.001));
    expect(r?.bias).toBe('neutral');
  });

  it('abstains entirely without a benchmark, rather than reading absolute momentum', async () => {
    expect(await evaluate(series(N, 0.001), undefined)).toBeNull();
  });

  it('abstains when either series is shorter than the lookback', async () => {
    const short = series(RELATIVE_MOMENTUM_MIN_BARS - 1, 0.001);
    expect(await evaluate(short, series(N, 0))).toBeNull();
    expect(await evaluate(series(N, 0.001), short)).toBeNull();
  });

  it('weights a larger relative move more, and stays capped', async () => {
    const mild = await evaluate(series(N, 0.0005), series(N, 0));
    const strong = await evaluate(series(N, 0.004), series(N, 0));
    expect(strong!.weight).toBeGreaterThan(mild!.weight);
    // Capped low on purpose: the measured edge is a fraction of a point.
    expect(strong!.weight).toBeLessThanOrEqual(0.32);
  });

  it('excludes the last month from the window it reads', async () => {
    // Flat for a year, then a sharp run in the final three weeks. The skip month
    // exists precisely so a fresh spike does not register as 12-month momentum —
    // the two horizons carry opposite signs.
    const own = series(N, 0);
    for (let i = own.length - 15; i < own.length; i++) {
      own[i] = { ...own[i], close: own[i].close * 1.4, open: own[i].open * 1.4 };
    }
    const r = await evaluate(own, series(N, 0));
    expect(r?.bias).toBe('neutral');
  });

  it('declares the bucket and correlation group it is grouped by', async () => {
    const r = await evaluate(series(N, 0.001), series(N, 0));
    expect(r?.bucket).toBe('MOMENTUM');
    expect(r?.correlationGroup).toBe('TREND_COMPLEX');
    expect(factor.bucket).toBe(r?.bucket);
  });
});
