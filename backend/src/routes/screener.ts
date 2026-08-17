import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from '../types.js';
import { jsonResponse } from '../utils/response.js';
import { ScreenerMode } from '../services/screenerService.js';
import { getCachedDataWithMeta } from '../services/cache.js';
import { getMarketSession } from '../services/tradingCalendar.js';
import { triggerScreenerRefresh } from '../services/screenerRefreshTrigger.js';

function resolveMode(event: APIGatewayProxyEventV2): ScreenerMode {
  const modeStr = event.queryStringParameters?.mode;
  const requestedMode: ScreenerMode =
    modeStr === 'premarket' ? 'premarket' :
    modeStr === 'momentum'  ? 'momentum'  :
    modeStr === 'highdemand'? 'highdemand' : 'open';
  // Never apply the lower premarket thresholds after the opening bell,
  // including when a stale route state or bookmarked URL requests them.
  const mode: ScreenerMode = requestedMode === 'premarket' && getMarketSession() !== 'PREMARKET'
    ? 'open'
    : requestedMode;
  if (mode !== requestedMode) {
    console.info(`[Screener API] Normalized stale ${requestedMode} request to ${mode} (${getMarketSession()}).`);
  }
  return mode;
}

export async function getScreener(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  try {
    const mode = resolveMode(event);
    const cacheKey = `SCREENER#${mode.toUpperCase()}`;
    const cached = await getCachedDataWithMeta(cacheKey);

    if (cached) {
      console.log(`[Screener API] Serving ${mode} from cache (computed ${cached.cachedAt}).`);
      return jsonResponse(200, cached.data, {
        'Cache-Control': 'public, max-age=60',
        'X-Screener-Computed-At': cached.cachedAt,
      });
    }

    // No synchronous fallback here on purpose: a full deep scan takes 3+
    // minutes (bars, options chain, sentiment, and 21 factors across up to 20
    // candidates), far past this Lambda's 29s timeout — running it inline
    // guaranteed a 504 on every cache miss. ScreenerRefreshFunction populates
    // this cache on a schedule (see handofmidas-stack.ts); if nothing is
    // cached yet, the scheduled refresh for this mode hasn't landed.
    console.warn(`[Screener API] No cached ${mode} results yet — scheduled refresh may not have run.`);
    return jsonResponse(200, [], { 'Cache-Control': 'no-store' });
  } catch (error: any) {
    console.error('Error running screener:', error);
    return jsonResponse(500, { error: error.message || 'Internal Server Error' });
  }
}

/**
 * Kicks off an out-of-band recompute for one mode ("Refresh Scan" button).
 * Returns as soon as the scan has been handed off — it does not wait for the
 * scan itself, which takes minutes. The client polls GET /api/screener and
 * watches X-Screener-Computed-At to know when fresh results have landed.
 */
export async function refreshScreener(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  try {
    const mode = resolveMode(event);
    await triggerScreenerRefresh(mode);
    console.info(`[Screener API] Triggered refresh for mode=${mode}.`);
    return jsonResponse(202, { ok: true, mode, message: 'Refresh started — this takes a few minutes.' });
  } catch (error: any) {
    console.error('Error triggering screener refresh:', error);
    return jsonResponse(500, { error: error.message || 'Internal Server Error' });
  }
}
