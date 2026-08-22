import { describe, it, expect } from 'vitest';
import {
  accuracyEdge, computeConviction, informedness,
  MIN_RESOLVED_FOR_ACCURACY, MIN_PER_DIRECTION,
} from './conviction.js';

/**
 * A factor record with a given accuracy in EACH direction.
 *
 * Fixtures have to carry the direction split now, because a pooled hit rate is
 * no longer scorable on its own — that was the defect. `bullAcc` is how often
 * the factor is right when it says bullish, `bearAcc` when it says bearish.
 */
const factor = (bullAcc: number, bearAcc: number, votesPerSide = 100) => {
  const bullishWins = Math.round(bullAcc * votesPerSide);
  const bearishWins = Math.round(bearAcc * votesPerSide);
  return {
    wins: bullishWins + bearishWins,
    losses: 2 * votesPerSide - bullishWins - bearishWins,
    bullishVotes: votesPerSide, bullishWins,
    bearishVotes: votesPerSide, bearishWins,
  };
};

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
    const thin = { good: factor(0.7, 0.7, 2), bad: factor(0.3, 0.3, 2) };
    expect(accuracyEdge(votes, 'bullish', thin)).toBe(0);
  });

  it('credits an accurate factor that agrees with the plan', () => {
    // Right 70% of the time in BOTH directions: informedness +0.2.
    const m = { good: factor(0.7, 0.7) };
    expect(accuracyEdge([votes[0]], 'bullish', m)).toBeCloseTo(0.2, 5);
  });

  it('treats a reliably WRONG factor opposing the plan as support for it', () => {
    // 30% right in both directions is 70% right inverted, so a bearish vote
    // against a bullish plan is evidence FOR the plan.
    const m = { bad: factor(0.3, 0.3) };
    expect(accuracyEdge([votes[1]], 'bullish', m)).toBeCloseTo(0.2, 5);
  });

  it('penalises a reliably wrong factor that AGREES with the plan', () => {
    const m = { bad: factor(0.3, 0.3) };
    expect(accuracyEdge([{ factorName: 'bad', bias: 'bullish' }], 'bullish', m)).toBeCloseTo(-0.2, 5);
  });

  it('ignores abstentions', () => {
    const m = { n: factor(0.9, 0.9) };
    expect(accuracyEdge([{ factorName: 'n', bias: 'neutral' }], 'bullish', m)).toBe(0);
  });

  it(`requires at least ${MIN_RESOLVED_FOR_ACCURACY} resolved votes`, () => {
    const just_under = { good: factor(0.7, 0.7, 14) };  // 28 resolved
    const just_over = { good: factor(0.7, 0.7, 15) };   // 30 resolved
    expect(accuracyEdge([votes[0]], 'bullish', just_under)).toBe(0);
    expect(accuracyEdge([votes[0]], 'bullish', just_over)).not.toBe(0);
  });

  /**
   * The regression this whole metric exists for.
   *
   * Under the old `accuracy - 0.5` term these three records score -0.06, 0 and
   * +0.06 respectively, purely because of how often they voted long against a
   * market that rose 56% of the time. None of them knows anything: in every one
   * P(up | bullish) equals P(up | bearish) equals the base rate.
   */
  it('scores a factor that only tracks the drift at zero, whatever its vote mix', () => {
    // Three factors, none of which knows anything: in each one
    // P(up | bullish) = P(up | bearish) = the 56% base rate. They differ only
    // in how often they choose to vote long.
    const upRate = 0.56;
    const uninformed = (longShare: number) => {
      const bullishVotes = 1000 * longShare;
      const bearishVotes = 1000 - bullishVotes;
      const bullishWins = bullishVotes * upRate;              // right when it rises
      const bearishWins = bearishVotes * (1 - upRate);        // right when it falls
      return {
        wins: bullishWins + bearishWins, losses: 1000 - bullishWins - bearishWins,
        bullishVotes, bullishWins, bearishVotes, bearishWins,
      };
    };
    const mixes = [0.25, 0.5, 0.9].map(uninformed);
    const rawAccuracies = mixes.map(m => m.wins / (m.wins + m.losses));
    const edges = mixes.map(m => accuracyEdge([{ factorName: 'f', bias: 'bullish' }], 'bullish', { f: m }));

    // Raw accuracy is 0.44 + 0.12*longShare here, so the three land 7.8 points
    // apart — 47.0%, 50.0%, 54.8% — entirely from the vote mix. That spread is
    // exactly what the old `accuracy - 0.5` term was reading as skill.
    rawAccuracies.forEach((a, i) => expect(a).toBeCloseTo([0.47, 0.5, 0.548][i], 10));
    expect(Math.max(...rawAccuracies) - Math.min(...rawAccuracies)).toBeGreaterThan(0.07);
    // Informedness sees all three for what they are.
    for (const e of edges) expect(e).toBeCloseTo(0, 10);
  });

  it(`needs ${MIN_PER_DIRECTION} votes in EACH direction, not just overall`, () => {
    // 400 bullish votes and 5 bearish: plenty of history, no usable estimate of
    // what a bearish vote from this factor means.
    const oneSided = {
      f: { wins: 300, losses: 105, bullishVotes: 400, bullishWins: 298, bearishVotes: 5, bearishWins: 2 },
    };
    expect(informedness(oneSided.f)).toBeNull();
    expect(accuracyEdge([{ factorName: 'f', bias: 'bullish' }], 'bullish', oneSided)).toBe(0);
  });

  it('is blind to a record with no direction split at all', () => {
    // Stats written before the split existed. Treated as no track record rather
    // than scored with the metric that was wrong.
    const legacy = { f: { wins: 70, losses: 30 } };
    expect(informedness(legacy.f)).toBeNull();
    expect(accuracyEdge([{ factorName: 'f', bias: 'bullish' }], 'bullish', legacy)).toBe(0);
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
