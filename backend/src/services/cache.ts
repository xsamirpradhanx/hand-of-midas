import { getItem, putItem } from './dynamodb.js';
import type { CacheItem } from '../types.js';

// ---------------------------------------------------------------------------
// Cache key helpers
// ---------------------------------------------------------------------------

/**
 * Build a cache key for time-series data.
 *
 * @param symbol   - Ticker symbol.
 * @param interval - Bar interval (e.g. "1day").
 * @returns A deterministic cache key string.
 */
export function timeSeriesCacheKey(symbol: string, interval: string, extendedHours: boolean = true): string {
  return `CACHE#${symbol.toUpperCase()}#${interval}${extendedHours ? '#EXT' : ''}`;
}

/**
 * Build a cache key for quote data.
 *
 * @param symbol - Ticker symbol.
 * @returns A deterministic cache key string.
 */
export function quoteCacheKey(symbol: string): string {
  return `CACHE#${symbol.toUpperCase()}#QUOTE`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Retrieve a cached value from DynamoDB.
 *
 * The item is considered valid only if it exists AND its `ttl` attribute
 * is still in the future (compared to the current wall-clock time).
 *
 * @param cacheKey - The cache key (used as both PK and SK).
 * @returns The cached `data` payload, or `null` if missing / expired.
 */
export async function getCachedData<T = unknown>(
  cacheKey: string,
): Promise<T | null> {
  const item = await getItem<CacheItem>(cacheKey, cacheKey);

  if (!item) {
    return null;
  }

  const nowEpoch = Math.floor(Date.now() / 1000);
  if (item.ttl <= nowEpoch) {
    // Expired — treat as a cache miss.
    // DynamoDB's native TTL will eventually garbage-collect the row.
    return null;
  }

  return item.data as T;
}

/**
 * Same as {@link getCachedData}, but also returns when the entry was written
 * — callers that need to detect "has this been refreshed yet" (e.g. polling
 * after triggering an async recompute) can't tell from the data alone.
 */
export async function getCachedDataWithMeta<T = unknown>(
  cacheKey: string,
): Promise<{ data: T; cachedAt: string } | null> {
  const item = await getItem<CacheItem>(cacheKey, cacheKey);
  if (!item) return null;

  const nowEpoch = Math.floor(Date.now() / 1000);
  if (item.ttl <= nowEpoch) return null;

  return { data: item.data as T, cachedAt: item.cachedAt };
}

/**
 * Store a value in the DynamoDB cache with a TTL.
 *
 * @param cacheKey   - The cache key (used as both PK and SK).
 * @param data       - The payload to cache (must be JSON-serialisable).
 * @param ttlSeconds - How many seconds the entry should remain valid.
 */
export async function setCachedData(
  cacheKey: string,
  data: unknown,
  ttlSeconds: number,
  metadata?: { source?: string; asOf?: string; modelVersion?: string }
): Promise<void> {
  const nowEpoch = Math.floor(Date.now() / 1000);

  const item: CacheItem = {
    pk: cacheKey,
    sk: cacheKey,
    data,
    ttl: nowEpoch + ttlSeconds,
    cachedAt: new Date().toISOString(),
    ...metadata,
  };

  await putItem(item);
}
