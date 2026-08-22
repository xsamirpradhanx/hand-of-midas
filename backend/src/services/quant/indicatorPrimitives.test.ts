import { describe, it, expect } from 'vitest';
import {
  rollMean, rollStd, rollSum, rollMin, rollMax, logReturns, atrSeries, zScore, rollRegression,
} from './indicatorPrimitives.js';

/**
 * These are checked against naive O(n*w) reimplementations rather than against
 * hand-written expected values.
 *
 * The primitives are single-pass for speed, which means every one of them
 * carries running state that a window boundary can corrupt — a subtracted
 * element that was NaN, a variance that goes marginally negative on a constant
 * window. A wrong rolling mean does not throw; it quietly shifts every
 * indicator built on it, and the resulting research is confidently wrong. The
 * obvious implementation is the specification here.
 */
const naiveWindow = (xs: number[], w: number, f: (win: number[]) => number) =>
  xs.map((_, i) => (i >= w - 1 ? f(xs.slice(i - w + 1, i + 1)) : NaN));

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const near = (a: Float64Array, b: number[], tol = 1e-9) => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < b.length; i++) {
    if (Number.isNaN(b[i])) { expect(Number.isNaN(a[i])).toBe(true); continue; }
    expect(Math.abs(a[i] - b[i])).toBeLessThan(tol);
  }
};

const series = [12, 15, 11, 9, 14, 22, 19, 18, 25, 24, 21, 30, 28, 27, 33, 31, 29, 35, 40, 38];

describe('rolling primitives match the naive definition', () => {
  for (const w of [2, 5, 7]) {
    it(`rollMean, window ${w}`, () => near(rollMean(series, w), naiveWindow(series, w, mean)));
    it(`rollSum, window ${w}`, () => near(rollSum(series, w), naiveWindow(series, w, a => a.reduce((x, y) => x + y, 0))));
    it(`rollMin/rollMax, window ${w}`, () => {
      near(rollMin(series, w), naiveWindow(series, w, a => Math.min(...a)));
      near(rollMax(series, w), naiveWindow(series, w, a => Math.max(...a)));
    });
    it(`rollStd, window ${w}`, () => {
      near(rollStd(series, w), naiveWindow(series, w, a => {
        const m = mean(a);
        return Math.sqrt(mean(a.map(x => (x - m) ** 2)));
      }), 1e-8);
    });
  }

  it('returns NaN before the window is full rather than a partial answer', () => {
    const out = rollMean(series, 5);
    for (let i = 0; i < 4; i++) expect(Number.isNaN(out[i])).toBe(true);
    expect(Number.isNaN(out[4])).toBe(false);
  });

  it('reports zero standard deviation on a constant window, never NaN', () => {
    // The rearranged variance formula can land marginally below zero here,
    // which would become NaN under an unguarded sqrt.
    const flat = new Array(10).fill(1234.5678);
    const out = rollStd(flat, 5);
    for (let i = 4; i < 10; i++) expect(out[i]).toBe(0);
  });

  it('propagates a NaN through the window and recovers after it', () => {
    const withHole = [...series];
    withHole[7] = NaN;
    const out = rollMean(withHole, 3);
    for (const i of [7, 8, 9]) expect(Number.isNaN(out[i])).toBe(true);
    expect(Number.isNaN(out[10])).toBe(false);
  });
});

describe('logReturns', () => {
  it('is undefined on the first bar and exact thereafter', () => {
    const r = logReturns([10, 20, 10]);
    expect(Number.isNaN(r[0])).toBe(true);
    expect(r[1]).toBeCloseTo(Math.log(2), 12);
    expect(r[2]).toBeCloseTo(-Math.log(2), 12);
  });

  it('declines to divide by a non-positive price', () => {
    const r = logReturns([0, 10, -5, 10]);
    expect(Number.isNaN(r[1])).toBe(true);
    expect(Number.isNaN(r[2])).toBe(true);
    expect(Number.isNaN(r[3])).toBe(true);
  });
});

describe('atrSeries', () => {
  it('seeds with the mean true range and then smooths by Wilder', () => {
    const h = [10, 11, 12, 13, 14], l = [9, 10, 11, 12, 13], c = [9.5, 10.5, 11.5, 12.5, 13.5];
    const period = 2;
    const out = atrSeries(h, l, c, period);
    // TR[1] = max(11-10, |11-9.5|, |10-9.5|) = 1.5; TR[2] likewise 1.5.
    expect(out[period]).toBeCloseTo(1.5, 12);
    // Wilder: (prev*(p-1) + tr)/p.
    expect(out[3]).toBeCloseTo((1.5 * 1 + 1.5) / 2, 12);
  });

  it('is undefined before the seeding window closes', () => {
    const out = atrSeries([1, 2, 3], [0, 1, 2], [0.5, 1.5, 2.5], 14);
    for (const v of out) expect(Number.isNaN(v)).toBe(true);
  });
});

describe('zScore', () => {
  it('centres and scales against the trailing window', () => {
    const xs = [1, 2, 3, 4, 100];
    const z = zScore(xs, 4);
    const win = [2, 3, 4, 100];
    const m = mean(win);
    const sd = Math.sqrt(mean(win.map(x => (x - m) ** 2)));
    expect(z[4]).toBeCloseTo((100 - m) / sd, 9);
  });

  it('abstains rather than dividing by a zero spread', () => {
    const z = zScore(new Array(10).fill(7), 5);
    for (const v of z) expect(Number.isNaN(v)).toBe(true);
  });
});

describe('rollRegression', () => {
  it('recovers a known slope and intercept exactly', () => {
    const x = Array.from({ length: 40 }, (_, i) => Math.sin(i));
    const y = x.map(v => 3 + 2.5 * v);
    const { beta, alpha } = rollRegression(y, x, 30);
    expect(beta[39]).toBeCloseTo(2.5, 8);
    expect(alpha[39]).toBeCloseTo(3, 8);
  });

  it('abstains when the regressor has no variance', () => {
    const x = new Array(40).fill(1);
    const y = Array.from({ length: 40 }, (_, i) => i);
    const { beta } = rollRegression(y, x, 30);
    expect(Number.isNaN(beta[39])).toBe(true);
  });
});
