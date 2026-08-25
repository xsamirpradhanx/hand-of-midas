import { describe, it, expect } from 'vitest';
import { computeRiskGauge, labelFor } from './riskGauge.js';

/**
 * The gauge is a composed number, and composed numbers fail quietly: a sign
 * flip or a one-session misalignment still renders a plausible dial. These
 * pin the properties that would otherwise only be caught by someone noticing
 * the reading looks wrong.
 */

/** A series of `n` sessions ending on a fixed date, with a supplied close path. */
function series(closes: number[], endOffsetDays = 0) {
  const dates: string[] = [];
  const end = Date.parse('2026-08-21T00:00:00Z') - endOffsetDays * 86_400_000;
  for (let i = closes.length - 1; i >= 0; i--) {
    dates.unshift(new Date(end - i * 86_400_000).toISOString().slice(0, 10));
  }
  return { dates, closes };
}

/** A path that rises steadily, then does something at the end. */
function path(n: number, drift: number, finalKick = 0): number[] {
  const out: number[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) { p *= 1 + drift; out.push(p); }
  if (finalKick) for (let i = n - 21; i < n; i++) out[i] *= 1 + finalKick;
  return out;
}

describe('labelFor', () => {
  it('maps the scale the way the UI colours it', () => {
    expect(labelFor(10)).toBe('Extreme Fear');
    expect(labelFor(30)).toBe('Fear');
    expect(labelFor(50)).toBe('Neutral');
    expect(labelFor(65)).toBe('Greed');
    expect(labelFor(90)).toBe('Extreme Greed');
  });
});

describe('computeRiskGauge', () => {
  const N = 400;

  it('reads greedy when risk assets lead and volatility is low', () => {
    const g = computeRiskGauge({
      SPY: series(path(N, 0.0008, 0.05)),
      TLT: series(path(N, 0.0001)),
      HYG: series(path(N, 0.0006, 0.03)),
      LQD: series(path(N, 0.0001)),
      RSP: series(path(N, 0.0009, 0.05)),
      XLY: series(path(N, 0.0010, 0.06)),
      XLP: series(path(N, 0.0002)),
      '^VIX': series(path(N, 0).map((v, i) => (i > N - 30 ? v * 0.5 : v))),
    });
    expect(g.score).not.toBeNull();
    expect(g.score!).toBeGreaterThan(60);
    expect(['Greed', 'Extreme Greed']).toContain(g.label);
  });

  /**
   * The inversion check. VIX is the one component whose percentile is flipped,
   * and a missing or doubled inversion is invisible in the composite.
   */
  it('reads fearful when volatility spikes and defensives lead', () => {
    const g = computeRiskGauge({
      SPY: series(path(N, 0.0008, -0.06)),
      TLT: series(path(N, 0.0002, 0.04)),
      HYG: series(path(N, 0.0004, -0.04)),
      LQD: series(path(N, 0.0002, 0.01)),
      RSP: series(path(N, 0.0007, -0.07)),
      XLY: series(path(N, 0.0008, -0.08)),
      XLP: series(path(N, 0.0003, 0.02)),
      '^VIX': series(path(N, 0).map((v, i) => (i > N - 20 ? v * 3 : v))),
    });
    expect(g.score).not.toBeNull();
    expect(g.score!).toBeLessThan(40);
    expect(['Fear', 'Extreme Fear']).toContain(g.label);
  });

  /**
   * The bug this was written after finding.
   *
   * `spread` aligns two series from the right, which is correct only while both
   * end on the same session — real feeds do not guarantee that. ^VIX returned
   * 481 bars over the exact span in which every ETF returned 480.
   *
   * The property alignment guarantees is precise: a run where ONE feed is a
   * session short must equal a run where EVERY feed is truncated to that same
   * common window. If it does not, the short feed is being compared against
   * another symbol's later session. Asserting "the score barely moves" would be
   * the wrong test — dropping a session legitimately changes the reading.
   */
  it('treats one short feed as the whole window ending a session earlier', () => {
    const build = () => ({
      SPY: series(path(N, 0.0008, 0.05)),
      TLT: series(path(N, 0.0001)),
      HYG: series(path(N, 0.0006, 0.03)),
      LQD: series(path(N, 0.0001)),
      RSP: series(path(N, 0.0009, 0.05)),
      XLY: series(path(N, 0.0010, 0.06)),
      XLP: series(path(N, 0.0002)),
      '^VIX': series(path(N, 0)),
    });
    const drop1 = (x: { dates: string[]; closes: number[] }) =>
      ({ dates: x.dates.slice(0, -1), closes: x.closes.slice(0, -1) });

    const base = build();
    // Only TLT is short — the intersection must pull everything back a session.
    const oneShort = computeRiskGauge({ ...base, TLT: drop1(base.TLT) });
    // Every series short by the same session — the intended equivalent.
    const b2 = build();
    const allShort = computeRiskGauge(
      Object.fromEntries(Object.entries(b2).map(([k, v]) => [k, drop1(v as any)])) as any,
    );

    expect(oneShort.score).toBe(allShort.score);
    for (const c of oneShort.components) {
      const other = allShort.components.find(o => o.key === c.key)!;
      expect(c.score).toBe(other.score);
    }
  });

  it('drops a component whose symbol is missing, and still scores', () => {
    const g = computeRiskGauge({
      SPY: series(path(N, 0.0008)),
      TLT: series(path(N, 0.0001)),
      HYG: series(path(N, 0.0006)),
      LQD: series(path(N, 0.0001)),
      '^VIX': series(path(N, 0)),
    });
    expect(g.components.find(c => c.key === 'cyclicals')).toBeUndefined();
    expect(g.score).not.toBeNull();
  });

  it('refuses to score on too few components rather than guessing', () => {
    const g = computeRiskGauge({ SPY: series(path(N, 0.0008)) });
    // Momentum alone is one component; the composite needs at least three.
    expect(g.score).toBeNull();
  });

  it('returns null components on a series too short to rank', () => {
    const g = computeRiskGauge({
      SPY: series(path(30, 0.001)),
      TLT: series(path(30, 0.001)),
      HYG: series(path(30, 0.001)),
      LQD: series(path(30, 0.001)),
      '^VIX': series(path(30, 0.001)),
    });
    expect(g.score).toBeNull();
    for (const c of g.components) expect(c.score).toBeNull();
  });

  it('never emits a score outside 0-100', () => {
    const g = computeRiskGauge({
      SPY: series(path(N, 0.002, 0.5)),
      TLT: series(path(N, -0.001)),
      HYG: series(path(N, 0.002, 0.4)),
      LQD: series(path(N, -0.001)),
      RSP: series(path(N, 0.002, 0.5)),
      XLY: series(path(N, 0.003, 0.6)),
      XLP: series(path(N, -0.001)),
      '^VIX': series(path(N, -0.002)),
    });
    for (const c of g.components) {
      if (c.score !== null) { expect(c.score).toBeGreaterThanOrEqual(0); expect(c.score).toBeLessThanOrEqual(100); }
    }
    expect(g.score!).toBeGreaterThanOrEqual(0);
    expect(g.score!).toBeLessThanOrEqual(100);
  });
});
