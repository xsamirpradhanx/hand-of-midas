/**
 * Rolling intraday capture — the only way to ever own intraday history here.
 *
 * Schwab's pricehistory endpoint holds roughly 31 days of minute bars and
 * nothing older: measured on 2026-08-19, a 1-min window ending 30 days back
 * returns data and one ending 45 days back returns `empty: true`, and the same
 * is true of 30-min bars requested years back. There is no intraday backfill to
 * run. The only path to a year of minute data is to start capturing now and let
 * it accumulate, which is what this job does.
 *
 * Each run re-fetches a trailing window rather than just yesterday. Two reasons:
 * a missed run (laptop asleep, token expired) heals itself on the next one, and
 * `putBars` merges by timestamp so re-reading a day already stored costs a write
 * and changes nothing.
 *
 * Deliberately NOT deployed as a Lambda yet. Schwab credentials are not in the
 * stack's `sharedEnv`, and Schwab refresh tokens expire after 7 days with no
 * silent rotation — a cron in Lambda would die every week until the token is
 * re-minted by hand. Running it from the local dev scheduler, where
 * `.schwab_token.json` lives and gets refreshed, is the honest version until
 * that token lifecycle is solved.
 */

import { fetchHistoryRange, SCHWAB_INTRADAY_LOOKBACK_DAYS } from '../marketData/schwabHistory.js';
import { putBars, getCoverage } from './barStore.js';
import { getWatchlistSymbols } from './backfillUniverse.js';
import type { BarInterval } from '../marketData/fetchBars.js';

const DAY_MS = 86_400_000;

/**
 * Benchmarks are captured alongside the watchlist because almost every
 * intraday factor is relative — a minute series for a name with no matching
 * index series can't produce a relative-strength or beta read.
 */
const INTRADAY_BENCHMARKS = ['SPY', 'QQQ', 'IWM'];

export interface IntradayCaptureOptions {
  readonly interval?: BarInterval;
  /** Trailing days re-fetched each run. First run for a symbol uses the full depth. */
  readonly trailingDays?: number;
  readonly symbols?: readonly string[];
  readonly extendedHours?: boolean;
}

export interface IntradayCaptureResult {
  readonly symbolsProcessed: number;
  readonly barsWritten: number;
  readonly empty: string[];
  readonly failed: Array<{ symbol: string; error: string }>;
}

export async function captureIntraday(
  options: IntradayCaptureOptions = {},
): Promise<IntradayCaptureResult> {
  const interval = options.interval ?? '1min';
  const trailingDays = options.trailingDays ?? 5;
  const extendedHours = options.extendedHours ?? true;

  const symbols =
    options.symbols?.map(s => s.toUpperCase()) ??
    Array.from(new Set([...(await getWatchlistSymbols()), ...INTRADAY_BENCHMARKS]));

  const now = Date.now();
  let barsWritten = 0;
  const empty: string[] = [];
  const failed: Array<{ symbol: string; error: string }> = [];

  for (const symbol of symbols) {
    try {
      const coverage = await getCoverage(symbol, interval);
      // Nothing stored yet: take everything Schwab still has rather than the
      // trailing window, since that history is gone for good in a month.
      const lookbackDays = coverage ? trailingDays : SCHWAB_INTRADAY_LOOKBACK_DAYS;
      const start = now - lookbackDays * DAY_MS;

      const result = await fetchHistoryRange(symbol, interval, start, now, { extendedHours });

      if (result.bars.length === 0) {
        empty.push(symbol);
        continue;
      }

      const written = await putBars(symbol, interval, result.bars, result.provider, { mode: 'merge' });
      barsWritten += written.barsWritten;
    } catch (err) {
      failed.push({ symbol, error: err instanceof Error ? err.message : String(err) });
    }
  }

  console.log(
    `[IntradayCapture] ${symbols.length} symbols @ ${interval}: ${barsWritten} bars stored, ` +
      `${empty.length} empty, ${failed.length} failed`,
  );
  if (failed.length) {
    for (const f of failed) console.warn(`[IntradayCapture] ${f.symbol}: ${f.error}`);
  }

  return { symbolsProcessed: symbols.length, barsWritten, empty, failed };
}
