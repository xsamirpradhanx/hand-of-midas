import { describe, it, expect } from 'vitest';
import { computeSizing, directionTilt, MIN_SIZE, MAX_SIZE, MAX_DIRECTION_TILT } from './positionSizing.js';

/** A record with a given accuracy in each direction — see conviction.test.ts. */
const acc = (bullAcc: number, bearAcc: number, perSide = 100) => {
  const bullishWins = Math.round(bullAcc * perSide);
  const bearishWins = Math.round(bearAcc * perSide);
  return {
    wins: bullishWins + bearishWins,
    losses: 2 * perSide - bullishWins - bearishWins,
    bullishVotes: perSide, bullishWins,
    bearishVotes: perSide, bearishWins,
  };
};

describe('computeSizing', () => {
  it('sizes at baseline when nothing has a track record', () => {
    const s = computeSizing([{ factorName: 'a', bias: 'bullish' }], 'bullish', undefined);
    expect(s.sizeMultiplier).toBe(1);
    expect(s.contributingFactors).toBe(0);
    expect(s.rationale).toMatch(/no factor has enough graded history/i);
  });

  it('sizes up when accurate factors back the plan', () => {
    const s = computeSizing(
      [{ factorName: 'good', bias: 'bullish' }], 'bullish', { good: acc(0.7, 0.7) },
    );
    expect(s.sizeMultiplier).toBeGreaterThan(1);
    expect(s.edge).toBeCloseTo(0.2, 3);
  });

  it('sizes up when a reliably WRONG factor opposes the plan', () => {
    // The asymmetry the whole signal rests on: 30% accurate is 70% inverted.
    const s = computeSizing(
      [{ factorName: 'bad', bias: 'bearish' }], 'bullish', { bad: acc(0.3, 0.3) },
    );
    expect(s.sizeMultiplier).toBeGreaterThan(1);
  });

  it('sizes down when a reliably wrong factor agrees with the plan', () => {
    const s = computeSizing(
      [{ factorName: 'bad', bias: 'bullish' }], 'bullish', { bad: acc(0.3, 0.3) },
    );
    expect(s.sizeMultiplier).toBeLessThan(1);
  });

  it('never sizes to zero, because the weak bucket still earns', () => {
    const s = computeSizing(
      [{ factorName: 'awful', bias: 'bullish' }], 'bullish', { awful: acc(0, 0) },
    );
    expect(s.sizeMultiplier).toBe(MIN_SIZE);
    expect(s.sizeMultiplier).toBeGreaterThan(0);
  });

  it('caps size, because the edge is an estimate', () => {
    const s = computeSizing(
      [{ factorName: 'perfect', bias: 'bullish' }], 'bullish', { perfect: acc(1, 1) },
    );
    expect(s.sizeMultiplier).toBe(MAX_SIZE);
  });

  it('ignores a one-sided factor, whose accuracy cannot be told from the drift', () => {
    const s = computeSizing(
      [{ factorName: 'onesided', bias: 'bullish' }], 'bullish',
      { onesided: { wins: 320, losses: 85, bullishVotes: 400, bullishWins: 318, bearishVotes: 5, bearishWins: 2 } },
    );
    expect(s.sizeMultiplier).toBe(1);
    expect(s.contributingFactors).toBe(0);
  });

  it('ignores factors without enough resolved votes', () => {
    const s = computeSizing(
      [{ factorName: 'thin', bias: 'bullish' }], 'bullish', { thin: acc(0.8, 0.8, 4) },
    );
    expect(s.sizeMultiplier).toBe(1);
    expect(s.contributingFactors).toBe(0);
  });

  it('states its reasoning in terms a person can check', () => {
    const s = computeSizing(
      [{ factorName: 'good', bias: 'bullish' }], 'bullish', { good: acc(0.65, 0.65) },
    );
    expect(s.rationale).toMatch(/1 factor with graded history support/);
    expect(s.rationale).toMatch(/size .+x/);
  });
});

describe('directionTilt', () => {
  const stats = { LONG: { n: 500, sumR: 96.5 }, SHORT: { n: 500, sumR: 36.0 } }; // +0.193R vs +0.072R

  it('sizes the better-performing direction up and the other down, symmetrically', () => {
    const long = directionTilt('bullish', stats);
    const short = directionTilt('bearish', stats);
    expect(long).toBeGreaterThan(0);
    expect(short).toBeCloseTo(-long, 12);
    expect(long).toBeCloseTo((96.5 / 500 - 36.0 / 500) / 2, 12);
  });

  it('caps the tilt well below what the raw gap would justify', () => {
    const extreme = { LONG: { n: 500, sumR: 1000 }, SHORT: { n: 500, sumR: -1000 } };
    expect(directionTilt('bullish', extreme)).toBe(MAX_DIRECTION_TILT);
    expect(directionTilt('bearish', extreme)).toBe(-MAX_DIRECTION_TILT);
  });

  it('stays silent until both directions have enough trades', () => {
    expect(directionTilt('bullish', { LONG: { n: 500, sumR: 96.5 }, SHORT: { n: 5, sumR: 1 } })).toBe(0);
    expect(directionTilt('bullish', { LONG: { n: 500, sumR: 96.5 } })).toBe(0);
    expect(directionTilt('bullish', undefined)).toBe(0);
  });

  it('is zero when the two directions perform alike', () => {
    expect(directionTilt('bullish', { LONG: { n: 500, sumR: 50 }, SHORT: { n: 500, sumR: 50 } })).toBe(0);
  });

  /**
   * The regression that motivated making this explicit. The old sizing signal
   * produced a +0.167x LONG-over-SHORT tilt nobody designed, as a side effect of
   * scoring factors by raw accuracy in a market that drifts up. The tilt is now
   * a stated term, so it appears in the output and can be switched off.
   */
  it('reports the tilt separately from factor skill', () => {
    const s = computeSizing([{ factorName: 'x', bias: 'bullish' }], 'bullish', undefined, stats);
    expect(s.edge).toBe(0);
    expect(s.directionTilt).toBeGreaterThan(0);
    expect(s.sizeMultiplier).toBeGreaterThan(1);
    expect(s.rationale).toMatch(/this direction has historically earned more/i);
  });

  it('tilts on the direction actually traded, not the plurality of factor votes', () => {
    // Factors lean bullish, but the plan that would be executed is a SHORT.
    // The measured expectancy applies to the executed direction.
    const s = computeSizing([{ factorName: 'x', bias: 'bullish' }], 'bullish', undefined, stats, 'SHORT');
    expect(s.directionTilt).toBeLessThan(0);
    expect(s.sizeMultiplier).toBeLessThan(1);
  });

  it('applies no tilt to a NO TRADE plan', () => {
    const s = computeSizing([{ factorName: 'x', bias: 'bullish' }], 'bullish', undefined, stats, 'NO TRADE');
    expect(s.directionTilt).toBe(0);
    expect(s.sizeMultiplier).toBe(1);
  });
});
