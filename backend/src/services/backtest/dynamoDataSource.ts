/**
 * `BacktestDataSource` backed by the DynamoDB bar store.
 *
 * This is the seam the replay engine was written against: the engine never
 * learns where bars came from, so a strategy validated here is validated on the
 * same series the store will hand the live loop.
 *
 * Bars are cached in memory per instance. A replay walks a symbol's full series
 * once, but a multi-strategy sweep would otherwise re-read the same forty years
 * from DynamoDB for every strategy.
 */

import { getBars, getCoverage, partitionKey } from './barStore.js';
import { scanItems } from '../dynamodb.js';
import type { BacktestBar, BacktestDataSource } from './types.js';
import type { BarInterval } from '../marketData/fetchBars.js';
import type { DynamoDBBaseItem } from '../../types.js';

export interface DynamoDataSourceOptions {
  /** Explicit universe. Omit to replay every symbol the store holds. */
  readonly symbols?: readonly string[];
  readonly interval?: BarInterval;
  /** Inclusive ISO date bounds applied at read time. */
  readonly from?: string;
  readonly to?: string;
  /**
   * Drop symbols with fewer than this many bars in range.
   *
   * A symbol with 47 bars cannot support a 50-bar warmup plus a 20-bar horizon;
   * including it adds noise to the trade count without ever producing a trade.
   */
  readonly minBars?: number;
}

interface StoredMeta extends DynamoDBBaseItem {
  readonly symbol: string;
  readonly interval: BarInterval;
  readonly barCount: number;
}

/** Every symbol with stored coverage at `interval`, from the META items. */
export async function listStoredSymbols(interval: BarInterval = '1day'): Promise<string[]> {
  const items = await scanItems<StoredMeta>({
    FilterExpression: 'sk = :meta AND begins_with(pk, :prefix) AND #iv = :interval',
    ExpressionAttributeNames: { '#iv': 'interval' },
    ExpressionAttributeValues: { ':meta': 'META', ':prefix': 'BARS#', ':interval': interval },
  });
  return items.map(i => i.symbol).sort();
}

export class DynamoBarDataSource implements BacktestDataSource {
  private readonly interval: BarInterval;
  private readonly cache = new Map<string, readonly BacktestBar[]>();
  private resolvedSymbols: string[] | null = null;

  constructor(private readonly options: DynamoDataSourceOptions = {}) {
    this.interval = options.interval ?? '1day';
  }

  async symbols(): Promise<string[]> {
    if (this.resolvedSymbols) return this.resolvedSymbols;

    const candidates = this.options.symbols
      ? this.options.symbols.map(s => s.toUpperCase())
      : await listStoredSymbols(this.interval);

    const minBars = this.options.minBars ?? 0;
    if (minBars <= 0) {
      this.resolvedSymbols = [...candidates];
      return this.resolvedSymbols;
    }

    // Filtered on the cheap META read rather than by loading every series:
    // barCount is a superset of the in-range count, so this only drops symbols
    // that could not possibly qualify. Short in-range slices still get filtered
    // by the engine's own `warmup + horizon` guard.
    const kept: string[] = [];
    for (const symbol of candidates) {
      const coverage = await getCoverage(symbol, this.interval);
      if (coverage && coverage.barCount >= minBars) kept.push(symbol);
    }
    this.resolvedSymbols = kept;
    return kept;
  }

  async bars(symbol: string): Promise<readonly BacktestBar[]> {
    const key = symbol.toUpperCase();
    const cached = this.cache.get(key);
    if (cached) return cached;

    const bars = await getBars(key, this.interval, {
      ...(this.options.from !== undefined ? { from: this.options.from } : {}),
      ...(this.options.to !== undefined ? { to: this.options.to } : {}),
    });

    if (bars.length === 0) {
      console.warn(
        `[DynamoBarDataSource] No stored bars for ${key} @ ${this.interval} ` +
          `(partition ${partitionKey(key, this.interval)}). Run the backfill first.`,
      );
    }

    this.cache.set(key, bars);
    return bars;
  }
}
