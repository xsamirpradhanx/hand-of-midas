import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from '../types.js';
import { jsonResponse } from '../utils/response.js';
import { getCachedDataWithMeta } from '../services/cache.js';
import { triggerDiagonalRefresh } from '../services/screenerRefreshTrigger.js';
import { DIAGONAL_CACHE_KEY } from '../handlers/diagonalRefresh.js';

/**
 * Pure cache read — the scan itself (near+far options chain per oversold
 * candidate) measured ~68s, well past this Lambda's 29s timeout. A separate
 * scheduled Lambda (DiagonalRefreshFunction) populates this cache; nothing
 * here ever runs the scan inline.
 */
export async function getDiagonalScreener(
  _event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  try {
    const cached = await getCachedDataWithMeta(DIAGONAL_CACHE_KEY);
    if (cached) {
      return jsonResponse(200, cached.data, {
        'Cache-Control': 'public, max-age=60',
        'X-Screener-Computed-At': cached.cachedAt,
      });
    }
    console.warn('[DiagonalScreenerRoute] No cached results yet — scheduled refresh may not have run.');
    return jsonResponse(200, [], { 'Cache-Control': 'no-store' });
  } catch (error: any) {
    console.error('[DiagonalScreenerRoute] Error:', error);
    return jsonResponse(500, { error: error.message || 'Internal Server Error' });
  }
}

/** Kicks off an out-of-band recompute ("Refresh Scan" button) — see getScreener/refreshScreener for the identical pattern on the main screener. */
export async function refreshDiagonalScreener(
  _event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  try {
    await triggerDiagonalRefresh();
    console.info('[DiagonalScreenerRoute] Triggered refresh.');
    return jsonResponse(202, { ok: true, message: 'Refresh started — this takes about a minute.' });
  } catch (error: any) {
    console.error('[DiagonalScreenerRoute] Error triggering refresh:', error);
    return jsonResponse(500, { error: error.message || 'Internal Server Error' });
  }
}
