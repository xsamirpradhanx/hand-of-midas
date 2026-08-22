/**
 * Historical replay engine.
 *
 * Walks bars forward one at a time, asks the strategy for a plan using only the
 * history visible at that instant, grades the plan with the SAME gradeOutcome
 * used in production, and folds the result into the SAME learningCore rules.
 * Sharing those two modules is the whole point: a backtest that grades or
 * learns differently from the live loop measures a system you do not run.
 *
 * Look-ahead is prevented structurally, not by convention — see visibleSlice.
 */

import { gradeOutcome, type GradeInput } from '../quant/gradeOutcome.js';
import {
  observe,
  decayStats,
  emptyStats,
  directionalScore,
  expectancy,
  winRate,
  DEFAULT_HALF_LIFE_DAYS,
  type DecayedStats,
} from '../quant/learningCore.js';
import type {
  BacktestBar,
  BacktestDataSource,
  BacktestFactorVote,
  BacktestStrategy,
  DecisionContext,
} from './types.js';

export interface ReplayOptions {
  /** Bars the strategy needs before its first decision (indicator warmup). */
  warmupBars?: number;
  /** Grading horizon, in bars. Defaults to the production HORIZON_BARS of 20. */
  horizonBars?: number;
  /** Decay half-life for learned stats, in calendar days. */
  halfLifeDays?: number;
  /**
   * Ask the strategy on every Nth eligible bar instead of every one.
   *
   * Plans on adjacent bars overlap almost completely, so a thinned grid covers
   * the same period at a fraction of the cost. Applied inside the engine rather
   * than by a wrapper around the strategy so a skipped bar costs nothing at
   * all — a wrapper still pays for the visible slice before it can decline.
   * Counted across the merged timeline, so the thinning is by date rather than
   * by symbol and no name is systematically favoured.
   */
  decideEvery?: number;
  /**
   * Symbol to expose as the benchmark in `DecisionContext.benchmarkBars`.
   *
   * Needed by relative-strength factors, which are the only kind that measured
   * out of sample — a relative quantity cannot be computed from one symbol's
   * bars. Omit and those factors abstain, exactly as they do live when the
   * benchmark fetch fails.
   */
  benchmarkSymbol?: string;
  /** Inclusive ISO date bounds on the decision bar. */
  from?: string;
  to?: string;
  /**
   * Cap on concurrent open plans per symbol. A strategy that fires every bar
   * would otherwise book 20 overlapping positions in the same name and report
   * an equity curve no account could have traded.
   */
  maxConcurrentPerSymbol?: number;
}

export interface TradeRecord {
  readonly symbol: string;
  readonly asOf: string;
  readonly bias: 'LONG' | 'SHORT';
  readonly entry: number;
  readonly stop: number;
  readonly target: number;
  readonly outcome: 'TARGET' | 'STOP' | 'TIMEOUT' | 'AMBIGUOUS';
  readonly realizedR: number | null;
  readonly forwardReturn: number | null;
  readonly barsElapsed: number;
  readonly setupKey?: string;
  /**
   * |zone midpoint - the extreme price actually reached| in ATR units, or null
   * when the plan carried no zone. Lower is better; this measures PLACEMENT, not
   * profitability, so it stays meaningful on losing trades.
   */
  readonly demandZoneErrorAtr: number | null;
  readonly supplyZoneErrorAtr: number | null;
  readonly conviction: number | null;
  readonly sizeMultiplier: number | null;
  readonly regime: string | null;
  readonly coverage: number | null;
  /**
   * Each factor's vote at decision time, retained so a scoring rule can be
   * re-derived offline WITHOUT re-running the engine. Needed for walk-forward
   * experiments: to ask whether measured factor accuracy would have ranked
   * better than the weight sum, you must know who voted which way on each trade.
   */
  readonly factorVotes: readonly { factorName: string; bias: string }[];
}

export interface ReplayResult {
  readonly strategy: string;
  readonly trades: readonly TradeRecord[];
  readonly stats: {
    readonly total: number;
    readonly resolved: number;
    readonly ambiguous: number;
    readonly wins: number;
    readonly losses: number;
    readonly winRate: number | null;
    /** Mean realized R per resolved trade. The number that decides viability. */
    readonly expectancyR: number | null;
    readonly totalR: number;
    /** Largest peak-to-trough decline of the cumulative-R curve. */
    readonly maxDrawdownR: number;
    readonly equityCurveR: readonly number[];
    /**
     * The same trades weighted by sizeMultiplier, normalised so mean size is 1.
     *
     * Normalising matters: an unnormalised comparison would reward any sizing
     * rule that simply bets bigger on average, which is leverage rather than
     * skill. With mean size held at 1, a gain here can only come from
     * concentrating into the better trades.
     */
    readonly sizedTotalR: number;
    readonly sizedMaxDrawdownR: number;
    readonly meanSize: number;
  };
  /**
   * Median distance from each zone to the price extreme actually reached, in ATR.
   *
   * The regression metric for zone geometry. Kept separate from win rate on
   * purpose: a change can improve placement while expectancy is still dominated
   * by stop sizing, and conflating them hides which half moved.
   */
  readonly zoneError: {
    readonly demandMedianAtr: number | null;
    readonly supplyMedianAtr: number | null;
    readonly demandN: number;
    readonly supplyN: number;
  };
  /** Decayed learning state, keyed by factor name. */
  readonly factorStats: Record<string, DecayedStats>;
  /** Decayed learning state, keyed by the plan's setupKey. */
  readonly setupStats: Record<string, DecayedStats>;
}

/**
 * The anti-look-ahead boundary.
 *
 * Returns a frozen view of history through `index` inclusive: the strategy can
 * neither see past the decision bar nor mutate replay state between symbols.
 *
 * `bars` must already be an array of individually frozen bar objects — see
 * `freezeSeries`. That precondition is what makes this affordable. The original
 * version froze a fresh copy of every bar on every call:
 *
 *     bars.slice(0, index + 1).map(b => Object.freeze({ ...b }))
 *
 * which allocates and freezes `index + 1` NEW objects per decision bar, so a
 * single 10,000-bar symbol builds ~50 million throwaway objects across its
 * replay. That is quadratic in series length and it is the whole reason a
 * full-universe run was an overnight job — which in turn is the reason model
 * changes went unmeasured. Freezing each bar once per symbol and slicing
 * pointers preserves both guarantees at a fraction of the cost.
 */
function visibleSlice(bars: readonly BacktestBar[], index: number): readonly BacktestBar[] {
  return Object.freeze(bars.slice(0, index + 1));
}

/** Freeze each bar once, so `visibleSlice` only ever copies pointers. */
function freezeSeries(bars: readonly BacktestBar[]): readonly BacktestBar[] {
  return Object.freeze(bars.map(b => Object.freeze({ ...b })));
}

/** Median of the non-null values, or null when there are none. */
function median(values: readonly (number | null)[]): number | null {
  const xs = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  const m = xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
  return Number(m.toFixed(3));
}

function maxDrawdown(curve: readonly number[]): number {
  let peak = 0;
  let worst = 0;
  for (const v of curve) {
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > worst) worst = dd;
  }
  return worst;
}

export async function replay(
  dataSource: BacktestDataSource,
  strategy: BacktestStrategy,
  options: ReplayOptions = {},
): Promise<ReplayResult> {
  const warmup = options.warmupBars ?? 50;
  const horizon = options.horizonBars ?? 20;
  const halfLife = options.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
  const maxConcurrent = options.maxConcurrentPerSymbol ?? 1;
  const decideEvery = Math.max(1, Math.floor(options.decideEvery ?? 1));
  let eligible = 0;
  const fromMs = options.from ? Date.parse(options.from) : -Infinity;
  const toMs = options.to ? Date.parse(options.to) : Infinity;

  const trades: TradeRecord[] = [];
  const factorStats: Record<string, DecayedStats> = {};
  /**
   * Undecayed win/loss tallies handed back to the strategy, in the shape
   * compositeScore's accuracy multiplier expects. Separate from `factorStats`
   * above, which is the decayed learning state reported in the result.
   *
   * Declared here for the type, but RESET PER SYMBOL below — see the note at the
   * top of the symbol loop.
   */
  type LearnedTally = Record<string, {
    wins: number; losses: number; score: number; tries: number;
    bullishVotes: number; bullishWins: number; bearishVotes: number; bearishWins: number;
  }>;
  const setupStats: Record<string, DecayedStats> = {};

  const symbols = await dataSource.symbols();

  /**
   * Benchmark series, loaded once and searched by date.
   *
   * The cursor below relies on the merged timeline being walked in ascending
   * date order, which it is, so finding the visible benchmark prefix is an
   * amortised O(1) advance rather than a binary search per decision.
   */
  const benchmark = options.benchmarkSymbol
    ? freezeSeries(await dataSource.bars(options.benchmarkSymbol))
    : null;
  const benchmarkTimes = benchmark ? benchmark.map(b => Date.parse(b.datetime)) : [];
  let benchmarkCursor = 0;

  /**
   * Every symbol's series is loaded up front and walked in GLOBAL CHRONOLOGICAL
   * ORDER rather than symbol by symbol.
   *
   * Ordering by symbol makes shared learning impossible to do honestly: a tally
   * accumulated across symbols would hold the first symbol's 2026 outcomes while
   * the second symbol's 1985 bars were still being decided. Per-symbol tallies
   * avoid that but are far too thin to act on — a single name yields tens of
   * trades per factor, where the pooled estimate that showed a real edge rests on
   * thousands.
   *
   * Walking the merged timeline gives both: one tally, pooled across the whole
   * universe, that at any instant contains only outcomes which had actually
   * resolved by that date.
   */
  const loaded: { symbol: string; bars: readonly BacktestBar[] }[] = [];
  for (const symbol of symbols) {
    const bars = await dataSource.bars(symbol);
    if (bars.length >= warmup + horizon + 1) loaded.push({ symbol, bars: freezeSeries(bars) });
  }

  interface Decision { s: number; i: number; t: number }
  const timeline: Decision[] = [];
  loaded.forEach((entry, s) => {
    for (let i = warmup; i < entry.bars.length - horizon; i++) {
      const t = Date.parse(entry.bars[i].datetime);
      if (t < fromMs || t > toMs) continue;
      timeline.push({ s, i, t });
    }
  });
  timeline.sort((a, b) => a.t - b.t || a.s - b.s);

  const learnedStats: LearnedTally = {};
  /** Per-symbol concurrency bookkeeping, preserved across the merged walk. */
  const openUntil: number[][] = loaded.map(() => []);
  /** Graded trades awaiting the date they actually resolved on. */
  let pendingFeedback: {
    readyAt: number;
    votes: readonly BacktestFactorVote[];
    forwardReturn: number;
    bias: 'LONG' | 'SHORT';
    realizedR: number | null;
  }[] = [];
  /**
   * Realised R per direction, released on the same schedule as factor feedback.
   *
   * Gated rather than accumulated eagerly for the same reason: a trade decided
   * at bar i is graded from bars i+1..i+20, so its outcome is available to the
   * loop long before it would have been available in life.
   */
  const directionTally: { LONG: { n: number; sumR: number }; SHORT: { n: number; sumR: number } } = {
    LONG: { n: 0, sumR: 0 }, SHORT: { n: 0, sumR: 0 },
  };

  for (const d of timeline) {
    const { symbol, bars } = loaded[d.s];
    const i = d.i;
    const decisionBar = bars[i];

    // Release feedback whose trade resolved on or before this DATE. Comparing
    // dates rather than bar indices is what makes pooling across symbols sound.
    const stillPending: typeof pendingFeedback = [];
    for (const p of pendingFeedback) {
      if (p.readyAt <= d.t) {
        for (const v of p.votes) {
          const sc = directionalScore(v.bias, p.forwardReturn);
          if (sc === null) continue;
          const cur = learnedStats[v.factorName] ??= {
            wins: 0, losses: 0, score: 0, tries: 0,
            bullishVotes: 0, bullishWins: 0, bearishVotes: 0, bearishWins: 0,
          };
          cur.tries += 1;
          const won = sc > 0;
          if (won) { cur.wins += 1; cur.score += 1; } else { cur.losses += 1; }
          // Split by direction voted, so the strategy can measure informedness
          // instead of a hit rate that mostly reports the factor's vote mix.
          if (v.bias === 'bullish') { cur.bullishVotes += 1; if (won) cur.bullishWins += 1; }
          else { cur.bearishVotes += 1; if (won) cur.bearishWins += 1; }
        }
        if (p.realizedR !== null) {
          const bucket = directionTally[p.bias];
          bucket.n += 1;
          bucket.sumR += p.realizedR;
        }
      } else {
        stillPending.push(p);
      }
    }
    pendingFeedback = stillPending;

    const open = openUntil[d.s].filter(end => end > i);
    openUntil[d.s] = open;
    if (open.length >= maxConcurrent) continue;

    // Thinning is applied here, after the concurrency gate, so the sampled grid
    // is the same one an unthinned run would have decided on.
    if (decideEvery > 1 && eligible++ % decideEvery !== 0) continue;

    let benchmarkBars: readonly BacktestBar[] | undefined;
    if (benchmark) {
      while (benchmarkCursor < benchmarkTimes.length && benchmarkTimes[benchmarkCursor] <= d.t) benchmarkCursor++;
      // The cursor now sits one past the last benchmark bar at or before the
      // decision date, which is exactly the visible prefix.
      benchmarkBars = benchmarkCursor > 0 ? visibleSlice(benchmark, benchmarkCursor - 1) : undefined;
    }

    const ctx: DecisionContext = {
      symbol,
      asOf: decisionBar.datetime,
      bars: visibleSlice(bars, i),
      benchmarkBars,
      factorStats: learnedStats,
      directionStats: directionTally,
    };

    const plan = await strategy.plan(ctx);
    if (!plan) continue;

    const futureBars: GradeInput[] = bars
      .slice(i + 1, i + 1 + horizon)
      .map(b => ({ high: b.high, low: b.low, close: b.close }));

    const grade = gradeOutcome(futureBars, plan.target, plan.stop, plan.bias, plan.entry, horizon);
    openUntil[d.s].push(i + grade.barsElapsed);

    const horizonLow = Math.min(...futureBars.map(b => b.low));
    const horizonHigh = Math.max(...futureBars.map(b => b.high));
    const zoneErr = (zone: { top: number; bottom: number } | undefined, actual: number) =>
      zone && plan.atr && plan.atr > 0
        ? Number((Math.abs((zone.top + zone.bottom) / 2 - actual) / plan.atr).toFixed(3))
        : null;

    trades.push({
      symbol,
      asOf: decisionBar.datetime,
      bias: plan.bias,
      entry: plan.entry,
      stop: plan.stop,
      target: plan.target,
      outcome: grade.outcome,
      realizedR: grade.realizedR,
      forwardReturn: grade.forwardReturn,
      barsElapsed: grade.barsElapsed,
      setupKey: plan.setupKey,
      demandZoneErrorAtr: zoneErr(plan.demandZone, horizonLow),
      supplyZoneErrorAtr: zoneErr(plan.supplyZone, horizonHigh),
      conviction: plan.conviction ?? null,
      sizeMultiplier: plan.sizeMultiplier ?? null,
      regime: plan.regime ?? null,
      coverage: plan.coverage ?? null,
      factorVotes: (plan.factors ?? []).map(f => ({ factorName: f.factorName, bias: f.bias })),
    });

    // Becomes visible once the calendar reaches the bar this trade resolved on.
    // Queued for every graded trade rather than only those carrying factor
    // votes, because the direction tally does not depend on who voted.
    if (grade.forwardReturn !== null && !grade.ambiguous) {
      const resolveIdx = Math.min(bars.length - 1, i + Math.max(1, grade.barsElapsed));
      pendingFeedback.push({
        readyAt: Date.parse(bars[resolveIdx].datetime),
        votes: plan.factors ?? [],
        forwardReturn: grade.forwardReturn,
        bias: plan.bias,
        realizedR: grade.realizedR,
      });
    }

    const setupKey = plan.setupKey ?? `GLOBAL|${plan.bias}`;
    setupStats[setupKey] ??= emptyStats(decisionBar.datetime);
    setupStats[setupKey] = observe(
      setupStats[setupKey],
      { score: grade.realizedR ?? 0, won: grade.outcome === 'TARGET', ambiguous: grade.ambiguous },
      decisionBar.datetime,
      halfLife,
    );

    if (plan.factors && grade.forwardReturn !== null && !grade.ambiguous) {
      for (const f of plan.factors) {
        const score = directionalScore(f.bias, grade.forwardReturn);
        if (score === null) continue;
        factorStats[f.factorName] ??= emptyStats(decisionBar.datetime);
        factorStats[f.factorName] = observe(
          factorStats[f.factorName],
          { score, won: score > 0 },
          decisionBar.datetime,
          halfLife,
        );
      }
    }
  }

  // Bring every series to a common "now" so cross-key comparisons are not
  // distorted by whichever symbol happened to be replayed last.
  const lastAt = trades.length > 0 ? trades[trades.length - 1].asOf : new Date(0).toISOString();
  for (const k of Object.keys(factorStats)) factorStats[k] = decayStats(factorStats[k], lastAt, halfLife);
  for (const k of Object.keys(setupStats)) setupStats[k] = decayStats(setupStats[k], lastAt, halfLife);

  // Chronological order matters for the equity curve: replaying symbol-by-symbol
  // would otherwise report one name's full run before another's ever starts.
  const resolvedTrades = trades
    .filter(t => !(t.outcome === 'AMBIGUOUS') && t.realizedR !== null)
    .sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf));

  const equityCurveR: number[] = [];
  let cumulative = 0;
  for (const t of resolvedTrades) {
    cumulative += t.realizedR!;
    equityCurveR.push(Number(cumulative.toFixed(4)));
  }

  // Size-weighted curve on the same resolved trades, mean-normalised.
  const sizes = resolvedTrades.map(t => t.sizeMultiplier ?? 1);
  const meanSize = sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length : 1;
  const sizedCurve: number[] = [];
  let sizedCum = 0;
  resolvedTrades.forEach((t, i) => {
    sizedCum += (t.realizedR ?? 0) * ((sizes[i] ?? 1) / (meanSize || 1));
    sizedCurve.push(Number(sizedCum.toFixed(4)));
  });

  const wins = resolvedTrades.filter(t => t.outcome === 'TARGET').length;
  const losses = resolvedTrades.length - wins;
  const ambiguous = trades.filter(t => t.outcome === 'AMBIGUOUS').length;

  return {
    strategy: strategy.name,
    trades,
    stats: {
      total: trades.length,
      resolved: resolvedTrades.length,
      ambiguous,
      wins,
      losses,
      winRate: resolvedTrades.length > 0 ? wins / resolvedTrades.length : null,
      expectancyR: resolvedTrades.length > 0 ? cumulative / resolvedTrades.length : null,
      totalR: Number(cumulative.toFixed(4)),
      maxDrawdownR: Number(maxDrawdown(equityCurveR).toFixed(4)),
      equityCurveR,
      sizedTotalR: Number(sizedCum.toFixed(4)),
      sizedMaxDrawdownR: Number(maxDrawdown(sizedCurve).toFixed(4)),
      meanSize: Number(meanSize.toFixed(3)),
    },
    zoneError: {
      demandMedianAtr: median(trades.map(t => t.demandZoneErrorAtr)),
      supplyMedianAtr: median(trades.map(t => t.supplyZoneErrorAtr)),
      demandN: trades.filter(t => t.demandZoneErrorAtr !== null).length,
      supplyN: trades.filter(t => t.supplyZoneErrorAtr !== null).length,
    },
    factorStats,
    setupStats,
  };
}

/** Convenience re-exports so callers need one import for reporting. */
export { expectancy, winRate };
