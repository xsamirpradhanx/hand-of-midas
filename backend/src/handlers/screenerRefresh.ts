import { runScreener, ScreenerMode } from '../services/screenerService.js';
import { setCachedData } from '../services/cache.js';
import { getMarketSession } from '../services/tradingCalendar.js';

// Outlives each mode's own refresh cadence (see handofmidas-stack.ts) so one
// missed/slow cycle doesn't blank the screener before the next run lands.
// 'momentum'/'highdemand' refresh every 2 min; 'open'/'premarket' every 5 min.
const CACHE_TTL_SECONDS: Record<ScreenerMode, number> = {
  open: 15 * 60,
  premarket: 15 * 60,
  momentum: 10 * 60,
  highdemand: 10 * 60,
};

/**
 * Scheduled entry point: computes one screener mode and caches it, decoupled
 * from the user-facing API Lambda's 29s timeout. A full deep scan (up to 20
 * candidates through the full predictive-engine pipeline) measured 3+ minutes
 * — the API Lambda serving /api/screener could never complete that
 * synchronously, and it previously tried to on every cache miss, guaranteeing
 * a 504 in production. This runs on its own 300s-timeout Lambda instead; the
 * API route now only ever reads whatever this last cached.
 *
 * EventBridge passes {mode} in the event payload — each mode has its own
 * staggered rule so they don't compete for the same invocation, and premarket
 * only runs (and is only served) during the premarket session.
 */
export async function handler(event: { mode?: ScreenerMode }): Promise<void> {
  const mode: ScreenerMode = event.mode ?? 'open';
  const session = getMarketSession();
  const relevant = mode === 'premarket' ? session === 'PREMARKET' : session === 'REGULAR';
  if (!relevant) return;

  console.info(`[ScreenerRefresh] Running scheduled scan for mode=${mode}...`);
  const results = await runScreener(mode);
  await setCachedData(`SCREENER#${mode.toUpperCase()}`, results, CACHE_TTL_SECONDS[mode]);
  console.info(`[ScreenerRefresh] Cached ${results.length} result(s) for mode=${mode}.`);
}
