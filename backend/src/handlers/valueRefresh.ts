import { runValueScreener } from '../services/valueScreenerService.js';
import { setCachedData } from '../services/cache.js';

// Fundamentals refresh once daily (market open) — TTL spans a long weekend
// (Fri run -> Mon run is ~3 days) so results don't blank out over the gap.
const CACHE_TTL_SECONDS = 4 * 24 * 60 * 60;
export const VALUE_CACHE_KEY = 'SCREENER#VALUE';

/**
 * Scheduled entry point: computes the value scan and caches it, decoupled
 * from the API Lambda's 29s timeout. Same pattern as DiagonalRefreshFunction:
 * GET /api/screener/value only ever reads whatever this last cached.
 */
export async function handler(): Promise<void> {
  console.info('[ValueRefresh] Running scheduled scan...');
  const results = await runValueScreener();
  await setCachedData(VALUE_CACHE_KEY, results, CACHE_TTL_SECONDS);
  console.info(`[ValueRefresh] Cached ${results.length} result(s).`);
}
