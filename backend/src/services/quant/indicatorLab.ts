/**
 * Indicator research harness.
 *
 * The engine already measures factor accuracy — sign of the factor's vote
 * against the sign of the 20-bar forward return — and that measurement is what
 * the learning loop and position sizing consume. It has one property that makes
 * it useless for BUILDING indicators, though: it is not corrected for market
 * drift.
 *
 * Equities rise. Over 1984-2026 in this store a randomly chosen symbol-bar is
 * up 20 bars later well over half the time. A factor that is bullish most of the
 * time therefore scores above 50% while knowing nothing, and a factor that leans
 * bearish scores below 50% while knowing nothing. "Accuracy" in that sense is
 * mostly a readout of a factor's long/short mix. Selecting new indicators on it
 * would select for permanent bullishness, which is beta, not signal — and beta
 * is exactly the kind of edge that looks strong in-sample and dies when the
 * sample changes era.
 *
 * So every candidate here is scored three ways:
 *
 *   acc     raw sign match. Directly comparable to the engine's factor stats,
 *           and reported only so lab numbers can be reconciled with them.
 *   accAdj  sign match against the CROSS-SECTIONALLY DEMEANED forward return —
 *           did the signal pick the names that beat their peers that day. Drift
 *           cancels out of a demeaned return by construction, so this is the
 *           honest accuracy.
 *   ic      per-date Spearman rank correlation between signal and forward
 *           return, averaged over dates. The standard cross-sectional statistic:
 *           it uses the whole ranking rather than just the sign, so it separates
 *           a signal that is mildly right about everything from one that is
 *           strongly right about a few names.
 *
 * INFERENCE. Observations overlap: a 20-bar forward return computed today
 * shares 19 bars with tomorrow's. Treating dates as independent overstates
 * t-statistics by roughly sqrt(20). Every t reported here is Newey-West
 * corrected at the horizon lag, and the headline claims are additionally
 * checked with a moving-block bootstrap over dates. This matters more than it
 * sounds: it is the single most common way a daily-frequency backtest
 * manufactures significance.
 */

import type { BarPanel } from '../backtest/barCache.js';

export const DEFAULT_HORIZON = 20;

/** A candidate indicator: bars in, one signal value per bar out. */
export interface IndicatorCandidate {
  readonly name: string;
  /** Grouping label, so a parameter sweep can be reported as one family. */
  readonly family: string;
  /** Bars required before the first defined value. */
  readonly warmup: number;
  /**
   * Signal for every bar of the panel, `NaN` where undefined.
   *
   * Sign convention: POSITIVE means bullish over the horizon. Magnitude is used
   * only for ranking, never as a probability, so candidates need not share a
   * scale.
   *
   * Computed for the whole series at once rather than bar by bar: the lab
   * evaluates hundreds of candidate/parameter combinations over 2.2M bars, and
   * a per-bar callback spends more time in call overhead than in arithmetic.
   * Look-ahead is prevented by contract — index `i` may read `0..i` only — and
   * checked by `assertCausal`.
   */
  compute(panel: BarPanel, market: MarketContext): Float64Array;
}

/**
 * Market-wide series aligned to the global date axis, for candidates that need
 * a benchmark (relative strength, residual momentum, beta).
 */
export interface MarketContext {
  /** Global date axis, ascending epoch ms. */
  readonly dates: Float64Array;
  /** Benchmark close aligned to `dates`, NaN before the benchmark exists. */
  readonly benchClose: Float64Array;
  /** Benchmark 1-bar log return aligned to `dates`. */
  readonly benchRet: Float64Array;
  /** Implied-volatility index close aligned to `dates`, NaN before it exists. */
  readonly vixClose: Float64Array;
  /** Global date index for bar `i` of the panel currently being computed. */
  readonly dateIndexOf: Int32Array;
}

export interface LabPanelSet {
  readonly symbols: readonly string[];
  readonly panels: readonly BarPanel[];
  /** Union of every date in the universe, ascending. */
  readonly dates: Float64Array;
  /** Per-symbol map: local bar index -> global date index. */
  readonly dateIndex: readonly Int32Array[];
  readonly benchClose: Float64Array;
  readonly benchRet: Float64Array;
  readonly vixClose: Float64Array;
}

/** Build the shared date axis and benchmark series once for the whole run. */
export function buildPanelSet(panels: readonly BarPanel[], benchmark = 'SPY', volIndex = '^VIX'): LabPanelSet {
  const all = new Set<number>();
  for (const p of panels) for (let i = 0; i < p.n; i++) all.add(p.t[i]);
  const dates = Float64Array.from([...all].sort((a, b) => a - b));

  const pos = new Map<number, number>();
  for (let d = 0; d < dates.length; d++) pos.set(dates[d], d);

  const dateIndex = panels.map(p => {
    const idx = new Int32Array(p.n);
    for (let i = 0; i < p.n; i++) idx[i] = pos.get(p.t[i]) ?? -1;
    return idx;
  });

  const benchClose = new Float64Array(dates.length).fill(NaN);
  const bIdx = panels.findIndex(p => p.symbol === benchmark);
  if (bIdx >= 0) {
    const b = panels[bIdx];
    for (let i = 0; i < b.n; i++) benchClose[dateIndex[bIdx][i]] = b.c[i];
  }
  // Forward-fill so a benchmark holiday does not punch a hole in every
  // relative-strength candidate on that date.
  for (let d = 1; d < dates.length; d++) {
    if (Number.isNaN(benchClose[d])) benchClose[d] = benchClose[d - 1];
  }
  const benchRet = new Float64Array(dates.length).fill(NaN);
  for (let d = 1; d < dates.length; d++) {
    const a = benchClose[d - 1], b = benchClose[d];
    if (a > 0 && b > 0) benchRet[d] = Math.log(b / a);
  }

  // The volatility index is carried the same way, forward-filled: it is a
  // regime input for conditional candidates, and a hole on one date would make
  // every conditioned signal abstain market-wide that day.
  const vixClose = new Float64Array(dates.length).fill(NaN);
  const vIdx = panels.findIndex(p => p.symbol === volIndex);
  if (vIdx >= 0) {
    const v = panels[vIdx];
    for (let i = 0; i < v.n; i++) vixClose[dateIndex[vIdx][i]] = v.c[i];
  }
  for (let d = 1; d < dates.length; d++) {
    if (Number.isNaN(vixClose[d])) vixClose[d] = vixClose[d - 1];
  }

  return { symbols: panels.map(p => p.symbol), panels, dates, dateIndex, benchClose, benchRet, vixClose };
}

/**
 * Drop every bar before `fromMs`.
 *
 * Used to enforce the integrity quarantine: a symbol whose deep history is
 * corrupted still has usable recent history, and discarding the symbol entirely
 * would throw away good data while discarding nothing keeps returns that read
 * as 10^17 percent. Trimming is not a filter applied at scoring time on
 * purpose — a trimmed panel also shortens every rolling window that would
 * otherwise reach back across the boundary and quietly launder a corrupt bar
 * into a clean one's indicator value.
 */
export function trimPanel(panel: BarPanel, fromMs: number): BarPanel {
  if (!Number.isFinite(fromMs) || fromMs === -Infinity) return panel;
  let start = 0;
  while (start < panel.n && panel.t[start] < fromMs) start++;
  if (start === 0) return panel;
  const n = panel.n - start;
  return {
    symbol: panel.symbol, n,
    t: panel.t.subarray(start), o: panel.o.subarray(start), h: panel.h.subarray(start),
    l: panel.l.subarray(start), c: panel.c.subarray(start), v: panel.v.subarray(start),
  };
}

/** Close-to-close forward return over `horizon` bars, matching gradeOutcome. */
export function forwardReturns(panel: BarPanel, horizon: number): Float64Array {
  const out = new Float64Array(panel.n).fill(NaN);
  for (let i = 0; i + horizon < panel.n; i++) {
    const e = panel.c[i];
    if (e > 0) out[i] = (panel.c[i + horizon] - e) / e;
  }
  return out;
}

// ── statistics ─────────────────────────────────────────────────────────────

/** Mean, ignoring NaN. */
export function nanMean(xs: ArrayLike<number>): number {
  let s = 0, n = 0;
  for (let i = 0; i < xs.length; i++) { const v = xs[i]; if (Number.isFinite(v)) { s += v; n++; } }
  return n ? s / n : NaN;
}

/**
 * Newey-West standard error of the mean of a serially correlated series.
 *
 * With overlapping horizons the naive SE is too small by roughly sqrt(horizon);
 * Bartlett-weighted autocovariances out to `lag` put that back. `lag` should be
 * the overlap length (the horizon), which is the standard choice.
 */
export function neweyWestSE(series: readonly number[], lag: number): number {
  const xs = series.filter(Number.isFinite);
  const n = xs.length;
  if (n < 3) return NaN;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const dev = xs.map(x => x - mean);
  let variance = dev.reduce((a, d) => a + d * d, 0) / n;
  const maxLag = Math.min(lag, n - 1);
  for (let k = 1; k <= maxLag; k++) {
    let cov = 0;
    for (let i = k; i < n; i++) cov += dev[i] * dev[i - k];
    cov /= n;
    variance += 2 * (1 - k / (maxLag + 1)) * cov;
  }
  // Bartlett weights guarantee a non-negative estimate in theory; floating
  // point on a near-zero series can still land marginally below.
  return variance > 0 ? Math.sqrt(variance / n) : NaN;
}

/**
 * Moving-block bootstrap: fraction of resamples whose mean has the same sign as
 * the observed mean. Blocks preserve the serial correlation that overlapping
 * horizons create; an iid bootstrap would not.
 *
 * Deterministic by design — a seeded LCG rather than Math.random — so a
 * reported p-value is reproducible and a rerun cannot quietly change a verdict.
 */
export function blockBootstrapPositive(
  series: readonly number[],
  blockLen: number,
  iterations = 2000,
  seed = 20260821,
): number {
  const xs = series.filter(Number.isFinite);
  const n = xs.length;
  if (n < blockLen * 2) return NaN;
  const observed = xs.reduce((a, b) => a + b, 0) / n;
  const nBlocks = Math.ceil(n / blockLen);
  let state = seed >>> 0;
  const rand = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 4294967296);
  let sameSign = 0;
  for (let it = 0; it < iterations; it++) {
    let sum = 0, count = 0;
    for (let b = 0; b < nBlocks; b++) {
      const start = Math.floor(rand() * (n - blockLen + 1));
      for (let k = 0; k < blockLen && count < n; k++) { sum += xs[start + k]; count++; }
    }
    const m = sum / count;
    if ((observed >= 0 && m > 0) || (observed < 0 && m < 0)) sameSign++;
  }
  return sameSign / iterations;
}

/** In-place fractional ranking of the finite entries, scaled to [-0.5, 0.5]. */
export function rankCentered(values: number[]): number[] {
  const idx = values.map((v, i) => i).filter(i => Number.isFinite(values[i]));
  idx.sort((a, b) => values[a] - values[b]);
  const out = new Array<number>(values.length).fill(NaN);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && values[idx[j + 1]] === values[idx[i]]) j++;
    const avg = (i + j) / 2;
    for (let k = i; k <= j; k++) out[idx[k]] = avg;
    i = j + 1;
  }
  const m = idx.length;
  for (const i2 of idx) out[i2] = m > 1 ? out[i2] / (m - 1) - 0.5 : 0;
  return out;
}

export function pearson(xs: readonly number[], ys: readonly number[]): number {
  let n = 0, mx = 0, my = 0;
  for (let i = 0; i < xs.length; i++) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) { n++; mx += xs[i]; my += ys[i]; }
  }
  if (n < 3) return NaN;
  mx /= n; my /= n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i++) {
    if (!Number.isFinite(xs[i]) || !Number.isFinite(ys[i])) continue;
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : NaN;
}

// ── evaluation ─────────────────────────────────────────────────────────────

export interface EvalOptions {
  readonly horizon?: number;
  /** Skip dates with fewer than this many symbols reporting a signal. */
  readonly minCrossSection?: number;
  /** Inclusive ISO date bounds on the DECISION bar. */
  readonly from?: string;
  readonly to?: string;
  /** Symbols to include; defaults to all in the panel set. */
  readonly symbols?: ReadonlySet<string>;
  /** Fraction of the cross-section in each tail for the spread metric. */
  readonly tailFraction?: number;
  /**
   * Only score bars whose |signal| is in the top `activeFraction` of that
   * date's cross-section. Models how a factor actually behaves — it votes on
   * conviction and abstains otherwise — and keeps a weak-but-omnipresent signal
   * from being judged on bars it would never have spoken about.
   */
  readonly activeFraction?: number;
  readonly bootstrapIterations?: number;
}

export interface IndicatorScore {
  readonly name: string;
  readonly family: string;
  /** Scored observations (symbol-bars). */
  readonly n: number;
  readonly dates: number;
  /** Raw sign match — comparable to the engine's factor accuracy. */
  readonly acc: number;
  /** Sign match against the cross-sectionally demeaned forward return. */
  readonly accAdj: number;
  /** Share of scored observations where the signal voted long. */
  readonly longShare: number;
  /** Mean per-date Spearman IC. */
  readonly ic: number;
  readonly icT: number;
  /** Mean per-date top-tail minus bottom-tail forward return, in bp. */
  readonly spreadBp: number;
  readonly spreadT: number;
  /** Block-bootstrap share of resamples keeping the IC's sign. */
  readonly icBootstrap: number;
  /**
   * Correlation between this candidate's per-date long-short spread and the
   * BENCHMARK's forward return over the same window.
   *
   * The contamination test. Cross-sectional demeaning removes the market's
   * average move but not a signal's exposure to it: rank names by beta in a
   * rising market and the top decile beats the bottom decile every time,
   * scoring as a strong indicator while carrying no information at all. Such a
   * signal's spread rises and falls WITH the market, so a high |betaLoading|
   * says the edge is market exposure wearing an indicator's clothes.
   *
   * Near zero is what a genuine cross-sectional signal looks like — it should
   * pay whether the market rose or fell that month.
   */
  readonly betaLoading: number;
  /**
   * Share of the signal's variance that is CROSS-SECTIONAL rather than
   * market-wide: mean(per-date variance across symbols) / pooled variance.
   *
   * Near 1 for a genuine per-symbol indicator; near 0 for a series that is the
   * same for everyone on a given day. The distinction is invisible to IC, and
   * that is a hole a search will find — `mean63(benchRet)` is one number per
   * date, so ranking symbols by it ranks nothing but each symbol's own bar
   * availability and z-score window, and it scored t = -4.3 doing exactly that.
   * Signals are z-scored per symbol before this is measured, so both terms sit
   * on the same scale and the ratio reads directly as a share.
   *
   * NaN when nothing was scorable at all, which is what a PERFECTLY market-wide
   * signal produces: every symbol ranks equal, so no date has a defined
   * correlation. Callers gating on this must use a comparison NaN fails
   * (`>= min`), not one it passes.
   */
  readonly crossSectionalShare: number;
  /** Per-date IC series, retained for split-level and stability analysis. */
  readonly icSeries: readonly number[];
  readonly spreadSeries: readonly number[];
  readonly dateSeries: readonly number[];
}

/**
 * Score one candidate over the universe.
 *
 * Everything is computed per date across symbols, then averaged over dates.
 * Pooling symbol-bars instead would weight 2026 (261 symbols reporting) about
 * forty times more heavily than 1990 (a handful), and would let one date's
 * market-wide move stand in for hundreds of independent observations.
 */
/** Benchmark forward return over `horizon`, on the global date axis. */
export function benchmarkForward(set: LabPanelSet, horizon: number): Float64Array {
  const out = new Float64Array(set.dates.length).fill(NaN);
  for (let d = 0; d + horizon < set.dates.length; d++) {
    const a = set.benchClose[d], b = set.benchClose[d + horizon];
    if (a > 0 && b > 0) out[d] = b / a - 1;
  }
  return out;
}

export function scoreCandidate(
  candidate: IndicatorCandidate,
  set: LabPanelSet,
  fwd: readonly Float64Array[],
  options: EvalOptions = {},
): IndicatorScore {
  const horizon = options.horizon ?? DEFAULT_HORIZON;
  const minCross = options.minCrossSection ?? 20;
  const tail = options.tailFraction ?? 0.2;
  const activeFraction = options.activeFraction ?? 1;
  const fromMs = options.from ? Date.parse(options.from) : -Infinity;
  const toMs = options.to ? Date.parse(options.to) : Infinity;

  const nDates = set.dates.length;
  // Per-date buckets, filled once by sweeping every symbol's series.
  const sigBy: number[][] = Array.from({ length: nDates }, () => []);
  const retBy: number[][] = Array.from({ length: nDates }, () => []);

  for (let s = 0; s < set.panels.length; s++) {
    const panel = set.panels[s];
    if (options.symbols && !options.symbols.has(panel.symbol)) continue;
    const market: MarketContext = {
      dates: set.dates,
      benchClose: set.benchClose,
      benchRet: set.benchRet,
      vixClose: set.vixClose,
      dateIndexOf: set.dateIndex[s],
    };
    const sig = candidate.compute(panel, market);
    const f = fwd[s];
    const di = set.dateIndex[s];
    for (let i = candidate.warmup; i + horizon < panel.n; i++) {
      const v = sig[i], r = f[i];
      if (!Number.isFinite(v) || !Number.isFinite(r)) continue;
      const t = panel.t[i];
      if (t < fromMs || t > toMs) continue;
      sigBy[di[i]].push(v);
      retBy[di[i]].push(r);
    }
  }

  const benchFwd = benchmarkForward(set, horizon);
  const icSeries: number[] = [];
  const spreadSeries: number[] = [];
  const dateSeries: number[] = [];
  const benchSeries: number[] = [];
  /** Per-date cross-sectional variance, and the pooled spread, for the share. */
  const crossVar: number[] = [];
  let pooledSum = 0, pooledSumSq = 0, pooledN = 0;
  let hits = 0, hitsAdj = 0, scored = 0, longs = 0;

  for (let d = 0; d < nDates; d++) {
    const sig = sigBy[d];
    if (sig.length < minCross) continue;
    const ret = retBy[d];
    const sRank = rankCentered(sig.slice());
    const rRank = rankCentered(ret.slice());
    const ic = pearson(sRank, rRank);
    if (!Number.isFinite(ic)) continue;

    const meanRet = nanMean(ret);
    // Dispersion of the SIGNAL across symbols on this date, and its
    // contribution to the pooled spread.
    let cs = 0, css = 0;
    for (const v of sig) { cs += v; css += v * v; pooledSum += v; pooledSumSq += v * v; }
    pooledN += sig.length;
    crossVar.push(css / sig.length - (cs / sig.length) ** 2);
    // Conviction gate: keep only the strongest |signal| names on this date.
    let threshold = -Infinity;
    if (activeFraction < 1) {
      const abs = sig.map(Math.abs).sort((a, b) => b - a);
      threshold = abs[Math.max(0, Math.floor(abs.length * activeFraction) - 1)];
    }
    for (let k = 0; k < sig.length; k++) {
      if (sig[k] === 0 || Math.abs(sig[k]) < threshold) continue;
      const long = sig[k] > 0;
      scored++;
      if (long) longs++;
      if (long === ret[k] > 0) hits++;
      if (long === ret[k] - meanRet > 0) hitsAdj++;
    }

    const order = sig.map((v, i) => i).sort((a, b) => sig[a] - sig[b]);
    const k = Math.max(1, Math.floor(order.length * tail));
    let top = 0, bot = 0;
    for (let j = 0; j < k; j++) { bot += ret[order[j]]; top += ret[order[order.length - 1 - j]]; }
    spreadSeries.push((top - bot) / k);
    icSeries.push(ic);
    dateSeries.push(set.dates[d]);
    benchSeries.push(benchFwd[d]);
  }

  const ic = nanMean(icSeries);
  const icSE = neweyWestSE(icSeries, horizon);
  const spread = nanMean(spreadSeries);
  const spreadSE = neweyWestSE(spreadSeries, horizon);

  return {
    name: candidate.name,
    family: candidate.family,
    n: scored,
    dates: icSeries.length,
    acc: scored ? hits / scored : NaN,
    accAdj: scored ? hitsAdj / scored : NaN,
    longShare: scored ? longs / scored : NaN,
    ic,
    icT: icSE > 0 ? ic / icSE : NaN,
    spreadBp: spread * 10_000,
    spreadT: spreadSE > 0 ? spread / spreadSE : NaN,
    icBootstrap: blockBootstrapPositive(icSeries, horizon * 2, options.bootstrapIterations ?? 1000),
    betaLoading: pearson(spreadSeries, benchSeries),
    crossSectionalShare: (() => {
      if (pooledN < 2) return NaN;
      const pooled = pooledSumSq / pooledN - (pooledSum / pooledN) ** 2;
      const across = nanMean(crossVar);
      return pooled > 0 ? across / pooled : NaN;
    })(),
    icSeries,
    spreadSeries,
    dateSeries,
  };
}

/**
 * Look-ahead check.
 *
 * A candidate is causal if truncating the series at bar `i` does not change the
 * value at bar `i`. Recomputing on a prefix and comparing catches the whole
 * class of bugs where a candidate accidentally reads the future — a full-series
 * mean, a centred moving average, a peak found by scanning forward — which no
 * amount of staring at the arithmetic reliably catches.
 */
export function assertCausal(candidate: IndicatorCandidate, panel: BarPanel, market: MarketContext, probes = 6): void {
  const full = candidate.compute(panel, market);
  const step = Math.max(1, Math.floor((panel.n - candidate.warmup) / (probes + 1)));
  for (let p = 1; p <= probes; p++) {
    const cut = candidate.warmup + p * step;
    if (cut >= panel.n) break;
    const prefix: BarPanel = {
      symbol: panel.symbol, n: cut + 1,
      t: panel.t.subarray(0, cut + 1), o: panel.o.subarray(0, cut + 1),
      h: panel.h.subarray(0, cut + 1), l: panel.l.subarray(0, cut + 1),
      c: panel.c.subarray(0, cut + 1), v: panel.v.subarray(0, cut + 1),
    };
    const truncated = candidate.compute(prefix, { ...market, dateIndexOf: market.dateIndexOf.subarray(0, cut + 1) });
    const a = full[cut], b = truncated[cut];
    if (Number.isNaN(a) && Number.isNaN(b)) continue;
    const scale = Math.max(1e-9, Math.abs(a), Math.abs(b));
    if (!(Math.abs(a - b) / scale < 1e-9)) {
      throw new Error(
        `${candidate.name} is NOT causal: value at bar ${cut} is ${a} on the full series but ${b} when the series ends there`,
      );
    }
  }
}
