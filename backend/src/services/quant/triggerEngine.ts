/**
 * TriggerEngine
 *
 * Replaces the string-based triggerStatus in screenerService with a proper state machine.
 *
 * States:
 *   NO_TRADE      — geometry gate failed (R:R < 1.0 or bias=NO TRADE)
 *   WAIT          — setup is valid but price not yet in the entry zone
 *   ZONE_TOUCHED  — price has reached the demand/supply zone
 *   TRIGGER_ARMED — price is in zone AND a leading signal is present (volume/CVD)
 *   CONFIRMED     — full confirmation criteria met (e.g. VWAP reclaim + volume)
 *   ACTIVE        — trade is live (price has exceeded chase price)
 *
 * Current implementation uses real-time price vs zone/VWAP data available at scan time.
 * Later phases can add intraday CVD checks when websocket data is available.
 */

export type TriggerState =
  | 'NO_TRADE'
  | 'WAIT'
  | 'ZONE_TOUCHED'
  | 'TRIGGER_ARMED'
  | 'CONFIRMED'
  | 'ACTIVE';

export interface TriggerContext {
  currentPrice: number;
  tradePlanBias: 'LONG' | 'SHORT' | 'NO TRADE';
  /** Trigger price — top of demand zone for LONG, bottom of supply zone for SHORT */
  triggerPrice: number | null;
  /** Chase price — beyond this = chasing, too late */
  chasePrice: number | null;
  stop: number | null;
  rewardRisk: number;
  /** Premarket VWAP if available */
  pmVwap?: number | null;
  /** Volume acceleration (burst ratio vs prior 5-min window) */
  volumeAcceleration?: number;
  /** CVD factor bias if available */
  cvdBias?: 'bullish' | 'bearish' | 'neutral';
}

export function evaluateTrigger(ctx: TriggerContext): TriggerState {
  const { currentPrice, tradePlanBias, triggerPrice, chasePrice, stop, rewardRisk } = ctx;

  // ── Gate 1: Trade geometry ─────────────────────────────────────────────────
  // Also covers unanchored geometry: a plan built on a placeholder zone is
  // always NO TRADE, and its trigger/chase/stop are null. Returning here means
  // the comparisons below never see one.
  if (tradePlanBias === 'NO TRADE' || rewardRisk < 1.0) {
    return 'NO_TRADE';
  }
  if (triggerPrice === null || chasePrice === null || stop === null) {
    return 'NO_TRADE';
  }

  // ── Gate 2: Price vs trigger zone ─────────────────────────────────────────
  if (tradePlanBias === 'LONG') {
    // Price above chase → already chasing, too extended
    if (currentPrice > chasePrice) return 'ACTIVE';

    // Price below trigger (demand zone) — still waiting
    if (currentPrice < triggerPrice * 0.99) return 'WAIT';

    // Price at or slightly above trigger — in the zone
    const inZone = currentPrice >= triggerPrice * 0.99 && currentPrice <= chasePrice;

    if (inZone) {
      // Check for VWAP reclaim — strongest confirmation
      const vwapReclaim = ctx.pmVwap && currentPrice > ctx.pmVwap;
      // Volume acceleration burst — early warning
      const volBurst = (ctx.volumeAcceleration ?? 0) >= 2;
      // CVD confirming direction
      const cvdConfirm = ctx.cvdBias === 'bullish';

      if (vwapReclaim && (volBurst || cvdConfirm)) return 'CONFIRMED';
      if (vwapReclaim || (volBurst && cvdConfirm)) return 'TRIGGER_ARMED';
      return 'ZONE_TOUCHED';
    }
  } else if (tradePlanBias === 'SHORT') {
    // Price below chase → already moving, may be too extended
    if (currentPrice < chasePrice) return 'ACTIVE';

    // Price above trigger — still waiting
    if (currentPrice > triggerPrice * 1.01) return 'WAIT';

    const inZone = currentPrice <= triggerPrice * 1.01 && currentPrice >= chasePrice;

    if (inZone) {
      const vwapRejection = ctx.pmVwap && currentPrice < ctx.pmVwap;
      const volBurst = (ctx.volumeAcceleration ?? 0) >= 2;
      const cvdConfirm = ctx.cvdBias === 'bearish';

      if (vwapRejection && (volBurst || cvdConfirm)) return 'CONFIRMED';
      if (vwapRejection || (volBurst && cvdConfirm)) return 'TRIGGER_ARMED';
      return 'ZONE_TOUCHED';
    }
  }

  return 'WAIT';
}

/** Human-readable label for UI display */
export function triggerStateLabel(state: TriggerState): string {
  switch (state) {
    case 'NO_TRADE':      return 'NO TRADE';
    case 'WAIT':          return 'WAIT FOR ENTRY';
    case 'ZONE_TOUCHED':  return 'ZONE TOUCHED';
    case 'TRIGGER_ARMED': return 'TRIGGER ARMED';
    case 'CONFIRMED':     return 'CONFIRMED';
    case 'ACTIVE':        return 'TRIGGER ACTIVE';
  }
}
