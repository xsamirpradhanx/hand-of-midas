/**
 * Evolutionary search over the indicator grammar, with a null calibration.
 *
 * THE PROBLEM THIS IS MOSTLY SOLVING. A search that evaluates ten thousand
 * expressions against one panel WILL return something with a t-statistic of 4.
 * That is not a discovery, it is the maximum of ten thousand draws — under the
 * null the expected best |t| grows like sqrt(2 ln N), so at N = 10,000 a
 * completely worthless search still hands back |t| ~ 4.3. Every one of this
 * project's retracted findings has this shape, and a generative search makes it
 * far easier to hit, because it optimises directly for the statistic.
 *
 * So the search is run TWICE, identically, with the same seed and the same
 * evaluation budget:
 *
 *   - once against the real forward returns;
 *   - once against forward returns SHUFFLED WITHIN EACH DATE.
 *
 * The shuffle destroys any relationship between a symbol's signal and its own
 * forward return while preserving everything else — the per-date return
 * distribution, the market's move that day, the cross-sectional spread, the
 * number of symbols reporting, the autocorrelation of the signal itself. The
 * best fitness the null run achieves is therefore the score this search
 * architecture produces from pure noise on data of exactly this shape. A real
 * result has to beat that bar, not the textbook one.
 *
 * Everything else here is ordinary genetic programming: a population of
 * expression trees, tournament selection, mutation biased toward window
 * retuning, crossover, and elitism.
 */

import type { BarPanel } from '../backtest/barCache.js';
import {
  scoreCandidate, type EvalOptions, type IndicatorScore, type LabPanelSet,
} from './indicatorLab.js';
import {
  Rng, crossover, depth, maxWindow, mutate, nodeCount, randomExpr, render, toCandidate, type Expr,
} from './indicatorGrammar.js';

export interface SearchOptions {
  readonly horizon: number;
  /** Symbols the search may look at. The rest are never touched during search. */
  readonly trainSymbols: ReadonlySet<string>;
  readonly from?: string;
  readonly to?: string;
  readonly population: number;
  readonly generations: number;
  readonly seed: number;
  /** Reject anything whose long-short spread tracks the market this closely. */
  readonly maxBetaLoading: number;
  /**
   * Reject anything whose variance is mostly market-wide rather than
   * cross-sectional.
   *
   * Calibrated, not guessed: hand-written per-symbol indicators measure 0.69
   * (rev_5) to 0.90 (volshock_21) on this panel, while a market-wide series
   * measures 0.000 — `mean63(benchRet)` is one number per date, so ranking
   * symbols by it ranks only their own bar availability. It scored t = -4.3
   * doing that and led the first search's results. 0.5 sits in the empty gap
   * between the two populations.
   */
  readonly minCrossSectionalShare: number;
  /**
   * Reject anything defined on far fewer observations than the panel offers.
   *
   * The third artefact family, after market-wide series and disguised beta.
   * `(body / benchRet)` and its variants swept an entire hall of fame at
   * |t| ~ 5 on n = 123,652 where an ordinary candidate scores 288,000:
   * dividing by a near-zero market-wide denominator yields NaN often enough to
   * invalidate the trailing z-score window, so the signal survives only on
   * stretches without holidays. WHICH observations drop out is therefore
   * decided by the calendar, identically for every symbol — the candidate is
   * selecting dates rather than ranking symbols, and its edge is a selection
   * effect. Expressed as a count so the caller can scale it to the cell.
   */
  readonly minObservations: number;
  readonly maxDepth: number;
  readonly minDates: number;
  readonly onProgress?: (gen: number, best: Scored | null, evaluated: number) => void;
}

export interface Scored {
  readonly expr: Expr;
  readonly text: string;
  readonly fitness: number;
  readonly score: IndicatorScore;
}

/**
 * Complexity penalty, in units of t.
 *
 * Deliberately gentle: it is here to break ties toward the simpler of two
 * equally good trees, not to enforce a style. A heavy penalty would bias the
 * search toward the hand-written pool's shapes, which defeats the point of
 * searching a space nobody enumerated.
 */
function penalise(fitness: number, e: Expr): number {
  return fitness - 0.02 * Math.max(0, nodeCount(e) - 5);
}

/**
 * Forward returns permuted within each date.
 *
 * Within-date rather than global: a global shuffle would also destroy the
 * per-date return distribution, so the null run would face an easier problem
 * than the real one and the bar it sets would be too low.
 */
export function shuffleForwardWithinDates(
  set: LabPanelSet, fwd: readonly Float64Array[], rng: Rng,
): Float64Array[] {
  const out = fwd.map(f => Float64Array.from(f));
  const byDate = new Map<number, Array<[number, number]>>();
  for (let s = 0; s < set.panels.length; s++) {
    const di = set.dateIndex[s];
    for (let i = 0; i < set.panels[s].n; i++) {
      if (!Number.isFinite(fwd[s][i])) continue;
      const key = di[i];
      let bucket = byDate.get(key);
      if (!bucket) { bucket = []; byDate.set(key, bucket); }
      bucket.push([s, i]);
    }
  }
  for (const cells of byDate.values()) {
    const values = cells.map(([s, i]) => fwd[s][i]);
    for (let k = values.length - 1; k > 0; k--) {
      const j = Math.floor(rng.next() * (k + 1));
      [values[k], values[j]] = [values[j], values[k]];
    }
    cells.forEach(([s, i], k) => { out[s][i] = values[k]; });
  }
  return out;
}

/**
 * NO PANEL TRIMMING. The search evaluates on exactly the panels the report
 * re-measures on.
 *
 * Trimming each symbol to the search window plus a warmup buffer was tried as a
 * ~3x speedup and withdrawn. It produced three separate defects: the sliced
 * panels kept the ORIGINAL date index, so bars were attributed to the wrong
 * dates and `benchRet` read the wrong day; the forward returns were left at
 * full length, so signals were compared against another bar's outcome; and even
 * after both were fixed a plain `benchRet` expression still scored ic 0.0017
 * untrimmed against 0.0034 trimmed, a difference no warmup buffer explained.
 *
 * Each of those produced confident-looking t-statistics. For a search whose
 * only real job is to avoid fooling itself, a fitness that does not reproduce
 * when re-measured is worse than a slow one — so the optimisation is gone and
 * the search pays full price for evaluating what it claims to evaluate.
 */

export interface SearchResult {
  readonly best: readonly Scored[];
  readonly evaluated: number;
  /** Every distinct expression's fitness, for the null-vs-real comparison. */
  readonly allFitness: readonly number[];
}

export function search(
  set: LabPanelSet,
  fwd: readonly Float64Array[],
  options: SearchOptions,
): SearchResult {
  const rng = new Rng(options.seed);
  const seen = new Map<string, number>();
  const allFitness: number[] = [];
  const evalOpts: EvalOptions = {
    horizon: options.horizon,
    symbols: options.trainSymbols,
    from: options.from,
    to: options.to,
    minCrossSection: 20,
    activeFraction: 1,
    bootstrapIterations: 0,
  };

  const evaluateExpr = (e: Expr): Scored | null => {
    const text = render(e);
    if (seen.has(text)) return null;
    if (depth(e) > options.maxDepth || maxWindow(e) > 900) { seen.set(text, -Infinity); return null; }
    let score: IndicatorScore;
    try {
      score = scoreCandidate(toCandidate(e, text), set, fwd, evalOpts);
    } catch { seen.set(text, -Infinity); return null; }

    // Degenerate: too few scored dates, no observations, or a signal so flat it
    // ranks nothing. All three produce meaningless statistics rather than bad ones.
    if (score.dates < options.minDates || score.n < options.minObservations || !Number.isFinite(score.icT)) {
      seen.set(text, -Infinity);
      return null;
    }
    // A market bet in disguise. Rejected outright rather than penalised: no
    // amount of t makes an indicator that just holds beta interesting.
    if (Math.abs(score.betaLoading) > options.maxBetaLoading) {
      seen.set(text, -Infinity);
      return null;
    }
    // A market-wide series wearing a cross-sectional ranking. Same reasoning:
    // there is no t large enough to make one interesting, because the ranking
    // it produces is an artefact of data availability rather than a view.
    if (!(score.crossSectionalShare >= options.minCrossSectionalShare)) {
      seen.set(text, -Infinity);
      return null;
    }
    const fitness = penalise(Math.abs(score.icT), e);
    seen.set(text, fitness);
    allFitness.push(fitness);
    return { expr: e, text, fitness, score };
  };

  let population: Scored[] = [];
  let guard = 0;
  while (population.length < options.population && guard++ < options.population * 40) {
    const s = evaluateExpr(randomExpr(rng, options.maxDepth));
    if (s) population.push(s);
  }

  /**
   * Correlation between two candidates' per-date IC series, on common dates.
   *
   * Absolute, because a sign flip is not a new idea: one hall of fame held both
   * `(body / benchRet)` and `neg((body / benchRet))` — the same indicator, the
   * same |t|, two slots.
   */
  const icCorrelation = (x: Scored, y: Scored): number => {
    const m = new Map<number, number>();
    x.score.dateSeries.forEach((d, i) => m.set(d, x.score.icSeries[i]));
    const xs: number[] = [], ys: number[] = [];
    y.score.dateSeries.forEach((d, i) => {
      const v = m.get(d);
      if (v !== undefined && Number.isFinite(v) && Number.isFinite(y.score.icSeries[i])) {
        xs.push(v); ys.push(y.score.icSeries[i]);
      }
    });
    if (xs.length < 50) return 0;
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2; }
    return dx > 0 && dy > 0 ? Math.abs(num / Math.sqrt(dx * dy)) : 0;
  };

  /**
   * The hall of fame holds DISTINCT ideas, not the top N scores.
   *
   * Without this it fills with one family: a previous run returned eight
   * variants of `(body / benchRet)` differing by a divisor that barely moved
   * the series, so the report showed one idea eight times and hid everything
   * else the search had found. A near-duplicate replaces its twin only when it
   * scores better, so each slot still tracks the best version of its idea.
   */
  const MAX_IC_CORRELATION = 0.9;
  const hallOfFame: Scored[] = [];
  const remember = (s: Scored) => {
    if (hallOfFame.some(h => h.text === s.text)) return;
    const twin = hallOfFame.findIndex(h => icCorrelation(h, s) > MAX_IC_CORRELATION);
    if (twin >= 0) {
      if (s.fitness > hallOfFame[twin].fitness) hallOfFame[twin] = s;
    } else {
      hallOfFame.push(s);
    }
    hallOfFame.sort((a, b) => b.fitness - a.fitness);
    if (hallOfFame.length > 40) hallOfFame.length = 40;
  };
  population.forEach(remember);

  for (let gen = 0; gen < options.generations; gen++) {
    population.sort((a, b) => b.fitness - a.fitness);
    options.onProgress?.(gen, population[0] ?? null, seen.size);

    // Elitism: the top decile survives untouched, so a good structure is never
    // lost to an unlucky generation.
    const elite = population.slice(0, Math.max(2, Math.floor(options.population * 0.1)));
    const next: Scored[] = [...elite];

    const tournament = (): Scored => {
      const a = population[Math.floor(rng.next() * population.length)];
      const b = population[Math.floor(rng.next() * population.length)];
      return a.fitness >= b.fitness ? a : b;
    };

    let attempts = 0;
    while (next.length < options.population && attempts++ < options.population * 25) {
      const parent = tournament();
      const child = rng.chance(0.7)
        ? mutate(parent.expr, rng, options.maxDepth)
        : crossover(parent.expr, tournament().expr, rng);
      const s = evaluateExpr(child);
      if (s) { next.push(s); remember(s); }
    }
    // A generation that cannot fill itself means the neighbourhood is exhausted;
    // inject fresh random trees rather than inbreeding the survivors.
    while (next.length < options.population) {
      const s = evaluateExpr(randomExpr(rng, options.maxDepth));
      if (s) { next.push(s); remember(s); } else if (attempts++ > options.population * 60) break;
    }
    population = next;
  }

  return { best: hallOfFame, evaluated: seen.size, allFitness };
}
