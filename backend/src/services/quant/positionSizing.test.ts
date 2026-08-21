import { describe, it, expect } from 'vitest';
import { computeSizing, MIN_SIZE, MAX_SIZE } from './positionSizing.js';

const acc = (w: number, l: number) => ({ wins: w, losses: l });

describe('computeSizing', () => {
  it('sizes at baseline when nothing has a track record', () => {
    const s = computeSizing([{ factorName: 'a', bias: 'bullish' }], 'bullish', undefined);
    expect(s.sizeMultiplier).toBe(1);
    expect(s.contributingFactors).toBe(0);
    expect(s.rationale).toMatch(/no factor has enough graded history/i);
  });

  it('sizes up when accurate factors back the plan', () => {
    const s = computeSizing(
      [{ factorName: 'good', bias: 'bullish' }], 'bullish', { good: acc(70, 30) },
    );
    expect(s.sizeMultiplier).toBeGreaterThan(1);
    expect(s.edge).toBeCloseTo(0.2, 3);
  });

  it('sizes up when a reliably WRONG factor opposes the plan', () => {
    // The asymmetry the whole signal rests on: 30% accurate is 70% inverted.
    const s = computeSizing(
      [{ factorName: 'bad', bias: 'bearish' }], 'bullish', { bad: acc(30, 70) },
    );
    expect(s.sizeMultiplier).toBeGreaterThan(1);
  });

  it('sizes down when a reliably wrong factor agrees with the plan', () => {
    const s = computeSizing(
      [{ factorName: 'bad', bias: 'bullish' }], 'bullish', { bad: acc(30, 70) },
    );
    expect(s.sizeMultiplier).toBeLessThan(1);
  });

  it('never sizes to zero, because the weak bucket still earns', () => {
    const s = computeSizing(
      [{ factorName: 'awful', bias: 'bullish' }], 'bullish', { awful: acc(0, 200) },
    );
    expect(s.sizeMultiplier).toBe(MIN_SIZE);
    expect(s.sizeMultiplier).toBeGreaterThan(0);
  });

  it('caps size, because the edge is an estimate', () => {
    const s = computeSizing(
      [{ factorName: 'perfect', bias: 'bullish' }], 'bullish', { perfect: acc(200, 0) },
    );
    expect(s.sizeMultiplier).toBe(MAX_SIZE);
  });

  it('ignores factors without enough resolved votes', () => {
    const s = computeSizing(
      [{ factorName: 'thin', bias: 'bullish' }], 'bullish', { thin: acc(8, 1) },
    );
    expect(s.sizeMultiplier).toBe(1);
    expect(s.contributingFactors).toBe(0);
  });

  it('states its reasoning in terms a person can check', () => {
    const s = computeSizing(
      [{ factorName: 'good', bias: 'bullish' }], 'bullish', { good: acc(65, 35) },
    );
    expect(s.rationale).toMatch(/1 factor with graded history support/);
    expect(s.rationale).toMatch(/size .+x/);
  });
});
