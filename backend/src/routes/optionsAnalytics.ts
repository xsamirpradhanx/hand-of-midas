import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from '../types.js';
import { jsonResponse } from '../utils/response.js';
import { getCachedData, setCachedData } from '../services/cache.js';
import { getOptionsAnalytics } from '../services/optionsAnalyticsService.js';

const CACHE_TTL_SECONDS = 900; // 15 minutes — options snapshots are expensive

export async function getOptionsAnalyticsRoute(
  event: APIGatewayProxyEventV2,
  params: Record<string, string>,
): Promise<APIGatewayProxyResultV2> {
  const symbol = params['symbol']?.toUpperCase();
  if (!symbol) {
    return jsonResponse(400, { error: '"symbol" is required' });
  }

  const forceRefresh = event.queryStringParameters?.refresh === 'true';
  const includeVix = event.queryStringParameters?.includeVix !== 'false';
  const expiry = event.queryStringParameters?.expiry;

  const cacheKey = `OPTIONS_ANALYTICS#${symbol}${expiry ? `#${expiry}` : ''}#VIX-${includeVix ? 'ON' : 'OFF'}`;
  if (!forceRefresh) {
    const cached = await getCachedData<unknown>(cacheKey);
    if (cached) {
      return jsonResponse(200, cached);
    }
  }

  try {
    const data = await getOptionsAnalytics(symbol, { includeVix, expiry });
    await setCachedData(cacheKey, data, CACHE_TTL_SECONDS);
    return jsonResponse(200, data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Options analytics failed';
    console.error('Options Analytics Error:', err);
    return jsonResponse(500, { error: message });
  }
}
