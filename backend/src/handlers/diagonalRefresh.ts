import { runDiagonalScreener } from '../services/diagonalScreenerService.js';
import { setCachedData } from '../services/cache.js';

// Outlives the 15-min refresh cadence so one slow cycle doesn't blank the
// scanner before the next run lands.
const CACHE_TTL_SECONDS = 30 * 60;
export const DIAGONAL_CACHE_KEY = 'SCREENER#DIAGONAL';

/**
 * Scheduled entry point: computes the diagonal-spread scan and caches it,
 * decoupled from the API Lambda's 29s timeout. Fetching a real near+far
 * options chain per oversold candidate (fixed in diagonalScreenerService.ts —
 * it previously only ever fetched the nearest expiry, so every long/short leg
 * came back null) measured ~68s, well past what the API Lambda can run
 * synchronously. Same pattern as ScreenerRefreshFunction: GET
 * /api/screener/diagonal only ever reads whatever this last cached.
 */
export async function handler(): Promise<void> {
  console.info('[DiagonalRefresh] Running scheduled scan...');
  const results = await runDiagonalScreener();
  await setCachedData(DIAGONAL_CACHE_KEY, results, CACHE_TTL_SECONDS);
  console.info(`[DiagonalRefresh] Cached ${results.length} result(s).`);
}
