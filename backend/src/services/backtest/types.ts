/**
 * Backtest data contract.
 *
 * Deliberately provider-agnostic: the replay engine never knows whether bars
 * came from Schwab, Yahoo, a CSV dump, or a Parquet archive. Point a new
 * `BacktestDataSource` at whatever 10–20y history you obtain and the engine,
 * the grading rules, and the learning rules all stay identical to production.
 */

/** One daily (or intraday) OHLCV bar. */
export interface BacktestBar {
  /** ISO-8601. Must be UTC or carry an explicit offset — never a naive local string. */
  readonly datetime: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export interface BacktestDataSource {
  /** Universe to replay over. */
  symbols(): Promise<string[]>;
  /**
   * Bars for one symbol, ascending by datetime.
   *
   * Implementations MUST return survivorship-bias-free history where possible —
   * a universe of today's listed names replayed over 20 years silently deletes
   * every company that failed, which is the single most common way a backtest
   * manufactures an edge that never existed.
   */
  bars(symbol: string): Promise<readonly BacktestBar[]>;
}

/** A factor's directional vote at decision time, mirroring FactorResult. */
export interface BacktestFactorVote {
  readonly factorName: string;
  readonly bias: 'bullish' | 'bearish' | 'neutral';
}

/** A price band the strategy expects price to react at. */
export interface BacktestZone {
  readonly top: number;
  readonly bottom: number;
  /** False when the engine fell back to a placeholder band around spot. */
  readonly structural: boolean;
}

/** A trade plan a strategy emits at one point in time. */
export interface BacktestPlan {
  readonly bias: 'LONG' | 'SHORT';
  readonly entry: number;
  readonly stop: number;
  readonly target: number;
  /** Optional per-factor votes, so factor-level learning can be replayed too. */
  readonly factors?: readonly BacktestFactorVote[];
  /** Free-form grouping key for setup stats, e.g. `${regime}|${setupType}`. */
  readonly setupKey?: string;
  /**
   * Zones and the ATR they were sized against, so the replay can score zone
   * PLACEMENT independently of whether the trade won.
   *
   * The strategy cannot measure this itself without seeing the future; the engine
   * holds the forward bars, so it does the scoring. A zone can be well placed on a
   * losing trade and badly placed on a winning one, and the two failures need
   * different fixes.
   */
  readonly demandZone?: BacktestZone;
  readonly supplyZone?: BacktestZone;
  readonly atr?: number;
  /**
   * The engine's conviction at decision time, carried so the replay can test
   * whether it PREDICTS anything. A score nothing validates is decoration, and
   * conviction drives ranking and display throughout the product.
   */
  readonly conviction?: number;
  /**
   * Position size as a multiple of the baseline unit, from the accuracy signal.
   * The replay reports a size-weighted equity curve alongside the flat one so
   * the two can be compared on identical trades.
   */
  readonly sizeMultiplier?: number;
  readonly regime?: string;
  /** Fraction of the factor set that reported — the coverage term's input. */
  readonly coverage?: number;
}

/**
 * What a strategy is allowed to see when deciding.
 *
 * `bars` is history UP TO AND INCLUDING the decision bar and nothing after it.
 * The replay engine constructs this slice itself and freezes it; a strategy
 * cannot reach past it to peek at the future even by accident.
 */
/** Per-factor learned accuracy, in the shape compositeScore consumes. */
export interface LearnedFactorStats {
  readonly [factorName: string]: {
    wins: number; losses: number; score: number; tries: number; ambiguous?: number;
    /**
     * Resolved votes and hits split by the direction VOTED.
     *
     * Carried so downstream scoring can measure informedness rather than raw
     * accuracy. A pooled hit rate cannot distinguish skill from a factor's own
     * long/short mix once the underlying series drifts, and equities drift.
     */
    bullishVotes?: number; bullishWins?: number;
    bearishVotes?: number; bearishWins?: number;
  };
}

export interface DecisionContext {
  readonly symbol: string;
  /** Datetime of the most recent visible bar — the moment the decision is made. */
  readonly asOf: string;
  readonly bars: readonly BacktestBar[];
  /**
   * Benchmark history through `asOf` and no further, when the replay was given
   * a benchmark symbol.
   *
   * Aligned by DATE rather than by bar index: the benchmark and the symbol do
   * not share a trading calendar once listings, halts and holidays differ, so
   * an index-aligned slice would quietly compare different days.
   */
  readonly benchmarkBars?: readonly BacktestBar[];
  /**
   * Factor accuracy learned from trades that had already RESOLVED by `asOf`.
   *
   * The gating is the whole point. A replay grades a plan decided at bar i using
   * bars i+1..i+20, so that grade is available to the loop long before it would
   * have been available in life. Feeding it into a decision at bar i+8 would leak
   * twelve bars of future — the kind of look-ahead that silently inflates a
   * backtest while every individual step looks reasonable. The engine therefore
   * holds each graded trade until the decision index passes the bar on which it
   * actually resolved.
   */
  readonly factorStats?: LearnedFactorStats;
  /**
   * Realised expectancy per trade direction, from trades that had already
   * RESOLVED by `asOf` — gated exactly like `factorStats`, and for the same
   * reason. Feeds the explicit direction tilt in position sizing.
   */
  readonly directionStats?: {
    readonly LONG?: { n: number; sumR: number };
    readonly SHORT?: { n: number; sumR: number };
  };
}

export interface BacktestStrategy {
  readonly name: string;
  /**
   * Return null to stand aside on this bar.
   *
   * May be async: the production engine evaluates factors asynchronously, and a
   * harness that could only host synchronous strategies could never replay the
   * system actually being run. Synchronous strategies still satisfy this.
   */
  plan(ctx: DecisionContext): Promise<BacktestPlan | null> | BacktestPlan | null;
}
