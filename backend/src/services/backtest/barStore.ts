/**
 * Historical bar store on the existing single-table DynamoDB design.
 *
 * Layout — one partition per symbol+interval, one item per time chunk:
 *
 *   pk  BARS#AAPL#1day        sk  CHUNK#1998        (a calendar year of daily bars)
 *   pk  BARS#AAPL#1min        sk  CHUNK#2026-08-19  (one ET session of minute bars)
 *   pk  BARS#AAPL#1day        sk  META              (coverage summary)
 *
 * Two decisions drive that shape:
 *
 * 1. **Chunked, not one item per bar.** Forty years of daily bars is ~10,500
 *    items per symbol if stored individually; a replay that reads every symbol
 *    would then issue millions of item reads for a dataset that fits in RAM.
 *    Chunking makes a full-history read ~40 items and a full backfill ~40
 *    writes. It also keeps the write cost of the initial load at cents.
 *
 * 2. **Columnar inside a chunk.** Storing `[{datetime,open,high,...}, ...]`
 *    repeats six attribute names per bar, and DynamoDB charges for attribute
 *    names. Six parallel numeric arrays (`t/o/h/l/c/v`) cut a year of daily
 *    bars to roughly 13 KB, far under the 400 KB item ceiling.
 *
 * Chunk boundaries are computed in **Eastern time**, not UTC: an extended-hours
 * session runs to 20:00 ET, which is already the next UTC day, so UTC chunking
 * would split a single session across two items.
 *
 * Prices are stored exactly as the provider returned them. Schwab daily bars
 * are split-adjusted but NOT dividend-adjusted — the right convention for a
 * swing/options backtest, which fills at prices that actually traded, but the
 * wrong one for total-return comparisons. `source` on every chunk records
 * which provider's convention applies.
 */

import { getItem, putItem, queryItems, queryItemsBetween } from '../dynamodb.js';
import type { DynamoDBBaseItem } from '../../types.js';
import type { BarInterval } from '../marketData/fetchBars.js';
import type { BacktestBar } from './types.js';

export type BarSourceProvider = 'schwab' | 'yahoo';

/** Intervals chunked by calendar year. Everything else is chunked by session. */
const YEAR_CHUNKED: ReadonlySet<BarInterval> = new Set<BarInterval>(['1day', '1week', '1month']);

/**
 * Refuse to write a chunk larger than this.
 *
 * A DynamoDB item is capped at 400 KB. Measured against a real stored chunk —
 * AAPL 1-min, 1,098 bars, 115 KB — columnar bars cost ~107 bytes each, so 3,000
 * bars is ~320 KB. That leaves room for any real chunk (a year of daily bars is
 * ~252; a full extended-hours session of minute bars is ~960) while still
 * catching a mis-chunked interval before DynamoDB rejects the write with an
 * opaque ValidationException.
 */
const MAX_BARS_PER_CHUNK = 3000;

/** A stored chunk of bars, columnar. All six arrays share one index space. */
export interface BarChunkItem extends DynamoDBBaseItem {
  readonly symbol: string;
  readonly interval: BarInterval;
  readonly chunkId: string;
  /** Epoch milliseconds, ascending, unique. */
  readonly t: number[];
  readonly o: number[];
  readonly h: number[];
  readonly l: number[];
  readonly c: number[];
  readonly v: number[];
  readonly count: number;
  readonly source: BarSourceProvider;
  readonly updatedAt: string;
}

/** Coverage summary for one symbol+interval. Cheap to read before a backfill. */
export interface BarCoverageItem extends DynamoDBBaseItem {
  readonly symbol: string;
  readonly interval: BarInterval;
  readonly firstTs: number;
  readonly lastTs: number;
  readonly barCount: number;
  readonly chunkCount: number;
  readonly source: BarSourceProvider;
  readonly updatedAt: string;
  /** Human-readable note on the price convention, carried with the data. */
  readonly adjustment: string;
}

const ET_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** `2026-08-19` in Eastern time, regardless of the host's timezone. */
export function etDateString(ts: number): string {
  return ET_DATE.format(new Date(ts));
}

export function partitionKey(symbol: string, interval: BarInterval): string {
  return `BARS#${symbol.toUpperCase()}#${interval}`;
}

/** The chunk a timestamp belongs to: `1998` for daily, `2026-08-19` intraday. */
export function chunkIdFor(interval: BarInterval, ts: number): string {
  const et = etDateString(ts);
  return YEAR_CHUNKED.has(interval) ? et.slice(0, 4) : et;
}

/**
 * Chunk ids sort lexicographically in time order within one interval, which is
 * what lets a date range become a single DynamoDB BETWEEN query. Year ids
 * (`1998`) and session ids (`2026-08-19`) are never mixed in one partition.
 */
function chunkSortKey(chunkId: string): string {
  return `CHUNK#${chunkId}`;
}

function unpack(item: BarChunkItem): BacktestBar[] {
  const bars: BacktestBar[] = [];
  for (let i = 0; i < item.t.length; i++) {
    bars.push({
      datetime: new Date(item.t[i]!).toISOString(),
      open: item.o[i]!,
      high: item.h[i]!,
      low: item.l[i]!,
      close: item.c[i]!,
      volume: item.v[i]!,
    });
  }
  return bars;
}

/** One bar as this module accepts it on write. */
export interface RawBar {
  /** Epoch milliseconds. */
  readonly timestamp: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

/**
 * Fold incoming bars into stored ones, keyed by SESSION rather than by epoch.
 *
 * Keying on the raw timestamp was wrong for year-chunked intervals and silently
 * duplicated sessions. Schwab does not return a stable epoch for a daily bar:
 * an incremental refetch of 2026-08-19 came back at 04:00Z where the original
 * backfill had stored 05:00Z — one hour apart, same date, same close. The two
 * did not collide, so the session was stored twice, and a duplicated daily bar
 * corrupts every rolling window that spans it. Worse, it compounds: each
 * incremental run re-fetches its boundary date and adds another copy.
 *
 * Daily/weekly/monthly bars are therefore deduplicated by ET calendar date —
 * the same key `chunkIdFor` already uses. Intraday keeps the exact timestamp,
 * where two bars in one session are the point rather than a defect.
 *
 * On collision the INCOMING values win (a late-corrected close should land) but
 * the EXISTING timestamp is kept, so a series does not shift under repeated
 * refreshes. That also makes this the repair path: any later merge into an
 * already-duplicated chunk collapses it.
 */
function mergeBars(existing: RawBar[], incoming: RawBar[], interval: BarInterval): RawBar[] {
  const bySession = new Map<string, RawBar>();
  const keyOf = (ts: number): string =>
    YEAR_CHUNKED.has(interval) ? etDateString(ts) : String(ts);

  for (const b of existing) bySession.set(keyOf(b.timestamp), b);
  for (const b of incoming) {
    const key = keyOf(b.timestamp);
    const prior = bySession.get(key);
    bySession.set(key, prior ? { ...b, timestamp: prior.timestamp } : b);
  }
  return Array.from(bySession.values()).sort((a, b) => a.timestamp - b.timestamp);
}

export interface PutBarsOptions {
  /**
   * `merge` (default) reads each touched chunk and folds the new bars in —
   * correct for incremental appends. `overwrite` skips those reads, which is
   * both faster and cheaper for a first-time backfill of a symbol that has no
   * stored coverage yet.
   */
  readonly mode?: 'merge' | 'overwrite';
}

export interface PutBarsResult {
  readonly chunksWritten: number;
  readonly barsWritten: number;
  readonly firstTs: number | null;
  readonly lastTs: number | null;
}

/**
 * Write bars for one symbol+interval and refresh its coverage summary.
 *
 * Idempotent: writing the same bars twice leaves the store unchanged.
 */
export async function putBars(
  symbol: string,
  interval: BarInterval,
  bars: readonly RawBar[],
  source: BarSourceProvider,
  options: PutBarsOptions = {},
): Promise<PutBarsResult> {
  const sym = symbol.toUpperCase();
  const pk = partitionKey(sym, interval);
  const mode = options.mode ?? 'merge';

  if (bars.length === 0) {
    return { chunksWritten: 0, barsWritten: 0, firstTs: null, lastTs: null };
  }

  const grouped = new Map<string, RawBar[]>();
  for (const bar of bars) {
    const id = chunkIdFor(interval, bar.timestamp);
    const bucket = grouped.get(id);
    if (bucket) bucket.push(bar);
    else grouped.set(id, [bar]);
  }

  const now = new Date().toISOString();
  let barsWritten = 0;

  for (const [chunkId, incoming] of grouped) {
    let final = incoming;

    if (mode === 'merge') {
      const prior = await getItem<BarChunkItem>(pk, chunkSortKey(chunkId));
      if (prior) {
        const priorRaw: RawBar[] = prior.t.map((ts, i) => ({
          timestamp: ts,
          open: prior.o[i]!,
          high: prior.h[i]!,
          low: prior.l[i]!,
          close: prior.c[i]!,
          volume: prior.v[i]!,
        }));
        final = mergeBars(priorRaw, incoming, interval);
      } else {
        final = mergeBars([], incoming, interval);
      }
    } else {
      final = mergeBars([], incoming, interval);
    }

    if (final.length > MAX_BARS_PER_CHUNK) {
      throw new Error(
        `Chunk ${pk}/${chunkId} would hold ${final.length} bars, over the ${MAX_BARS_PER_CHUNK} cap. ` +
          `Interval "${interval}" is chunked by ${YEAR_CHUNKED.has(interval) ? 'year' : 'session'}; ` +
          `a finer chunk boundary is needed for this interval.`,
      );
    }

    const item: BarChunkItem = {
      pk,
      sk: chunkSortKey(chunkId),
      symbol: sym,
      interval,
      chunkId,
      t: final.map(b => b.timestamp),
      o: final.map(b => b.open),
      h: final.map(b => b.high),
      l: final.map(b => b.low),
      c: final.map(b => b.close),
      v: final.map(b => b.volume),
      count: final.length,
      source,
      updatedAt: now,
    };

    await putItem(item);
    barsWritten += final.length;
  }

  const coverage = await refreshCoverage(sym, interval, source);

  return {
    chunksWritten: grouped.size,
    barsWritten,
    firstTs: coverage?.firstTs ?? null,
    lastTs: coverage?.lastTs ?? null,
  };
}

/**
 * Recompute the META item from the chunks that actually exist.
 *
 * Derived rather than incrementally maintained on purpose: a coverage summary
 * that drifts from the stored chunks would silently mislead the backfill into
 * skipping real gaps, and the recompute costs one query over ~40 items.
 */
export async function refreshCoverage(
  symbol: string,
  interval: BarInterval,
  source: BarSourceProvider,
): Promise<BarCoverageItem | null> {
  const sym = symbol.toUpperCase();
  const pk = partitionKey(sym, interval);
  const chunks = await queryItems<BarChunkItem>(pk, 'CHUNK#');
  if (chunks.length === 0) return null;

  let firstTs = Infinity;
  let lastTs = -Infinity;
  let barCount = 0;
  for (const chunk of chunks) {
    barCount += chunk.count;
    if (chunk.t.length === 0) continue;
    firstTs = Math.min(firstTs, chunk.t[0]!);
    lastTs = Math.max(lastTs, chunk.t[chunk.t.length - 1]!);
  }

  const item: BarCoverageItem = {
    pk,
    sk: 'META',
    symbol: sym,
    interval,
    firstTs,
    lastTs,
    barCount,
    chunkCount: chunks.length,
    source,
    updatedAt: new Date().toISOString(),
    adjustment:
      source === 'schwab'
        ? 'split-adjusted, NOT dividend-adjusted (Schwab pricehistory)'
        : 'provider close as returned; check adjclose separately (Yahoo)',
  };

  await putItem(item);
  return item;
}

export async function getCoverage(
  symbol: string,
  interval: BarInterval,
): Promise<BarCoverageItem | undefined> {
  return getItem<BarCoverageItem>(partitionKey(symbol, interval), 'META');
}

export interface GetBarsOptions {
  /** Inclusive ISO date or epoch ms lower bound. */
  readonly from?: string | number;
  /** Inclusive ISO date or epoch ms upper bound. */
  readonly to?: string | number;
}

function toMs(value: string | number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  // An unparseable bound would silently become NaN, and every `ts < NaN`
  // comparison is false — the range filter would quietly stop filtering.
  if (!Number.isFinite(ms)) throw new Error(`Unparseable date bound: ${String(value)}`);
  return ms;
}

/**
 * Read bars for one symbol+interval, ascending, optionally date-bounded.
 *
 * The date bounds narrow the DynamoDB query to the chunks that can contain
 * them, then trim at the bar level — so a five-year slice of a forty-year
 * series reads five items, not forty.
 */
export async function getBars(
  symbol: string,
  interval: BarInterval,
  options: GetBarsOptions = {},
): Promise<BacktestBar[]> {
  const pk = partitionKey(symbol, interval);
  const fromMs = toMs(options.from, -Infinity);
  const toMsBound = toMs(options.to, Infinity);

  const chunks =
    Number.isFinite(fromMs) || Number.isFinite(toMsBound)
      ? await queryItemsBetween<BarChunkItem>(
          pk,
          chunkSortKey(Number.isFinite(fromMs) ? chunkIdFor(interval, fromMs) : '0000'),
          // A trailing high character keeps the upper bound inclusive of every
          // session inside the boundary chunk (`CHUNK#2026-08-19` < `CHUNK#2026-08-19~`).
          chunkSortKey(Number.isFinite(toMsBound) ? `${chunkIdFor(interval, toMsBound)}~` : '9999~'),
        )
      : await queryItems<BarChunkItem>(pk, 'CHUNK#');

  chunks.sort((a, b) => a.chunkId.localeCompare(b.chunkId));

  const bars: BacktestBar[] = [];
  for (const chunk of chunks) {
    for (const bar of unpack(chunk)) {
      const ts = Date.parse(bar.datetime);
      if (ts < fromMs || ts > toMsBound) continue;
      bars.push(bar);
    }
  }
  return bars;
}
