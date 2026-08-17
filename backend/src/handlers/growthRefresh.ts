import { runGrowthScreener } from '../services/growthScreenerService.js';
import { setCachedData } from '../services/cache.js';

// Fundamentals refresh once daily (market open) — TTL spans a long weekend
// (Fri run -> Mon run is ~3 days) so results don't blank out over the gap.
const CACHE_TTL_SECONDS = 4 * 24 * 60 * 60;
export const GROWTH_CACHE_KEY = 'SCREENER#GROWTH';

/**
 * Scheduled entry point: computes the growth scan and caches it, decoupled
 * from the API Lambda's 29s timeout. Same pattern as DiagonalRefreshFunction:
 * GET /api/screener/growth only ever reads whatever this last cached.
 */
export async function handler(): Promise<void> {
  console.info('[GrowthRefresh] Running scheduled scan...');
  const results = await runGrowthScreener();
  await setCachedData(GROWTH_CACHE_KEY, results, CACHE_TTL_SECONDS);
  console.info(`[GrowthRefresh] Cached ${results.length} result(s).`);
}
