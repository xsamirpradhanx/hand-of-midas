import { runEtfScreener } from '../services/etfScreenerService.js';
import { setCachedData } from '../services/cache.js';

// Multi-month ETF performance doesn't move intraday — refresh once daily.
// TTL spans a long weekend (Fri run -> Mon run is ~3 days) so results don't
// blank out over the gap.
const CACHE_TTL_SECONDS = 4 * 24 * 60 * 60;
export const ETF_CACHE_KEY = 'SCREENER#ETF';

/**
 * Scheduled entry point: computes the ETF outperformance scan and caches it,
 * decoupled from the API Lambda's 29s timeout. Same pattern as
 * DiagonalRefreshFunction: GET /api/screener/etf only ever reads whatever
 * this last cached.
 */
export async function handler(): Promise<void> {
  console.info('[EtfRefresh] Running scheduled scan...');
  const results = await runEtfScreener();
  await setCachedData(ETF_CACHE_KEY, results, CACHE_TTL_SECONDS);
  console.info(`[EtfRefresh] Cached ${results.length} result(s).`);
}
