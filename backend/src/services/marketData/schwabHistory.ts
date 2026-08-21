/**
 * Date-ranged historical bar fetching, for backfills rather than live views.
 *
 * `getPriceHistorySchwab` asks Schwab for a *relative* window (`periodType`
 * plus `period`), which caps `1day` at six months — right for a chart, useless
 * for a backtest. Schwab also accepts explicit `startDate`/`endDate` epochs,
 * and with those it returns the symbol's entire listed history in one response:
 * measured against the live API, AAPL returns 10,489 daily bars from 1985-01-02,
 * MSFT from 1986, SPY from 1993, NVDA from 1999. No pagination is involved.
 *
 * Two hard limits, both measured against the live API rather than assumed:
 *
 * - **Minute history is ~31 days deep.** A 1-min window ending 30 days ago
 *   returns data; 45 days ago returns `empty: true`. The same is true at 30-min
 *   granularity years back. There is no historical intraday backfill from
 *   Schwab at any frequency — intraday history has to be accumulated forward.
 * - **Delisted symbols return nothing.** FTCH returns zero bars. A universe
 *   assembled from today's listings is therefore survivorship-biased, exactly
 *   as `backtest/types.ts` warns, and no amount of care in this module fixes it.
 *
 * Index symbols (`$VIX.X`, `$TNX.X`) return empty from Schwab's pricehistory
 * endpoint entirely, so `^`-prefixed symbols are routed to Yahoo, which carries
 * ^VIX back to 1990.
 */

import { schwabFor } from '../brokers/index.js';
import { yf } from '../yahoo.js';
import type { BarInterval } from './fetchBars.js';
import type { RawBar, BarSourceProvider } from '../backtest/barStore.js';

// NOTE: no module-level connection. A Lambda container is reused across
// invocations, so a cached token would authorize the next user's request with
// the previous user's credential. Build one per call via schwabFor().

/**
 * Schwab documents 120 requests/minute. 550 ms between calls holds us to ~109,
 * leaving headroom for the token refresh that fires every 25 minutes mid-run.
 */
const MIN_REQUEST_GAP_MS = 550;
let lastRequestAt = 0;

async function throttle(): Promise<void> {
  const wait = lastRequestAt + MIN_REQUEST_GAP_MS - Date.now();
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

interface SchwabFrequency {
  periodType: string;
  frequencyType: string;
  frequency: string;
}

/**
 * Frequency mapping for date-ranged requests.
 *
 * `periodType` still has to be supplied even when `period` is omitted, and
 * Schwab validates the (periodType, frequencyType) pair — `day` only accepts
 * `minute`, `year` accepts `daily`/`weekly`/`monthly`.
 */
const FREQUENCY: Record<BarInterval, SchwabFrequency> = {
  '1min': { periodType: 'day', frequencyType: 'minute', frequency: '1' },
  '5min': { periodType: 'day', frequencyType: 'minute', frequency: '5' },
  '15min': { periodType: 'day', frequencyType: 'minute', frequency: '15' },
  '30min': { periodType: 'day', frequencyType: 'minute', frequency: '30' },
  // Schwab has no 60-minute frequency; 30-minute bars are the finest honest
  // stand-in, and callers that need hourly should aggregate two of them.
  '1h': { periodType: 'day', frequencyType: 'minute', frequency: '30' },
  '1day': { periodType: 'year', frequencyType: 'daily', frequency: '1' },
  '1week': { periodType: 'year', frequencyType: 'weekly', frequency: '1' },
  '1month': { periodType: 'year', frequencyType: 'monthly', frequency: '1' },
};

const YAHOO_INTERVAL: Partial<Record<BarInterval, string>> = {
  '1day': '1d',
  '1week': '1wk',
  '1month': '1mo',
};

export interface HistoryRangeResult {
  readonly bars: RawBar[];
  readonly provider: BarSourceProvider;
  /** True when the provider explicitly reported no data for the range. */
  readonly empty: boolean;
}

export interface FetchHistoryOptions {
  readonly extendedHours?: boolean;
  /** Retries on 429/5xx before giving up. */
  readonly maxRetries?: number;
}

/** Symbols Schwab's pricehistory endpoint has no history for. */
function isIndexSymbol(symbol: string): boolean {
  return symbol.startsWith('^') || symbol.startsWith('$');
}

async function fetchYahooRange(
  symbol: string,
  interval: BarInterval,
  startMs: number,
  endMs: number,
): Promise<HistoryRangeResult> {
  const yahooInterval = YAHOO_INTERVAL[interval];
  if (!yahooInterval) {
    throw new Error(`Yahoo fallback does not cover interval "${interval}" — intraday depth is too shallow to be worth it.`);
  }

  const chart = await yf.chart(symbol, {
    period1: new Date(startMs),
    period2: new Date(endMs),
    interval: yahooInterval as any,
  });

  const bars: RawBar[] = [];
  for (const q of chart.quotes ?? []) {
    // Yahoo emits null OHLC rows on halted or untraded days; a null close would
    // become NaN in every downstream indicator.
    if (q.close === null || q.open === null || q.high === null || q.low === null) continue;
    bars.push({
      timestamp: new Date(q.date).getTime(),
      open: q.open!,
      high: q.high!,
      low: q.low!,
      close: q.close!,
      volume: q.volume ?? 0,
    });
  }

  return { bars, provider: 'yahoo', empty: bars.length === 0 };
}

/**
 * Fetch every bar Schwab holds for `symbol` between two epochs, ascending.
 *
 * Throttled and retried internally, so a caller can loop over a universe
 * sequentially without building its own rate limiter.
 */
export async function fetchHistoryRange(
  symbol: string,
  interval: BarInterval,
  startMs: number,
  endMs: number,
  options: FetchHistoryOptions = {},
): Promise<HistoryRangeResult> {
  if (isIndexSymbol(symbol)) {
    return fetchYahooRange(symbol.replace(/^\$/, '^'), interval, startMs, endMs);
  }

  const maxRetries = options.maxRetries ?? 3;
  const freq = FREQUENCY[interval];
  if (!freq) throw new Error(`Unsupported interval for historical fetch: ${interval}`);

  const params = new URLSearchParams({
    symbol,
    periodType: freq.periodType,
    frequencyType: freq.frequencyType,
    frequency: freq.frequency,
    needExtendedHoursData: String(options.extendedHours ?? false),
    startDate: String(Math.floor(startMs)),
    endDate: String(Math.floor(endMs)),
  });

  let lastError: string = 'unknown';

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await throttle();

    const accessToken = await schwabFor().getAccessToken();
    if (!accessToken) {
      throw new Error(
        'No valid Schwab access token. Refresh tokens last 7 days — re-run the Schwab auth setup script.',
      );
    }

    const response = await fetch(`https://api.schwabapi.com/marketdata/v1/pricehistory?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });

    if (response.ok) {
      const data = (await response.json()) as { candles?: any[]; empty?: boolean };
      const candles = data.candles ?? [];
      const bars: RawBar[] = candles.map(c => ({
        timestamp: c.datetime,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume ?? 0,
      }));
      bars.sort((a, b) => a.timestamp - b.timestamp);
      return { bars, provider: 'schwab', empty: bars.length === 0 };
    }

    lastError = `${response.status} ${(await response.text()).slice(0, 200)}`;

    // 4xx other than 429 is a request we got wrong — retrying sends the same
    // broken request 3 more times and burns rate-limit budget for nothing.
    if (response.status !== 429 && response.status < 500) {
      throw new Error(`Schwab history failed for ${symbol}: ${lastError}`);
    }

    const backoffMs = 1000 * 2 ** attempt;
    await new Promise(resolve => setTimeout(resolve, backoffMs));
  }

  throw new Error(`Schwab history failed for ${symbol} after ${maxRetries} retries: ${lastError}`);
}

/**
 * How deep Schwab's intraday history actually goes, measured 2026-08-19.
 *
 * Used by the rolling capture job to size its trailing window: asking for more
 * than this returns `empty: true` and wastes a request.
 */
export const SCHWAB_INTRADAY_LOOKBACK_DAYS = 31;
