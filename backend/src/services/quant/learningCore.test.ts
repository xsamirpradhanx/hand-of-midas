import { describe, it, expect } from 'vitest';
import {
  factorVote,
  directionalScore,
  decayStats,
  observe,
  emptyStats,
  expectancy,
  winRate,
  breakEvenWinRate,
  factorWeightMultiplier,
  calibrate,
  DEFAULT_HALF_LIFE_DAYS,
} from './learningCore.js';

const T0 = '2026-01-01T00:00:00.000Z';
const days = (n: number) => new Date(Date.parse(T0) + n * 86_400_000).toISOString();

describe('factorVote — credit assignment', () => {
  it('credits a factor only when it took the same side as the trade', () => {
    expect(factorVote('bullish', 'LONG')).toBe('AGREE');
    expect(factorVote('bearish', 'LONG')).toBe('DISAGREE');
    expect(factorVote('bearish', 'SHORT')).toBe('AGREE');
    expect(factorVote('bullish', 'SHORT')).toBe('DISAGREE');
  });

  it('treats BEARISH as a short-side bias', () => {
    expect(factorVote('bearish', 'BEARISH')).toBe('AGREE');
    expect(factorVote('bullish', 'BEARISH')).toBe('DISAGREE');
  });

  it('abstains for neutral factors instead of counting them as agreement', () => {
    // This is the original bug: a neutral factor was credited with the trade's
    // outcome, washing every factor toward the global base rate.
    expect(factorVote('neutral', 'LONG')).toBe('ABSTAIN');
    expect(factorVote('neutral', 'SHORT')).toBe('ABSTAIN');
  });

  it('abstains when no trade was taken', () => {
    expect(factorVote('bullish', 'NO TRADE')).toBe('ABSTAIN');
  });
});

describe('directionalScore — factors graded on their own claim', () => {
  it('rewards a bullish factor when price rose and punishes it when price fell', () => {
    expect(directionalScore('bullish', 0.04)).toBeCloseTo(0.04);
    expect(directionalScore('bullish', -0.04)).toBeCloseTo(-0.04);
  });

  it('inverts the sign for a bearish factor', () => {
    expect(directionalScore('bearish', -0.04)).toBeCloseTo(0.04);
    expect(directionalScore('bearish', 0.04)).toBeCloseTo(-0.04);
  });

  it('returns null for neutral rather than a zero that would drag the mean', () => {
    expect(directionalScore('neutral', 0.04)).toBeNull();
  });
});

describe('decayStats', () => {
  it('halves every counter after exactly one half-life', () => {
    const s = { n: 10, wins: 6, losses: 4, ambiguous: 2, sumScore: 5, sumScoreSq: 3, lastUpdatedAt: T0 };
    const d = decayStats(s, days(DEFAULT_HALF_LIFE_DAYS));
    expect(d.n).toBeCloseTo(5, 6);
    expect(d.wins).toBeCloseTo(3, 6);
    expect(d.losses).toBeCloseTo(2, 6);
    expect(d.ambiguous).toBeCloseTo(1, 6);
    expect(d.sumScore).toBeCloseTo(2.5, 6);
  });

  it('preserves ratios so decay cannot rewrite the win rate', () => {
    // Sized so the decayed sample still clears MIN_EFFECTIVE_N — otherwise the
    // gate returns null and the ratio is never compared.
    const s = { n: 100, wins: 60, losses: 40, ambiguous: 0, sumScore: 0, sumScoreSq: 0, lastUpdatedAt: T0 };
    const before = winRate(s);
    const after = winRate(decayStats(s, days(365)));
    expect(before).toBeCloseTo(0.6, 6);
    expect(after).toBeCloseTo(before!, 6);
  });

  it('never amplifies evidence when time runs backwards', () => {
    const s = { n: 10, wins: 6, losses: 4, ambiguous: 0, sumScore: 5, sumScoreSq: 3, lastUpdatedAt: days(10) };
    const d = decayStats(s, T0); // earlier than lastUpdatedAt
    expect(d.n).toBe(10);
    expect(d.sumScore).toBe(5);
  });
});

describe('observe', () => {
  it('accumulates wins, losses and score', () => {
    let s = emptyStats(T0);
    s = observe(s, { score: 2.3, won: true }, T0);
    s = observe(s, { score: -1, won: false }, T0);
    expect(s.n).toBe(2);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(1);
    expect(s.sumScore).toBeCloseTo(1.3);
  });

  it('records ambiguous outcomes without letting them touch wins, losses or score', () => {
    let s = emptyStats(T0);
    s = observe(s, { score: 0, won: false, ambiguous: true }, T0);
    expect(s.ambiguous).toBe(1);
    expect(s.n).toBe(0);
    expect(s.wins).toBe(0);
    expect(s.losses).toBe(0);
    expect(s.sumScore).toBe(0);
  });

  it('weights a fresh observation more than an aged one', () => {
    let old = emptyStats(T0);
    old = observe(old, { score: 1, won: true }, T0);
    // Two half-lives later the old win is worth 0.25; the new loss is worth 1.
    const aged = observe(old, { score: -1, won: false }, days(2 * DEFAULT_HALF_LIFE_DAYS));
    expect(aged.wins).toBeCloseTo(0.25, 6);
    expect(aged.losses).toBe(1);
  });

  it('lets recent losses overturn an older winning record', () => {
    // 8 wins long ago vs 8 losses today: the fresh evidence must dominate.
    let s = emptyStats(T0);
    for (let i = 0; i < 8; i++) s = observe(s, { score: 1, won: true }, T0);
    for (let i = 0; i < 8; i++) {
      s = observe(s, { score: -1, won: false }, days(2 * DEFAULT_HALF_LIFE_DAYS));
    }
    expect(winRate(s)!).toBeLessThan(0.25);
    expect(expectancy(s)!).toBeLessThan(0);
  });
});

describe('expectancy and winRate gating', () => {
  it('returns null until there is enough effective evidence', () => {
    let s = emptyStats(T0);
    s = observe(s, { score: 3, won: true }, T0);
    s = observe(s, { score: 3, won: true }, T0);
    expect(expectancy(s)).toBeNull();
    expect(winRate(s)).toBeNull();

    s = observe(s, { score: 3, won: true }, T0);
    expect(expectancy(s)).toBeCloseTo(3);
    expect(winRate(s)).toBeCloseTo(1);
  });
});

describe('breakEvenWinRate', () => {
  it('is 50% at 1:1 and ~30% at the 2.3R the screener actually emits', () => {
    expect(breakEvenWinRate(1)).toBeCloseTo(0.5, 6);
    expect(breakEvenWinRate(2.3)).toBeCloseTo(0.303, 3);
  });

  it('falls back to 50% for degenerate reward:risk', () => {
    expect(breakEvenWinRate(0)).toBe(0.5);
    expect(breakEvenWinRate(NaN)).toBe(0.5);
  });
});

describe('factorWeightMultiplier', () => {
  it('is neutral with no evidence', () => {
    expect(factorWeightMultiplier(emptyStats(T0))).toBe(1.0);
  });

  it('shrinks the tilt toward 1.0 while evidence is thin', () => {
    let thin = emptyStats(T0);
    for (let i = 0; i < 3; i++) thin = observe(thin, { score: 0.02, won: true }, T0);

    let thick = emptyStats(T0);
    for (let i = 0; i < 30; i++) thick = observe(thick, { score: 0.02, won: true }, T0);

    expect(factorWeightMultiplier(thick)).toBeGreaterThan(factorWeightMultiplier(thin));
    expect(factorWeightMultiplier(thin)).toBeGreaterThan(1.0);
  });

  it('penalises a factor whose calls go the wrong way', () => {
    let bad = emptyStats(T0);
    for (let i = 0; i < 30; i++) bad = observe(bad, { score: -0.02, won: false }, T0);
    expect(factorWeightMultiplier(bad)).toBeLessThan(1.0);
  });

  it('clamps so one streak cannot dominate the ensemble', () => {
    let wild = emptyStats(T0);
    for (let i = 0; i < 50; i++) wild = observe(wild, { score: 5, won: true }, T0);
    expect(factorWeightMultiplier(wild)).toBeLessThanOrEqual(1.75);

    let awful = emptyStats(T0);
    for (let i = 0; i < 50; i++) awful = observe(awful, { score: -5, won: false }, T0);
    expect(factorWeightMultiplier(awful)).toBeGreaterThanOrEqual(0.25);
  });
});

describe('calibrate', () => {
  it('falls back to the model prior with no evidence', () => {
    expect(calibrate(0.7, undefined).probability).toBe(0.7);
    expect(calibrate(0.7, undefined).reliability).toBe('INSUFFICIENT');
  });

  it('shrinks a small perfect record instead of reporting certainty', () => {
    let s = emptyStats(T0);
    s = observe(s, { score: 1, won: true }, T0);
    s = observe(s, { score: 1, won: true }, T0);
    const c = calibrate(0.5, s);
    expect(c.probability).toBeLessThan(1);
    expect(c.probability).toBeCloseTo(0.6, 3);
  });

  it('discounts an old record via decay so stale accuracy is not claimed today', () => {
    let s = emptyStats(T0);
    for (let i = 0; i < 30; i++) s = observe(s, { score: 1, won: true }, T0);

    const fresh = calibrate(0.4, s);
    const stale = calibrate(0.4, decayStats(s, days(4 * DEFAULT_HALF_LIFE_DAYS)));

    expect(stale.probability).toBeLessThan(fresh.probability);
    expect(stale.reliability).not.toBe('ESTABLISHED');
  });
});
