import {
  getCachedData,
  setCachedData,
  quoteCacheKey,
} from '../services/cache.js';
import { yf } from '../services/yahoo.js';
import type { APIGatewayProxyResultV2, QuoteResponse } from '../types.js';
import { jsonResponse } from '../index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cache TTL for quote data (2 minutes). */
const QUOTE_TTL_SECONDS = 2 * 60;

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * GET /api/quote/:symbol
 *
 * Returns the current quote for a symbol. Checks the DynamoDB cache first
 * (2-minute TTL) and falls back to Yahoo Finance.
 *
 * @param symbol - Ticker symbol extracted from the URL path.
 * @returns A JSON response containing the quote data.
 */
export async function getQuote(
  symbol: string,
): Promise<APIGatewayProxyResultV2> {
  const upperSymbol = symbol.trim().toUpperCase();
  if (!upperSymbol) {
    return jsonResponse(400, { error: '"symbol" path parameter is required' });
  }

  // --- Check cache ---------------------------------------------------------
  const cacheKey = quoteCacheKey(upperSymbol);
  const cached = await getCachedData<QuoteResponse>(cacheKey);

  if (cached) {
    return jsonResponse(200, cached);
  }

  // --- Fetch from upstream -------------------------------------------------
  let raw;
  try {
    raw = await yf.quote(upperSymbol);
  } catch (err) {
    console.error('Yahoo quote fetch error:', err);
    return jsonResponse(404, {
      error: `No quote data found for symbol "${upperSymbol}".`,
    });
  }

  if (!raw || raw.regularMarketPrice === undefined) {
    return jsonResponse(404, {
      error: `No valid quote data found for symbol "${upperSymbol}".`,
    });
  }

  // Determine extended hours data (prefer post-market if it's after hours, pre-market if before)
  const extPrice = raw.postMarketPrice ?? raw.preMarketPrice;
  const extChange = raw.postMarketChange ?? raw.preMarketChange;
  const extChangePercent = raw.postMarketChangePercent ?? raw.preMarketChangePercent;

  const quoteResponse: QuoteResponse = {
    symbol: raw.symbol ?? upperSymbol,
    name: raw.longName ?? raw.shortName ?? upperSymbol,
    price: raw.regularMarketPrice,
    change: raw.regularMarketChange ?? 0,
    changePercent: raw.regularMarketChangePercent ?? 0,
    preMarketPrice: extPrice,
    preMarketChange: extChange,
    preMarketChangePercent: extChangePercent,
    marketState: raw.marketState,
  };

  // --- Populate cache (fire-and-forget) ------------------------------------
  void setCachedData(cacheKey, quoteResponse, QUOTE_TTL_SECONDS).catch(
    (err: unknown) => {
      console.error('Failed to write quote to cache', err);
    },
  );

  return jsonResponse(200, quoteResponse);
}
