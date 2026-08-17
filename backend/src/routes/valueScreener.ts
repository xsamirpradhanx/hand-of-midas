import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from '../types.js';
import { jsonResponse } from '../utils/response.js';
import { getCachedDataWithMeta } from '../services/cache.js';
import { triggerValueRefresh } from '../services/screenerRefreshTrigger.js';
import { VALUE_CACHE_KEY } from '../handlers/valueRefresh.js';

/**
 * Pure cache read — a separate scheduled Lambda (ValueRefreshFunction)
 * populates this cache once daily; nothing here ever runs the scan inline.
 */
export async function getValueScreener(
  _event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  try {
    const cached = await getCachedDataWithMeta(VALUE_CACHE_KEY);
    if (cached) {
      return jsonResponse(200, cached.data, {
        'Cache-Control': 'public, max-age=60',
        'X-Screener-Computed-At': cached.cachedAt,
      });
    }
    console.warn('[ValueScreenerRoute] No cached results yet — scheduled refresh may not have run.');
    return jsonResponse(200, [], { 'Cache-Control': 'no-store' });
  } catch (error: any) {
    console.error('[ValueScreenerRoute] Error:', error);
    return jsonResponse(500, { error: error.message || 'Internal Server Error' });
  }
}

/** Kicks off an out-of-band recompute ("Refresh Scan" button). */
export async function refreshValueScreener(
  _event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  try {
    await triggerValueRefresh();
    console.info('[ValueScreenerRoute] Triggered refresh.');
    return jsonResponse(202, { ok: true, message: 'Refresh started — this takes about a minute.' });
  } catch (error: any) {
    console.error('[ValueScreenerRoute] Error triggering refresh:', error);
    return jsonResponse(500, { error: error.message || 'Internal Server Error' });
  }
}
