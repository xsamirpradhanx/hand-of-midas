/**
 * Per-factor directional attribution.
 *
 * The learning loop previously credited EVERY factor attached to a plan with that
 * plan's outcome, regardless of which way the factor voted. A factor that called
 * the direction correctly and one that called it backwards received identical
 * credit, so the aggregate for any always-on factor converged on the book's
 * overall win rate and nothing could be told apart.
 *
 * Measured before this fix: Volume Profile, Anchored VWAP, KAMA and ATR Dynamic
 * Volatility all reported exactly n=1210, win=20.9%, score=253 — four different
 * factors, four identical rows. The four options factors likewise shared
 * n=649 / 36.1% / 234. With every factor scoring the same, the accuracy
 * multiplier in compositeScore.applyRegimeMultiplier could only scale the whole
 * book up or down together, never favour a factor that was actually right.
 *
 * Attribution here is on the factor's OWN vote against the realised move.
 */

export type RealizedDirection = 'up' | 'down';
export type FactorBias = 'bullish' | 'bearish' | 'neutral';
export type PlanBias = 'LONG' | 'SHORT' | 'BEARISH';
export type Outcome = 'TARGET' | 'STOP' | 'TIMEOUT' | 'AMBIGUOUS';

/**
 * Which way price actually went, inferred from the plan's direction and whether
 * it reached target or stop.
 *
 *   LONG  + TARGET -> up      LONG  + STOP -> down
 *   SHORT + TARGET -> down    SHORT + STOP -> up
 *
 * Returns null when the move is unknowable: AMBIGUOUS means target and stop were
 * both touched in one bar and OHLC cannot order them, TIMEOUT means neither was
 * reached. Neither should teach the learning loop anything.
 */
export function realizedDirection(plan: PlanBias, outcome: Outcome): RealizedDirection | null {
  if (outcome !== 'TARGET' && outcome !== 'STOP') return null;
  const isShort = plan === 'SHORT' || plan === 'BEARISH';
  const wentPlanWay = outcome === 'TARGET';
  // XOR: a short whose target hit means price fell.
  return wentPlanWay !== isShort ? 'up' : 'down';
}

/**
 * Did this factor's vote match the realised move?
 *
 * `null` means the factor abstained (neutral) and must be excluded from both
 * wins and losses — counting an abstention as a loss would punish factors that
 * correctly decline to call a directionless tape.
 */
export function factorWasCorrect(
  bias: FactorBias | undefined,
  realized: RealizedDirection,
): boolean | null {
  if (bias === 'bullish') return realized === 'up';
  if (bias === 'bearish') return realized === 'down';
  return null;
}
