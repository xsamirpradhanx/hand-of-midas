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
  };
  /** Decayed learning state, keyed by factor name. */
  readonly factorStats: Record<string, DecayedStats>;
  /** Decayed learning state, keyed by the plan's setupKey. */
  readonly setupStats: Record<string, DecayedStats>;
}

/**
 * The anti-look-ahead boundary.
 *
 * Returns a frozen copy of history through `index` inclusive. Copied rather
 * than a live view because `Array.prototype.slice` on the full series would
 * still let a strategy hold a reference to the parent array; frozen so a
 * strategy cannot mutate replay state between symbols.
 */
function visibleSlice(bars: readonly BacktestBar[], index: number): readonly BacktestBar[] {
  return Object.freeze(bars.slice(0, index + 1).map(b => Object.freeze({ ...b })));
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
  const fromMs = options.from ? Date.parse(options.from) : -Infinity;
  const toMs = options.to ? Date.parse(options.to) : Infinity;

  const trades: TradeRecord[] = [];
  const factorStats: Record<string, DecayedStats> = {};
  const setupStats: Record<string, DecayedStats> = {};

  const symbols = await dataSource.symbols();

  for (const symbol of symbols) {
    const bars = await dataSource.bars(symbol);
    if (bars.length < warmup + horizon + 1) continue;

    // Datetimes of plans still inside their grading horizon, used to enforce
    // maxConcurrentPerSymbol without letting a later plan see earlier results.
    let openUntilIndex: number[] = [];

    // Stop early enough that every plan gets a full horizon of future bars —
    // otherwise the tail of the series grades against a truncated window and
    // systematically over-reports TIMEOUT.
    for (let i = warmup; i < bars.length - horizon; i++) {
      const decisionBar = bars[i];
      const t = Date.parse(decisionBar.datetime);
      if (t < fromMs || t > toMs) continue;

      openUntilIndex = openUntilIndex.filter(end => end > i);
      if (openUntilIndex.length >= maxConcurrent) continue;

      const ctx: DecisionContext = {
        symbol,
        asOf: decisionBar.datetime,
        bars: visibleSlice(bars, i),
      };

      const plan = strategy.plan(ctx);
      if (!plan) continue;

      // Future bars start at i+1: a plan decided on bar i cannot be filled or
      // graded against bar i itself, which the strategy has already seen.
      const futureBars: GradeInput[] = bars
        .slice(i + 1, i + 1 + horizon)
        .map(b => ({ high: b.high, low: b.low, close: b.close }));

      const grade = gradeOutcome(
        futureBars,
        plan.target,
        plan.stop,
        plan.bias,
        plan.entry,
        horizon,
      );

      openUntilIndex.push(i + grade.barsElapsed);

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
      });

      // ── Learning: setups graded on realized R ──────────────────────────────
      const setupKey = plan.setupKey ?? `GLOBAL|${plan.bias}`;
      setupStats[setupKey] ??= emptyStats(decisionBar.datetime);
      setupStats[setupKey] = observe(
        setupStats[setupKey],
        {
          score: grade.realizedR ?? 0,
          won: grade.outcome === 'TARGET',
          ambiguous: grade.ambiguous,
        },
        decisionBar.datetime,
        halfLife,
      );

      // ── Learning: factors graded on their own directional claim ────────────
      // Note this uses forwardReturn, NOT the trade's outcome — a factor is
      // right or wrong about direction regardless of where the stop sat.
      if (plan.factors && grade.forwardReturn !== null && !grade.ambiguous) {
        for (const f of plan.factors) {
          const score = directionalScore(f.bias, grade.forwardReturn);
          if (score === null) continue; // neutral: abstains, never scored

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
    },
    factorStats,
    setupStats,
  };
}

/** Convenience re-exports so callers need one import for reporting. */
export { expectancy, winRate };
