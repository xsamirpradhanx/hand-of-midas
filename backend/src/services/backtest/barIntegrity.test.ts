import { describe, it, expect } from 'vitest';
import { verdictFor, trustedFromMs, RETURN_TOLERANCE, type IntegrityReport } from './barIntegrity.js';

const DAY = 86_400_000;
const dates = (n: number) =>
  Array.from({ length: n }, (_, i) => new Date(Date.parse('2000-01-03') + i * DAY).toISOString().slice(0, 10));

/** A gently trending price series, deterministic. */
function prices(n: number, seed = 5): number[] {
  let s = seed >>> 0, p = 50;
  return Array.from({ length: n }, () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    p *= 1 + (s / 4294967296 - 0.48) * 0.03;
    return p;
  });
}

const barsOf = (ds: string[], ps: number[]) => ds.map((date, i) => ({ date, close: ps[i] }));
const refOf = (ds: string[], ps: number[]) => new Map(ds.map((d, i) => [d, ps[i]]));

describe('verdictFor', () => {
  const n = 400;
  const ds = dates(n);
  const truth = prices(n);

  it('passes a series that matches the reference exactly', () => {
    const v = verdictFor('CLEAN', barsOf(ds, truth), refOf(ds, truth));
    expect(v.verdict).toBe('clean');
    expect(v.trustedFrom).toBeNull();
    expect(v.droppedBars).toBe(0);
  });

  /**
   * The case that made the first version of this detector wrong.
   *
   * GE sits at a permanent 1.04x against Yahoo from an old spinoff convention.
   * A constant multiple leaves EVERY return exactly correct, because the
   * constant cancels in a ratio — the data is perfectly usable. Judged on price
   * levels it looked as broken as COST and cost 8,617 good bars.
   */
  it('passes a series that is a constant multiple of the reference', () => {
    const scaled = truth.map(p => p * 1.04);
    const v = verdictFor('OFFSET', barsOf(ds, scaled), refOf(ds, truth));
    expect(v.verdict).toBe('clean');
    expect(v.droppedBars).toBe(0);
  });

  /**
   * The defect itself: dividends deducted from historical prices, an amount
   * that decays to zero at the present. Returns computed across it are wrong by
   * a growing factor, and the oldest prices can go negative.
   */
  it('truncates a series distorted by a decaying subtraction', () => {
    const deduction = truth.map((_, i) => 40 * (1 - i / n)); // 40 at the start, 0 at the end
    const corrupted = truth.map((p, i) => p - deduction[i]);
    const v = verdictFor('SUBTRACTED', barsOf(ds, corrupted), refOf(ds, truth));
    expect(v.verdict).toBe('truncated');
    expect(v.trustedFrom).not.toBeNull();
    expect(v.droppedBars).toBeGreaterThan(50);
    // The kept tail is where the deduction has decayed under tolerance.
    expect(v.trustedFrom! > ds[0]).toBe(true);
  });

  it('survives a single stale reference print without discarding the history', () => {
    // One bad bar late in the series. A backwards scan for the last
    // out-of-tolerance bar would drop everything before it; the rolling median
    // ignores it.
    const withGlitch = [...truth];
    withGlitch[n - 5] *= 1.5;
    const v = verdictFor('GLITCH', barsOf(ds, withGlitch), refOf(ds, truth));
    expect(v.verdict).toBe('clean');
  });

  it('declines to judge a series with too little overlapping reference', () => {
    const short = ds.slice(0, 20);
    const v = verdictFor('THIN', barsOf(short, truth.slice(0, 20)), refOf(short, truth.slice(0, 20)));
    expect(v.verdict).toBe('unchecked');
    expect(v.droppedBars).toBe(0);
  });

  it('treats a non-finite stored return as maximally wrong rather than skipping it', () => {
    // A zero price mid-series makes the next return infinite. That IS the
    // corruption, so it must count against the symbol, not be filtered out.
    const withZero = [...truth];
    for (let i = 0; i < 120; i++) withZero[i] = 0;
    const v = verdictFor('ZEROED', barsOf(ds, withZero), refOf(ds, truth));
    expect(v.verdict).toBe('truncated');
    expect(v.droppedBars).toBeGreaterThan(100);
  });

  it('flags nothing for a discrepancy just inside tolerance', () => {
    const nudged = truth.map((p, i) => p * (1 + (i % 2 ? 1 : -1) * RETURN_TOLERANCE * 0.2));
    const v = verdictFor('NUDGED', barsOf(ds, nudged), refOf(ds, truth));
    expect(v.verdict).toBe('clean');
  });
});

describe('trustedFromMs', () => {
  const report: IntegrityReport = {
    auditedAt: '2026-08-21T00:00:00.000Z',
    tolerance: RETURN_TOLERANCE,
    symbols: {
      CLEAN: { symbol: 'CLEAN', trustedFrom: null, worstError: 0, droppedBars: 0, comparedBars: 500, verdict: 'clean' },
      CUT: { symbol: 'CUT', trustedFrom: '2015-06-01', worstError: 5, droppedBars: 100, comparedBars: 500, verdict: 'truncated' },
      DEAD: { symbol: 'DEAD', trustedFrom: null, worstError: 9, droppedBars: 500, comparedBars: 500, verdict: 'unusable' },
    },
  };

  it('lets a clean symbol through unbounded', () => {
    expect(trustedFromMs(report, 'CLEAN')).toBe(-Infinity);
  });

  it('floors a truncated symbol at its trusted date', () => {
    expect(trustedFromMs(report, 'CUT')).toBe(Date.parse('2015-06-01'));
  });

  it('excludes an unusable symbol entirely', () => {
    expect(trustedFromMs(report, 'DEAD')).toBe(Infinity);
  });

  /**
   * An unaudited symbol passes rather than being excluded. The quarantine is a
   * correction for a known defect, not a whitelist — silently dropping every
   * symbol missing from the report would turn a stale audit into an empty
   * universe with no error anywhere.
   */
  it('lets a symbol the report does not mention through', () => {
    expect(trustedFromMs(report, 'UNKNOWN')).toBe(-Infinity);
    expect(trustedFromMs(null, 'ANY')).toBe(-Infinity);
  });
});
