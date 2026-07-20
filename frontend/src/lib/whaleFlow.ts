/** Minimum structural filters before a contract qualifies as whale flow. */
export const WHALE_MIN_VOLUME = 500;
export const WHALE_MIN_PREMIUM = 100_000;
export const WHALE_MIN_VOL_OI_RATIO = 3;
export const WHALE_SCORE_HIGH = 250;
export const WHALE_SCORE_EXTREME = 1000;

export type WhaleTier = 'extreme' | 'high' | 'elevated';

export interface WhaleScoreInput {
  volume: number;
  openInterest: number;
  /** Contract mid/last price per share (not per contract). */
  price: number;
  dte: number;
}

/**
 * Compute whale score using the same formula as the backend scanner:
 * (Vol / OI) × log₁₀(Premium) × (30 / DTE)
 *
 * Returns null when the contract fails structural whale filters.
 */
export function computeWhaleScore(input: WhaleScoreInput): number | null {
  const { volume, openInterest, price, dte } = input;

  if (volume < WHALE_MIN_VOLUME) return null;

  const premium = volume * price * 100;
  if (premium < WHALE_MIN_PREMIUM) return null;

  const volumeOIRatio = openInterest > 0 ? volume / openInterest : volume;
  if (volumeOIRatio < WHALE_MIN_VOL_OI_RATIO) return null;

  const dteFactor = Math.max(1, dte);
  const oiFactor = Math.max(1, openInterest);

  return (volume / oiFactor) * Math.log10(Math.max(premium, 10)) * (30 / dteFactor);
}

export function getWhaleTier(score: number | null | undefined): WhaleTier | null {
  if (score == null || score <= 0) return null;
  if (score >= WHALE_SCORE_EXTREME) return 'extreme';
  if (score >= WHALE_SCORE_HIGH) return 'high';
  return 'elevated';
}

export function isWhaleFlow(score: number | null | undefined, minScore = WHALE_SCORE_HIGH): boolean {
  return score != null && score >= minScore;
}

/** Resolve a usable per-share price from chain quote fields. */
export function resolveContractPrice(bid: number, ask: number, mid: number, last: number): number {
  if (mid > 0) return mid;
  if (bid > 0 && ask > 0) return (bid + ask) / 2;
  if (last > 0) return last;
  return bid || ask;
}
