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
}

/**
 * What a strategy is allowed to see when deciding.
 *
 * `bars` is history UP TO AND INCLUDING the decision bar and nothing after it.
 * The replay engine constructs this slice itself and freezes it; a strategy
 * cannot reach past it to peek at the future even by accident.
 */
export interface DecisionContext {
  readonly symbol: string;
  /** Datetime of the most recent visible bar — the moment the decision is made. */
  readonly asOf: string;
  readonly bars: readonly BacktestBar[];
}

export interface BacktestStrategy {
  readonly name: string;
  /** Return null to stand aside on this bar. */
  plan(ctx: DecisionContext): BacktestPlan | null;
}
