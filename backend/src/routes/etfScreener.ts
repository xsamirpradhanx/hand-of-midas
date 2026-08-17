import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from '../types.js';
import { jsonResponse } from '../utils/response.js';
import { getCachedDataWithMeta } from '../services/cache.js';
import { triggerEtfRefresh } from '../services/screenerRefreshTrigger.js';
import { ETF_CACHE_KEY } from '../handlers/etfRefresh.js';

/**
 * Pure cache read — a separate scheduled Lambda (EtfRefreshFunction)
 * populates this cache once daily; nothing here ever runs the scan inline.
 */
export async function getEtfScreener(
  _event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  try {
    const cached = await getCachedDataWithMeta(ETF_CACHE_KEY);
    if (cached) {
      return jsonResponse(200, cached.data, {
        'Cache-Control': 'public, max-age=60',
        'X-Screener-Computed-At': cached.cachedAt,
      });
    }
    console.warn('[EtfScreenerRoute] No cached results yet — scheduled refresh may not have run.');
    return jsonResponse(200, [], { 'Cache-Control': 'no-store' });
  } catch (error: any) {
    console.error('[EtfScreenerRoute] Error:', error);
    return jsonResponse(500, { error: error.message || 'Internal Server Error' });
  }
}

/** Kicks off an out-of-band recompute ("Refresh Scan" button). */
export async function refreshEtfScreener(
  _event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  try {
    await triggerEtfRefresh();
    console.info('[EtfScreenerRoute] Triggered refresh.');
    return jsonResponse(202, { ok: true, message: 'Refresh started — this takes about a minute.' });
  } catch (error: any) {
    console.error('[EtfScreenerRoute] Error triggering refresh:', error);
    return jsonResponse(500, { error: error.message || 'Internal Server Error' });
  }
}
