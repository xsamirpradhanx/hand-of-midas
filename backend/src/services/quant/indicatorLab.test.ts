import { describe, it, expect } from 'vitest';
import {
  neweyWestSE, blockBootstrapPositive, assertCausal, trimPanel, forwardReturns,
  buildPanelSet, scoreCandidate, nanMean,
  type IndicatorCandidate, type MarketContext,
} from './indicatorLab.js';
import type { BarPanel } from '../backtest/barCache.js';

const DAY = 86_400_000;

/** A synthetic panel with a controllable close series. */
function panelOf(symbol: string, closes: number[], startMs = Date.parse('2000-01-03')): BarPanel {
  const n = closes.length;
  const mk = (f: (i: number) => number) => Float64Array.from({ length: n }, (_, i) => f(i));
  return {
    symbol, n,
    t: mk(i => startMs + i * DAY),
    o: mk(i => closes[i]), h: mk(i => closes[i] * 1.01),
    l: mk(i => closes[i] * 0.99), c: mk(i => closes[i]),
    v: mk(() => 1_000_000),
  };
}

/** Deterministic pseudo-random walk — no Math.random, so failures reproduce. */
function walk(n: number, seed = 7): number[] {
  let s = seed >>> 0, p = 100;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    p *= 1 + (s / 4294967296 - 0.5) * 0.04;
    out.push(p);
  }
  return out;
}

describe('neweyWestSE', () => {
  it('matches the plain standard error when the series is independent', () => {
    const xs = walk(400).map((v, i, a) => (i ? v / a[i - 1] - 1 : 0));
    const plain = Math.sqrt(
      xs.reduce((a, b) => a + (b - nanMean(xs)) ** 2, 0) / xs.length / xs.length,
    );
    expect(neweyWestSE(xs, 0)).toBeCloseTo(plain, 9);
  });

  /**
   * The reason every t in the lab is Newey-West corrected.
   *
   * Overlapping 20-bar forward returns share 19 of their 20 days, so the naive
   * standard error is too small by roughly sqrt(20) and every t-statistic built
   * on it is inflated by the same factor. That is the single most common way a
   * daily-frequency backtest manufactures significance, so the correction has
   * to demonstrably do something on a series that actually overlaps.
   */
  it('inflates the standard error on a strongly autocorrelated series', () => {
    const base = walk(600);
    // A 20-period moving sum: adjacent values share 19 of 20 terms.
    const overlapping = base.map((_, i) =>
      i < 20 ? NaN : base.slice(i - 20, i).reduce((a, b) => a + b, 0),
    ).filter(Number.isFinite);
    const naive = neweyWestSE(overlapping, 0);
    const corrected = neweyWestSE(overlapping, 20);
    expect(corrected).toBeGreaterThan(naive * 2);
  });

  it('returns NaN rather than a confident number on a series too short to judge', () => {
    expect(Number.isNaN(neweyWestSE([1, 2], 5))).toBe(true);
  });
});

describe('blockBootstrapPositive', () => {
  it('is deterministic, so a reported p-value can be rechecked', () => {
    const xs = walk(300).map(v => v - 100);
    expect(blockBootstrapPositive(xs, 20, 500)).toBe(blockBootstrapPositive(xs, 20, 500));
  });

  it('is near-certain on a clearly signed series and unsure on a centred one', () => {
    const positive = new Array(300).fill(1).map((_, i) => 1 + (i % 3) * 0.01);
    expect(blockBootstrapPositive(positive, 20, 500)).toBeGreaterThan(0.99);
    const centred = new Array(300).fill(0).map((_, i) => (i % 2 ? 1 : -1));
    expect(blockBootstrapPositive(centred, 20, 500)).toBeLessThan(0.95);
  });
});

describe('assertCausal', () => {
  const closes = walk(300);
  const panel = panelOf('TEST', closes);
  const set = buildPanelSet([panel], 'NONE', 'NONE');
  const market: MarketContext = {
    dates: set.dates, benchClose: set.benchClose, benchRet: set.benchRet,
    vixClose: set.vixClose, dateIndexOf: set.dateIndex[0],
  };

  it('accepts a candidate that only reads the past', () => {
    const causal: IndicatorCandidate = {
      name: 'trailing', family: 'test', warmup: 5,
      compute: p => Float64Array.from({ length: p.n }, (_, i) => (i >= 5 ? p.c[i] - p.c[i - 5] : NaN)),
    };
    expect(() => assertCausal(causal, panel, market)).not.toThrow();
  });

  /**
   * The check that earns its place.
   *
   * This leak is invisible in the arithmetic — the expression mentions no
   * future index — but normalising by a statistic of the WHOLE series makes
   * every value depend on data that had not happened yet. Recomputing on a
   * truncated prefix is what exposes it.
   */
  it('catches a candidate normalised by a full-series statistic', () => {
    const leaking: IndicatorCandidate = {
      name: 'full-series-mean', family: 'test', warmup: 5,
      compute: p => {
        let sum = 0;
        for (let i = 0; i < p.n; i++) sum += p.c[i];
        const mean = sum / p.n;
        return Float64Array.from({ length: p.n }, (_, i) => p.c[i] - mean);
      },
    };
    expect(() => assertCausal(leaking, panel, market)).toThrow(/NOT causal/);
  });

  it('catches a candidate that reads the very next bar', () => {
    const peeking: IndicatorCandidate = {
      name: 'peek', family: 'test', warmup: 5,
      compute: p => Float64Array.from({ length: p.n },
        (_, i) => (i + 1 < p.n ? p.c[i + 1] - p.c[i] : NaN)),
    };
    expect(() => assertCausal(peeking, panel, market)).toThrow(/NOT causal/);
  });
});

describe('trimPanel', () => {
  const panel = panelOf('TEST', walk(100));

  it('drops exactly the bars before the cutoff', () => {
    const cut = panel.t[30];
    const trimmed = trimPanel(panel, cut);
    expect(trimmed.n).toBe(70);
    expect(trimmed.t[0]).toBe(cut);
    expect(trimmed.c[0]).toBe(panel.c[30]);
  });

  it('is a no-op for an unbounded floor, without copying', () => {
    expect(trimPanel(panel, -Infinity)).toBe(panel);
  });

  /**
   * Trimming rather than filtering at scoring time is what keeps a quarantined
   * bar from leaking into a clean one's indicator value through a rolling
   * window that reaches back across the boundary.
   */
  it('shortens the history a rolling window can reach', () => {
    const trimmed = trimPanel(panel, panel.t[95]);
    expect(trimmed.n).toBe(5);
    expect(rollableBars(trimmed)).toBe(5);
  });
  const rollableBars = (p: BarPanel) => p.c.length;
});

describe('forwardReturns', () => {
  it('is the close-to-close return over the horizon, matching gradeOutcome', () => {
    const p = panelOf('TEST', [100, 101, 102, 110, 120]);
    const f = forwardReturns(p, 2);
    expect(f[0]).toBeCloseTo(0.02, 12);
    expect(f[2]).toBeCloseTo(120 / 102 - 1, 12);
    // Undefined where the horizon runs past the end of the series.
    expect(Number.isNaN(f[3])).toBe(true);
    expect(Number.isNaN(f[4])).toBe(true);
  });
});

describe('scoreCandidate', () => {
  /**
   * An oracle candidate — it is handed the answer — should score near-perfectly.
   * If it does not, the scoring path is broken and nothing it reports about a
   * real candidate means anything.
   */
  it('gives a signal that knows the answer an IC near 1', () => {
    const panels = Array.from({ length: 30 }, (_, k) => panelOf(`S${k}`, walk(200, 11 + k)));
    const set = buildPanelSet(panels, 'NONE', 'NONE');
    const fwd = panels.map(p => forwardReturns(p, 5));
    const oracle: IndicatorCandidate = {
      name: 'oracle', family: 'test', warmup: 1,
      compute: p => {
        const out = new Float64Array(p.n).fill(NaN);
        for (let i = 0; i + 5 < p.n; i++) out[i] = p.c[i + 5] / p.c[i] - 1;
        return out;
      },
    };
    const s = scoreCandidate(oracle, set, fwd, { horizon: 5, minCrossSection: 20 });
    expect(s.ic).toBeGreaterThan(0.99);
    // Raw sign match is perfect: the oracle IS the forward return's sign.
    expect(s.acc).toBeCloseTo(1, 6);
    /**
     * Drift-adjusted accuracy is high but NOT perfect, and the gap is the
     * distinction the whole lab rests on. `accAdj` asks whether the name beat
     * its PEERS, so a name the oracle correctly calls up, which then rises less
     * than the cross-section did, counts as a miss. Perfect knowledge of
     * direction is not perfect knowledge of relative direction.
     */
    expect(s.accAdj).toBeGreaterThan(0.9);
    expect(s.accAdj).toBeLessThan(s.acc);
  });

  it('gives a constant signal no score at all, rather than a spurious one', () => {
    const panels = Array.from({ length: 30 }, (_, k) => panelOf(`S${k}`, walk(200, 11 + k)));
    const set = buildPanelSet(panels, 'NONE', 'NONE');
    const fwd = panels.map(p => forwardReturns(p, 5));
    const flat: IndicatorCandidate = {
      name: 'flat', family: 'test', warmup: 1,
      compute: p => new Float64Array(p.n).fill(1),
    };
    const s = scoreCandidate(flat, set, fwd, { horizon: 5, minCrossSection: 20 });
    // Every name ranks identically, so no date carries a defined correlation.
    // Reported as unscorable rather than as a zero — a flat signal has no
    // opinion, which is different from an opinion that turned out to be worth
    // nothing, and averaging the two together would hide the first inside the
    // second.
    expect(s.dates).toBe(0);
    expect(Number.isNaN(s.ic)).toBe(true);
    expect(s.n).toBe(0);
  });
});
