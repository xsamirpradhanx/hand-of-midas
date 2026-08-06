import {
  getCachedData,
  setCachedData,
  timeSeriesCacheKey,
} from '../services/cache.js';
import { getMarketDataProviderAware } from '../services/providerService.js';
import type {
  APIGatewayProxyResultV2,
  TwelveDataInterval,
  OHLCVDataPoint,
  MarketDataResponse,
} from '../types.js';
import { jsonResponse } from '../index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Valid Twelve Data interval values. */
const VALID_INTERVALS: ReadonlySet<string> = new Set<string>([
  '1min',
  '5min',
  '15min',
  '30min',
  '1h',
  '1day',
  '1week',
  '1month',
]);

/** Intraday intervals get a short cache TTL; daily+ get a longer one. */
const INTRADAY_INTERVALS: ReadonlySet<string> = new Set<string>([
  '1min',
  '5min',
  '15min',
  '30min',
  '1h',
]);

/** Cache TTL for intraday data (5 minutes). */
const INTRADAY_TTL_SECONDS = 5 * 60;

/** Cache TTL for daily / weekly / monthly data (4 hours). */
const DAILY_TTL_SECONDS = 4 * 60 * 60;

/** Default number of bars to return. */
const DEFAULT_OUTPUT_SIZE = 200;

/** Maximum bars the upstream API accepts. */
const MAX_OUTPUT_SIZE = 5000;

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * GET /api/market-data/:symbol
 *
 * Returns OHLCV time-series data for the given symbol. Reads from cache
 * first, falling back to the Twelve Data API on a miss.
 *
 * Query parameters:
 * - `interval` — bar interval (default `1day`).
 * - `outputsize` — number of data points (default 200, max 5000).
 *
 * @param symbol      - Ticker symbol extracted from the URL path.
 * @param queryParams - Raw query-string parameters from the event.
 * @returns A JSON response containing the standardised OHLCV data.
 */
export async function getMarketData(
  symbol: string,
  queryParams: Record<string, string | undefined> | undefined,
  event?: any,
): Promise<APIGatewayProxyResultV2> {
  const upperSymbol = symbol.trim().toUpperCase();
  if (!upperSymbol) {
    return jsonResponse(400, { error: '"symbol" path parameter is required' });
  }

  // --- Validate interval ---------------------------------------------------
  const rawInterval = queryParams?.['interval'] ?? '1day';
  if (!VALID_INTERVALS.has(rawInterval)) {
    return jsonResponse(400, {
      error: `Invalid interval "${rawInterval}". Valid values: ${[...VALID_INTERVALS].join(', ')}`,
    });
  }
  const interval = rawInterval as TwelveDataInterval;

  // --- Validate outputsize -------------------------------------------------
  const rawSize = queryParams?.['outputsize'];
  let outputsize = DEFAULT_OUTPUT_SIZE;
  if (rawSize !== undefined) {
    const parsed = Number(rawSize);
    if (Number.isNaN(parsed) || parsed < 1 || parsed > MAX_OUTPUT_SIZE) {
      return jsonResponse(400, {
        error: `Invalid outputsize "${rawSize}". Must be an integer between 1 and ${MAX_OUTPUT_SIZE}.`,
      });
    }
    outputsize = Math.floor(parsed);
  }

  // --- Validate extendedHours ----------------------------------------------
  const extendedHours = queryParams?.['extendedHours'] === 'true';

  // --- Extract Provider ----------------------------------------------------
  const provider = event?.headers?.['x-data-provider']?.toLowerCase();

  // --- Check cache ---------------------------------------------------------
  const cacheKey = timeSeriesCacheKey(upperSymbol, interval, extendedHours) + (provider ? `#PROV-${provider}` : '');
  const cached = await getCachedData<{ data: OHLCVDataPoint[]; source: string }>(cacheKey);

  if (cached) {
    const body: MarketDataResponse = {
      symbol: upperSymbol,
      interval,
      data: cached.data,
    };
    return jsonResponse(200, body, { 'X-Source-Provider': cached.source });
  }

  // --- Fetch from upstream -------------------------------------------------
  let rawValues: any[] = [];
  let source = 'yahoo';
  
  try {
    const res = await getMarketDataProviderAware(upperSymbol, interval, extendedHours, provider);
    rawValues = res.data;
    source = res.source;
  } catch (err: any) {
    console.error(`Market data provider fetch failed: ${err.message}`);
  }

  if (rawValues.length === 0) {
    return jsonResponse(404, {
      error: `No market data found for symbol "${upperSymbol}" with interval "${interval}".`,
    });
  }

  // --- Transform to standardised OHLCV format ------------------------------
  // The provider service already mapped Schwab to the generic shape, or yahoo/twelvedata is handled
  let data: OHLCVDataPoint[] = [];
  
  // Determine if it came from Yahoo/TwelveData or Schwab based on shape
  if (source === 'schwab') {
    data = rawValues.map((v) => ({
      datetime: new Date(v.timestamp).toISOString().replace('T', ' ').substring(0, 19),
      open: v.open,
      high: v.high,
      low: v.low,
      close: v.close,
      volume: v.volume,
    }));
  } else if (rawValues[0] && rawValues[0].datetime) {
    // Yahoo/TwelveData
    data = rawValues.map((v) => ({
      datetime: v.datetime,
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
      volume: parseFloat(v.volume),
    }));
  }

  // Ensure data is consistently ascending (oldest first)
  data.sort((a, b) => {
    const tA = new Date(a.datetime.replace(' ', 'T') + 'Z').getTime();
    const tB = new Date(b.datetime.replace(' ', 'T') + 'Z').getTime();
    if (isNaN(tA) || isNaN(tB)) return a.datetime.localeCompare(b.datetime);
    return tA - tB;
  });

  // --- Populate cache ------------------------------------------------------
  const ttl = INTRADAY_INTERVALS.has(interval)
    ? INTRADAY_TTL_SECONDS
    : DAILY_TTL_SECONDS;

  // Fire-and-forget — we don't want a cache write failure to break the response.
  void setCachedData(cacheKey, { data, source }, ttl).catch((err: unknown) => {
    console.error('Failed to write market data to cache', err);
  });

  const body: MarketDataResponse = {
    symbol: upperSymbol,
    interval,
    data,
  };

  return jsonResponse(200, body, { 'X-Source-Provider': source });
}
