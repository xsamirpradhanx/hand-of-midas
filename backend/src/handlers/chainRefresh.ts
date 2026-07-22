import { isMarketOpen } from '../services/tradingCalendar.js';

/**
 * Scheduled refresh entry point. Market-data fan-out is intentionally kept
 * outside this handler until a licensed, timestamped snapshot pipeline is
 * available; silently publishing stale Yahoo-derived data is worse than no
 * update for a risk-facing application.
 */
export async function handler(): Promise<void> {
  if (!isMarketOpen()) return;
  console.info('Chain refresh invoked during market hours; no symbols are configured for refresh.');
}
