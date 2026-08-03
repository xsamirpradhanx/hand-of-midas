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
    sortOrder: item.sortOrder,
  }));
  
  entries.sort((a, b) => {
    if (a.sortOrder !== undefined && b.sortOrder !== undefined) {
      return a.sortOrder - b.sortOrder;
    }
    if (a.sortOrder !== undefined) return -1;
    if (b.sortOrder !== undefined) return 1;
    return a.symbol.localeCompare(b.symbol);
  });

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

  const items = await queryItems<WatchlistItem>(userPK(userId), 'WATCHLIST#');
  let maxOrder = -1;
  for (const it of items) {
    if (it.sortOrder !== undefined && it.sortOrder > maxOrder) {
      maxOrder = it.sortOrder;
    }
  }

  const item: WatchlistItem = {
    pk: userPK(userId),
    sk: watchlistSK(symbol),
    symbol,
    addedAt: now,
    sortOrder: maxOrder + 1,
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

/**
 * PUT /api/watchlist/reorder
 *
 * Reorder the authenticated user's watchlist items.
 *
 * @param userId - The authenticated user's subject claim.
 * @param body   - JSON containing an array of symbols in the new order.
 */
export async function reorderWatchlist(
  userId: string,
  body: string | undefined,
): Promise<APIGatewayProxyResultV2> {
  if (!body) {
    return jsonResponse(400, { error: 'Request body is required' });
  }

  let parsed: { symbols?: string[] };
  try {
    parsed = JSON.parse(body) as { symbols?: string[] };
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON in request body' });
  }

  const symbols = parsed.symbols;
  if (!Array.isArray(symbols)) {
    return jsonResponse(400, { error: '"symbols" must be an array of strings' });
  }

  const items = await queryItems<WatchlistItem>(userPK(userId), 'WATCHLIST#');
  const itemsBySymbol = new Map<string, WatchlistItem>();
  for (const item of items) {
    itemsBySymbol.set(item.symbol.toUpperCase(), item);
  }

  let order = 0;
  for (const sym of symbols) {
    const upperSym = sym.trim().toUpperCase();
    const existing = itemsBySymbol.get(upperSym);
    if (existing) {
      existing.sortOrder = order++;
      await putItem(existing);
    }
  }

  return jsonResponse(200, { success: true });
}

