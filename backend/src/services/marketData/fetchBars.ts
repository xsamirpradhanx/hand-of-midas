import { getPriceHistorySchwab } from '../schwabService.js';
import { yf } from '../yahoo.js';
import {
  getCachedData,
  setCachedData,
  timeSeriesCacheKey,
} from '../cache.js';
import type { OHLCVDataPoint } from '../../types.js';

// Canonical intervals used across the codebase.
export type BarInterval =
  | '1min'
  | '5min'
  | '15min'
  | '30min'
  | '1h'
  | '1day'
  | '1week'
  | '1month';

export type BarProvider = 'schwab' | 'yahoo';
export type BarSource = BarProvider | 'cache';

export interface FetchBarsOptions {
  extendedHours?: boolean;
  useCache?: boolean;
  preferredProvider?: BarProvider;
}

export interface FetchBarsResult {
  bars: OHLCVDataPoint[];
  source: BarSource;
  provider: BarProvider;
}

const INTRADAY_INTERVALS: ReadonlySet<BarInterval> = new Set<BarInterval>([
  '1min',
  '5min',
  '15min',
  '30min',
  '1h',
]);

const INTRADAY_TTL_SECONDS = 5 * 60;
const DAILY_TTL_SECONDS = 4 * 60 * 60;

const YAHOO_INTERVAL_MAP: Record<BarInterval, string> = {
  '1min': '1m',
  '5min': '5m',
  '15min': '15m',
  '30min': '30m',
  '1h': '60m',
  '1day': '1d',
  '1week': '1wk',
  '1month': '1mo',
};

// Yahoo's intraday history depth is bounded — we cap lookback so we don't 400.
function yahooLookbackMs(interval: BarInterval): number {
  const DAY = 24 * 60 * 60 * 1000;
  switch (interval) {
    case '1min':
      return 7 * DAY;
    case '5min':
    case '15min':
    case '30min':
    case '1h':
      return 59 * DAY;
    default:
      return 2 * 365 * DAY;
  }
}

function normalizeSchwabBars(raw: unknown[]): OHLCVDataPoint[] {
  const out: OHLCVDataPoint[] = [];
  for (const c of raw as Array<Record<string, number>>) {
    if (!c || typeof c.close !== 'number' || !Number.isFinite(c.close)) continue;
    const datetime = new Date(c.timestamp).toISOString();
    out.push({
      datetime,
      open: c.open ?? c.close,
      high: c.high ?? c.close,
      low: c.low ?? c.close,
      close: c.close,
      volume: c.volume ?? 0,
    });
  }
  return out;
}

function normalizeYahooBars(quotes: Array<Record<string, unknown>>): OHLCVDataPoint[] {
  const out: OHLCVDataPoint[] = [];
  for (const q of quotes) {
    const date = q.date as Date | undefined;
    const close = q.close as number | null | undefined;
    if (!date || close == null || !Number.isFinite(close)) continue;
    out.push({
      datetime: date.toISOString(),
      open: (q.open as number | null) ?? close,
      high: (q.high as number | null) ?? close,
      low: (q.low as number | null) ?? close,
      close,
      volume: (q.volume as number | null) ?? 0,
    });
  }
  return out;
}

async function fetchSchwab(
  symbol: string,
  interval: BarInterval,
  extendedHours: boolean,
): Promise<OHLCVDataPoint[]> {
  const raw = await getPriceHistorySchwab(symbol, interval, extendedHours);
  return normalizeSchwabBars(raw);
}

async function fetchYahoo(
  symbol: string,
  interval: BarInterval,
  extendedHours: boolean,
): Promise<OHLCVDataPoint[]> {
  const yfInterval = YAHOO_INTERVAL_MAP[interval] as
    | '1m' | '5m' | '15m' | '30m' | '60m' | '1h' | '1d' | '1wk' | '1mo';
  const period1 = new Date(Date.now() - yahooLookbackMs(interval));
  const chart = await yf.chart(symbol.toUpperCase(), {
    interval: yfInterval,
    period1,
    includePrePost: extendedHours,
  });
  return normalizeYahooBars((chart?.quotes ?? []) as Array<Record<string, unknown>>);
}

/**
 * Fetch OHLCV bars for a symbol at a given interval, returning at most `count`
 * most-recent bars. Schwab is tried first, Yahoo is the fallback.
 *
 * Results are cached in DynamoDB via the shared cache layer. Intraday intervals
 * use a 5-minute TTL; daily+ use 4 hours.
 */
export async function fetchBarsWithFallback(
  symbol: string,
  interval: BarInterval,
  count: number,
  options: FetchBarsOptions = {},
): Promise<FetchBarsResult> {
  const upperSymbol = symbol.trim().toUpperCase();
  if (!upperSymbol) throw new Error('fetchBarsWithFallback: symbol is required');
  if (!Number.isFinite(count) || count <= 0) {
    throw new Error('fetchBarsWithFallback: count must be a positive number');
  }

  const useCache = options.useCache ?? true;
  const preferred: BarProvider = options.preferredProvider ?? 'schwab';
  // Schwab's quote already reflects the latest price regardless of session, so
  // it doesn't need extended-hours history by default. Yahoo needs it to
  // synthesize a live "today" candle from pre/post-market data. When the
  // caller doesn't specify, default based on which provider is preferred.
  const extendedHours = options.extendedHours ?? (preferred === 'yahoo');

  const cacheKey =
    timeSeriesCacheKey(upperSymbol, interval, extendedHours) +
    `#FBWF#${preferred}#${count}`;

  if (useCache) {
    const cached = await getCachedData<{ bars: OHLCVDataPoint[]; provider: BarProvider }>(cacheKey);
    if (cached && cached.bars.length > 0) {
      return { bars: cached.bars, source: 'cache', provider: cached.provider };
    }
  }

  const order: BarProvider[] =
    preferred === 'yahoo' ? ['yahoo', 'schwab'] : ['schwab', 'yahoo'];

  let bars: OHLCVDataPoint[] = [];
  let provider: BarProvider = order[0];
  let lastErr: unknown = null;

  for (const p of order) {
    try {
      const fetched = p === 'schwab'
        ? await fetchSchwab(upperSymbol, interval, extendedHours)
        : await fetchYahoo(upperSymbol, interval, extendedHours);
      if (fetched.length > 0) {
        bars = fetched;
        provider = p;
        break;
      }
      // Empty result from this provider — try the next one.
    } catch (err) {
      lastErr = err;
      console.warn(
        `fetchBarsWithFallback: ${p} failed for ${upperSymbol} ${interval}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  if (bars.length === 0) {
    throw new Error(
      `Failed to fetch bars for ${upperSymbol} ${interval} from all providers` +
        (lastErr instanceof Error ? `: ${lastErr.message}` : ''),
    );
  }

  bars.sort((a, b) => a.datetime.localeCompare(b.datetime));
  if (bars.length > count) bars = bars.slice(-count);

  if (useCache) {
    const ttl = INTRADAY_INTERVALS.has(interval) ? INTRADAY_TTL_SECONDS : DAILY_TTL_SECONDS;
    void setCachedData(cacheKey, { bars, provider }, ttl, { source: provider }).catch(
      (err) => console.warn('fetchBarsWithFallback cache write failed:', err),
    );
  }

  return { bars, source: provider, provider };
}
