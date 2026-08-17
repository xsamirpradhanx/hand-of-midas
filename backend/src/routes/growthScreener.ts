import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from '../types.js';
import { jsonResponse } from '../utils/response.js';
import { getCachedDataWithMeta } from '../services/cache.js';
import { triggerGrowthRefresh } from '../services/screenerRefreshTrigger.js';
import { GROWTH_CACHE_KEY } from '../handlers/growthRefresh.js';

/**
 * Pure cache read — a separate scheduled Lambda (GrowthRefreshFunction)
 * populates this cache once daily; nothing here ever runs the scan inline.
 */
export async function getGrowthScreener(
  _event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  try {
    const cached = await getCachedDataWithMeta(GROWTH_CACHE_KEY);
    if (cached) {
      return jsonResponse(200, cached.data, {
        'Cache-Control': 'public, max-age=60',
        'X-Screener-Computed-At': cached.cachedAt,
      });
    }
    console.warn('[GrowthScreenerRoute] No cached results yet — scheduled refresh may not have run.');
    return jsonResponse(200, [], { 'Cache-Control': 'no-store' });
  } catch (error: any) {
    console.error('[GrowthScreenerRoute] Error:', error);
    return jsonResponse(500, { error: error.message || 'Internal Server Error' });
  }
}

/** Kicks off an out-of-band recompute ("Refresh Scan" button). */
export async function refreshGrowthScreener(
  _event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  try {
    await triggerGrowthRefresh();
    console.info('[GrowthScreenerRoute] Triggered refresh.');
    return jsonResponse(202, { ok: true, message: 'Refresh started — this takes about a minute.' });
  } catch (error: any) {
    console.error('[GrowthScreenerRoute] Error triggering refresh:', error);
    return jsonResponse(500, { error: error.message || 'Internal Server Error' });
  }
}
