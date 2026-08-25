import type { BacktestBar } from '../types.js';
import type { PolygonOptionsContract } from '../../polygon.js';
import type { OptionsChainRecord } from '../../marketData/optionsStore.js';

export interface OptionsDataSource {
  symbols(): Promise<string[]>;
  /** Historical equity bars. */
  bars(symbol: string): Promise<readonly BacktestBar[]>;
  /** Historical options chain for a specific date (if available). */
  historicalChain(symbol: string, dateStr: string): Promise<OptionsChainRecord | null>;
}

export interface OptionsDecisionContext {
  readonly symbol: string;
  readonly bars: readonly BacktestBar[]; // Up to and including the current decision bar
  readonly currentChain: OptionsChainRecord | null;
}

export interface OptionsBacktestPlan {
  readonly bias: 'LONG' | 'SHORT';
  readonly selectedContract: PolygonOptionsContract;
  readonly entryPremium: number;
  readonly stopPremium: number;
  readonly targetPremium: number;
  readonly expectedHoldDays: number;
  readonly conviction?: number;
}

export interface OptionsBacktestStrategy {
  /** Given the context, optionally return a plan. */
  decide(context: OptionsDecisionContext): OptionsBacktestPlan | undefined;
}
