import {
  getCachedData,
  setCachedData,
  timeSeriesCacheKey,
} from '../services/cache.js';
import { getTimeSeries } from '../services/twelvedata.js';
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

  // --- Check cache ---------------------------------------------------------
  const cacheKey = timeSeriesCacheKey(upperSymbol, interval, extendedHours);
  const cached = await getCachedData<OHLCVDataPoint[]>(cacheKey);

  if (cached) {
    const body: MarketDataResponse = {
      symbol: upperSymbol,
      interval,
      data: cached,
    };
    return jsonResponse(200, body);
  }

  // --- Fetch from upstream -------------------------------------------------
  let raw: { values?: any[] } = {};
  
  try {
    if (extendedHours) {
      throw new Error('Forcing Yahoo Finance for extended hours data');
    }
    raw = await getTimeSeries(upperSymbol, interval, outputsize);
  } catch (err: any) {
    if (!extendedHours) {
      console.warn(`TwelveData failed for ${upperSymbol}, falling back to Yahoo Finance: ${err.message}`);
    }
    const { yf } = await import('../services/yahoo.js');
    
    // Map TwelveData intervals to Yahoo Finance intervals
    const intervalMap: Record<string, string> = {
      '1min': '1m',
      '5min': '5m',
      '15min': '15m',
      '30min': '30m',
      '1h': '60m',
      '1day': '1d',
      '1week': '1wk',
      '1month': '1mo'
    };
    
    const yfInterval = intervalMap[interval] || '1d';
    
    let period1Time = Date.now() - 2 * 365 * 24 * 60 * 60 * 1000; // 2 years default
    if (yfInterval === '1m') {
      period1Time = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days max for 1m
    } else if (yfInterval.endsWith('m') || yfInterval.endsWith('h')) {
      period1Time = Date.now() - 59 * 24 * 60 * 60 * 1000; // ~60 days max for other intraday
    }
    const period1 = new Date(period1Time);
    
    try {
      const yfData = await yf.chart(upperSymbol, { 
        interval: yfInterval as any, 
        period1, 
        includePrePost: extendedHours 
      });
      if (yfData && yfData.quotes && yfData.quotes.length > 0) {
        raw = {
          values: yfData.quotes.slice(-outputsize).map(q => {
            // Yahoo returns JS Dates, convert to string
            let dtStr = '';
            if (yfInterval.endsWith('m')) {
              dtStr = q.date.toISOString().replace('T', ' ').substring(0, 19);
            } else {
              dtStr = q.date.toISOString().split('T')[0];
            }
            return {
              datetime: dtStr,
              open: q.open?.toString() || '0',
              high: q.high?.toString() || '0',
              low: q.low?.toString() || '0',
              close: q.close?.toString() || '0',
              volume: q.volume?.toString() || '0'
            };
          }).filter(q => parseFloat(q.open) > 0)
        };
      }
    } catch (yfErr) {
      console.error('Yahoo Finance fallback also failed:', yfErr);
    }
  }

  if (!raw.values || raw.values.length === 0) {
    return jsonResponse(404, {
      error: `No market data found for symbol "${upperSymbol}" with interval "${interval}".`,
    });
  }

  // --- Transform to standardised OHLCV format ------------------------------
  const data: OHLCVDataPoint[] = raw.values.map((v) => ({
    datetime: v.datetime,
    open: parseFloat(v.open),
    high: parseFloat(v.high),
    low: parseFloat(v.low),
    close: parseFloat(v.close),
    volume: parseFloat(v.volume),
  }));

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
  void setCachedData(cacheKey, data, ttl).catch((err: unknown) => {
    console.error('Failed to write market data to cache', err);
  });

  const body: MarketDataResponse = {
    symbol: upperSymbol,
    interval,
    data,
  };

  return jsonResponse(200, body);
}
