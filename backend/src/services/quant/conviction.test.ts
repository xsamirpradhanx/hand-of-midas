import { describe, it, expect } from 'vitest';
import { accuracyEdge, computeConviction, MIN_RESOLVED_FOR_ACCURACY } from './conviction.js';

const many = (wins: number, losses: number) => ({ wins, losses });

describe('accuracyEdge', () => {
  const votes = [
    { factorName: 'good', bias: 'bullish' as const },
    { factorName: 'bad', bias: 'bearish' as const },
  ];

  it('is zero without measured stats, so a cold system behaves as before', () => {
    expect(accuracyEdge(votes, 'bullish', undefined)).toBe(0);
    expect(accuracyEdge(votes, 'bullish', {})).toBe(0);
  });

  it('ignores factors without enough resolved votes rather than guessing', () => {
    const thin = { good: many(2, 1), bad: many(1, 2) };
    expect(accuracyEdge(votes, 'bullish', thin)).toBe(0);
  });

  it('credits an accurate factor that agrees with the plan', () => {
    // 70% accurate, voting the plan's way.
    const m = { good: many(70, 30) };
    expect(accuracyEdge([votes[0]], 'bullish', m)).toBeCloseTo(0.2, 5);
  });

  it('treats a reliably WRONG factor opposing the plan as support for it', () => {
    // This is the whole point: 30% accurate is 70% accurate inverted. Voting
    // bearish against a bullish plan is evidence FOR the plan.
    const m = { bad: many(30, 70) };
    expect(accuracyEdge([votes[1]], 'bullish', m)).toBeCloseTo(0.2, 5);
  });

  it('penalises a reliably wrong factor that AGREES with the plan', () => {
    const m = { bad: many(30, 70) };
    expect(accuracyEdge([{ factorName: 'bad', bias: 'bullish' }], 'bullish', m)).toBeCloseTo(-0.2, 5);
  });

  it('ignores abstentions', () => {
    const m = { n: many(90, 10) };
    expect(accuracyEdge([{ factorName: 'n', bias: 'neutral' }], 'bullish', m)).toBe(0);
  });

  it(`requires at least ${MIN_RESOLVED_FOR_ACCURACY} resolved votes`, () => {
    const just_under = { good: many(20, 9) };   // 29 resolved
    const just_over = { good: many(20, 10) };   // 30 resolved
    expect(accuracyEdge([votes[0]], 'bullish', just_under)).toBe(0);
    expect(accuracyEdge([votes[0]], 'bullish', just_over)).not.toBe(0);
  });
});

describe('computeConviction', () => {
  const base = {
    bullishScore: 1, bearishScore: 0, neutralScore: 1,
    netBias: 1, agreementLevel: 'HIGH' as const, coverage: 1,
  };

  it('stays inside bounds across the input range', () => {
    for (const nb of [-2, -1, 0, 1, 2]) {
      for (const lvl of ['HIGH', 'MODERATE', 'LOW'] as const) {
        const c = computeConviction({ ...base, netBias: nb, agreementLevel: lvl });
        expect(c).toBeGreaterThanOrEqual(0.05);
        expect(c).toBeLessThanOrEqual(0.95);
      }
    }
  });

  it('no longer accepts an accuracy tilt — it measured null and was removed', () => {
    // Guards against the tilt being reintroduced without fresh evidence: it moved
    // conviction separation from t=1.42 to t=1.50 over 5,989 trades.
    const c = computeConviction({ ...base, ...({ accuracyEdge: 0.5 } as any) });
    expect(c).toBe(computeConviction(base));
  });
});
