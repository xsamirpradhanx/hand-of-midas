import {
  getCachedData,
  setCachedData,
  quoteCacheKey,
} from '../services/cache.js';
import { getQuote as fetchQuote } from '../services/twelvedata.js';
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
 * (2-minute TTL) and falls back to the Twelve Data `/quote` endpoint.
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
  const raw = await fetchQuote(upperSymbol);

  if (!raw.close) {
    return jsonResponse(404, {
      error: `No quote data found for symbol "${upperSymbol}".`,
    });
  }

  const quoteResponse: QuoteResponse = {
    symbol: raw.symbol ?? upperSymbol,
    name: raw.name ?? upperSymbol,
    price: parseFloat(raw.close),
    change: parseFloat(raw.change ?? '0'),
    changePercent: parseFloat(raw.percent_change ?? '0'),
  };

  // --- Populate cache (fire-and-forget) ------------------------------------
  void setCachedData(cacheKey, quoteResponse, QUOTE_TTL_SECONDS).catch(
    (err: unknown) => {
      console.error('Failed to write quote to cache', err);
    },
  );

  return jsonResponse(200, quoteResponse);
}
