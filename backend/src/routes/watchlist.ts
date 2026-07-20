import { queryItems, putItem, deleteItem } from '../services/dynamodb.js';
import type {
  WatchlistItem,
  WatchlistResponse,
  WatchlistEntry,
  APIGatewayProxyResultV2,
} from '../types.js';
import { jsonResponse } from '../index.js';

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

function userPK(userId: string): string {
  return `USER#${userId}`;
}

function watchlistSK(symbol: string): string {
  return `WATCHLIST#${symbol.toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * GET /api/watchlist
 *
 * Retrieve every watchlist entry for the authenticated user.
 *
 * @param userId - The authenticated user's subject claim.
 * @returns A JSON response containing the watchlist entries.
 */
export async function getWatchlist(
  userId: string,
): Promise<APIGatewayProxyResultV2> {
  const items = await queryItems<WatchlistItem>(userPK(userId), 'WATCHLIST#');

  const entries: WatchlistEntry[] = items.map((item) => ({
    symbol: item.symbol,
    addedAt: item.addedAt,
  }));

  const body: WatchlistResponse = { items: entries };
  return jsonResponse(200, body);
}

/**
 * POST /api/watchlist
 *
 * Add a symbol to the authenticated user's watchlist.
 * Expects a JSON body: `{ "symbol": "AAPL" }`.
 *
 * @param userId - The authenticated user's subject claim.
 * @param body   - The raw request body string.
 * @returns A 201 response with the created entry, or 400 on bad input.
 */
export async function addToWatchlist(
  userId: string,
  body: string | undefined,
): Promise<APIGatewayProxyResultV2> {
  if (!body) {
    return jsonResponse(400, { error: 'Request body is required' });
  }

  let parsed: { symbol?: string };
  try {
    parsed = JSON.parse(body) as { symbol?: string };
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON in request body' });
  }

  const symbol = parsed.symbol?.trim().toUpperCase();
  if (!symbol) {
    return jsonResponse(400, { error: '"symbol" is required and must be a non-empty string' });
  }

  const now = new Date().toISOString();

  const item: WatchlistItem = {
    pk: userPK(userId),
    sk: watchlistSK(symbol),
    symbol,
    addedAt: now,
  };

  await putItem(item);

  return jsonResponse(201, { symbol, addedAt: now });
}

/**
 * DELETE /api/watchlist/:symbol
 *
 * Remove a symbol from the authenticated user's watchlist.
 *
 * @param userId - The authenticated user's subject claim.
 * @param symbol - The ticker symbol to remove.
 * @returns A 204 no-content response on success.
 */
export async function removeFromWatchlist(
  userId: string,
  symbol: string,
): Promise<APIGatewayProxyResultV2> {
  const upperSymbol = symbol.trim().toUpperCase();

  if (!upperSymbol) {
    return jsonResponse(400, { error: '"symbol" path parameter is required' });
  }

  await deleteItem(userPK(userId), watchlistSK(upperSymbol));

  return jsonResponse(204, undefined);
}
