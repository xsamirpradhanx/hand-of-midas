/**
 * O(n) rolling primitives for the indicator lab.
 *
 * The lab scores tens of candidates over 2.2M bars, and several want windows of
 * 126 or 252 bars. Recomputing a window per bar is O(n·L) — around 650M
 * operations for one 252-bar candidate — which is the difference between a
 * search that runs in a minute and one that runs in an hour. Every primitive
 * here is single-pass.
 *
 * All of them are CAUSAL: index `i` depends on `0..i` only. `assertCausal` in
 * the lab checks that property empirically for each finished candidate.
 */

/** Rolling mean over the trailing `w` values, NaN until the window fills. */
export function rollMean(xs: ArrayLike<number>, w: number): Float64Array {
  const n = xs.length;
  const out = new Float64Array(n).fill(NaN);
  let sum = 0, count = 0;
  for (let i = 0; i < n; i++) {
    const v = xs[i];
    if (Number.isFinite(v)) { sum += v; count++; }
    if (i >= w) {
      const old = xs[i - w];
      if (Number.isFinite(old)) { sum -= old; count--; }
    }
    if (i >= w - 1 && count === w) out[i] = sum / w;
  }
  return out;
}

/** Rolling population standard deviation over the trailing `w` values. */
export function rollStd(xs: ArrayLike<number>, w: number): Float64Array {
  const n = xs.length;
  const out = new Float64Array(n).fill(NaN);
  let sum = 0, sumSq = 0, count = 0;
  for (let i = 0; i < n; i++) {
    const v = xs[i];
    if (Number.isFinite(v)) { sum += v; sumSq += v * v; count++; }
    if (i >= w) {
      const old = xs[i - w];
      if (Number.isFinite(old)) { sum -= old; sumSq -= old * old; count--; }
    }
    if (i >= w - 1 && count === w) {
      /**
       * Rearranged rather than the textbook two-pass form, with a RELATIVE
       * floor rather than a `> 0` guard.
       *
       * `sumSq/w - mean^2` is the classic catastrophic-cancellation shape: on a
       * window that is nearly constant the two terms agree to many digits and
       * what survives is accumulator drift, not variance. Because the running
       * sums are updated incrementally, that drift depends on how many bars the
       * accumulator has processed — so the SAME window over the SAME bars gives
       * a slightly different answer on a long series than on a trimmed one, and
       * a near-zero variance turns that into a wildly different z-score.
       *
       * It is not hypothetical. The benchmark close is forward-filled across
       * holidays, so `benchRet` contains runs of exact zeros; scoring an
       * expression over it shifted the cross-sectional IC by 1.7e-3 between a
       * trimmed and untrimmed panel — enough to make a search unreproducible,
       * and to let it mine numerical artefacts that look like signal.
       *
       * Below the floor the window is treated as genuinely flat and the caller
       * abstains (zScore yields NaN), which is the honest reading.
       */
      const mean = sum / w;
      const meanSq = sumSq / w;
      const varr = meanSq - mean * mean;
      out[i] = varr > 1e-12 * Math.max(Math.abs(meanSq), 1e-300) ? Math.sqrt(varr) : 0;
    }
  }
  return out;
}

/** Rolling sum over the trailing `w` values. */
export function rollSum(xs: ArrayLike<number>, w: number): Float64Array {
  const n = xs.length;
  const out = new Float64Array(n).fill(NaN);
  let sum = 0, count = 0;
  for (let i = 0; i < n; i++) {
    const v = xs[i];
    if (Number.isFinite(v)) { sum += v; count++; }
    if (i >= w) {
      const old = xs[i - w];
      if (Number.isFinite(old)) { sum -= old; count--; }
    }
    if (i >= w - 1 && count === w) out[i] = sum;
  }
  return out;
}

/** Rolling extremum via a monotonic deque — O(n) regardless of window size. */
function rollExtreme(xs: ArrayLike<number>, w: number, wantMax: boolean): Float64Array {
  const n = xs.length;
  const out = new Float64Array(n).fill(NaN);
  const dq: number[] = []; // indices, values monotonic
  for (let i = 0; i < n; i++) {
    while (dq.length && dq[0] <= i - w) dq.shift();
    const v = xs[i];
    if (Number.isFinite(v)) {
      while (dq.length && (wantMax ? xs[dq[dq.length - 1]] <= v : xs[dq[dq.length - 1]] >= v)) dq.pop();
      dq.push(i);
    }
    if (i >= w - 1 && dq.length) out[i] = xs[dq[0]];
  }
  return out;
}

export const rollMax = (xs: ArrayLike<number>, w: number) => rollExtreme(xs, w, true);
export const rollMin = (xs: ArrayLike<number>, w: number) => rollExtreme(xs, w, false);

/** Bar-over-bar log returns; index 0 is NaN. */
export function logReturns(close: ArrayLike<number>): Float64Array {
  const n = close.length;
  const out = new Float64Array(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const a = close[i - 1], b = close[i];
    if (a > 0 && b > 0) out[i] = Math.log(b / a);
  }
  return out;
}

/** Wilder's ATR, seeded with a simple mean of the first `period` true ranges. */
export function atrSeries(
  high: ArrayLike<number>, low: ArrayLike<number>, close: ArrayLike<number>, period = 14,
): Float64Array {
  const n = close.length;
  const out = new Float64Array(n).fill(NaN);
  const tr = new Float64Array(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
  }
  let seed = 0;
  for (let i = 1; i <= period && i < n; i++) seed += tr[i];
  if (n > period) {
    out[period] = seed / period;
    for (let i = period + 1; i < n; i++) out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  }
  return out;
}

/**
 * Rolling z-score of a series against its own trailing distribution.
 *
 * This is what makes a per-symbol indicator comparable across symbols without
 * the factor ever seeing the cross-section: a $600 megacap and a $4 miner both
 * emit a value in units of their own recent variability. Every candidate that
 * has a natural scale is normalised this way before it is scored.
 */
export function zScore(xs: ArrayLike<number>, w: number): Float64Array {
  const n = xs.length;
  const mean = rollMean(xs, w);
  const std = rollStd(xs, w);
  const out = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(xs[i]) && Number.isFinite(mean[i]) && std[i] > 0) out[i] = (xs[i] - mean[i]) / std[i];
  }
  return out;
}

/**
 * Rolling OLS slope and residual of `y` on `x` over the trailing `w` bars.
 *
 * Used for benchmark regressions (beta, residual return). Single-pass with
 * running cross-moments; the same cancellation guard as rollStd applies.
 */
export function rollRegression(
  y: ArrayLike<number>, x: ArrayLike<number>, w: number,
): { beta: Float64Array; alpha: Float64Array } {
  const n = y.length;
  const beta = new Float64Array(n).fill(NaN);
  const alpha = new Float64Array(n).fill(NaN);
  let sx = 0, sy = 0, sxx = 0, sxy = 0, count = 0;
  const valid = (i: number) => Number.isFinite(y[i]) && Number.isFinite(x[i]);
  for (let i = 0; i < n; i++) {
    if (valid(i)) { sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; sxy += x[i] * y[i]; count++; }
    if (i >= w) {
      const j = i - w;
      if (valid(j)) { sx -= x[j]; sy -= y[j]; sxx -= x[j] * x[j]; sxy -= x[j] * y[j]; count--; }
    }
    if (i >= w - 1 && count >= Math.max(10, w * 0.6)) {
      const varX = sxx / count - (sx / count) ** 2;
      if (varX > 1e-12) {
        const b = (sxy / count - (sx / count) * (sy / count)) / varX;
        beta[i] = b;
        alpha[i] = sy / count - b * (sx / count);
      }
    }
  }
  return { beta, alpha };
}
