/**
 * Model conviction from independent evidence.
 *
 * Extracted so there is exactly one definition. The audit suite previously
 * re-implemented this formula inline, which meant it kept passing after the
 * production formula changed — testing an expression nothing ran.
 *
 * Conviction is NOT a probability. It is an evidence-strength score in [0.05,
 * 0.95] and must never be presented as a win rate.
 *
 * MEASURED, AND NEGATIVE: conviction does not separate outcomes. Over 5,989
 * replayed trades its top and bottom quartiles differ by +0.074R at t≈1.42.
 * Tilting it by measured factor accuracy was tried and moved that to t≈1.50 —
 * no improvement — so the tilt was removed rather than left in to look busy.
 * accuracyEdge() below is retained because positionSizing.ts uses it, where the
 * same information DOES separate (t≈3.25).
 */

export type AgreementLevel = 'HIGH' | 'MODERATE' | 'LOW';

export interface ConvictionInput {
  /** Summed weight of bullish bucket representatives. */
  readonly bullishScore: number;
  readonly bearishScore: number;
  /** Neutral weight counts as evidence of indecision — see below. */
  readonly neutralScore: number;
  readonly netBias: number;
  readonly agreementLevel: AgreementLevel;
  /** Factors that reported, over factors registered. 1 = full coverage. */
  readonly coverage: number;
}

const AGREEMENT_MULTIPLIER: Record<AgreementLevel, number> = {
  HIGH: 1.0,
  MODERATE: 0.8,
  LOW: 0.6,
};

export const MIN_CONVICTION = 0.05;
export const MAX_CONVICTION = 0.95;

export interface FactorVote {
  readonly factorName: string;
  readonly bias: 'bullish' | 'bearish' | 'neutral';
}

export interface MeasuredAccuracy {
  readonly [factorName: string]: { wins: number; losses: number };
}

/** A factor needs this many resolved votes before its accuracy is trusted. */
export const MIN_RESOLVED_FOR_ACCURACY = 30;

/**
 * Signed edge of the evidence, weighted by each factor's MEASURED accuracy.
 *
 * The engine already had an accuracy multiplier, but it only scales a factor's
 * weight — `max(0.2, accuracy / 0.5)`, which across observed accuracies of
 * 0.43-0.54 is a +/-8% nudge — and it is blind to which way the factor voted.
 * That throws away the more useful half of the information.
 *
 * Measured over 3,154 replayed trades with a 17-year temporal hold-out, four
 * factors are RELIABLY WRONG about 20-bar direction: Volume Profile 42.7%,
 * Estimated CVD 41.6%, Asymmetric Kinematic 43.4%, Anchored VWAP 46.7% — all
 * significant out-of-sample. A factor that is dependably wrong is informative:
 * when it opposes the plan that is evidence FOR the plan, and scaling its weight
 * down merely discards the signal.
 *
 * Each directional factor contributes `(accuracy - 0.5)`, signed by whether it
 * agrees with `planBias`. Factors without a track record contribute nothing
 * rather than a guess. Returns 0 when nothing qualifies, so a cold system
 * behaves exactly as before.
 */
export function accuracyEdge(
  votes: readonly FactorVote[],
  planBias: 'bullish' | 'bearish' | 'neutral',
  measured: MeasuredAccuracy | undefined,
): number {
  if (!measured || planBias === 'neutral') return 0;
  let sum = 0;
  let n = 0;
  for (const v of votes) {
    if (v.bias === 'neutral') continue;
    const m = measured[v.factorName];
    if (!m) continue;
    const resolved = m.wins + m.losses;
    if (resolved < MIN_RESOLVED_FOR_ACCURACY) continue;
    const agrees = v.bias === planBias;
    sum += (m.wins / resolved - 0.5) * (agrees ? 1 : -1);
    n++;
  }
  return n > 0 ? sum / n : 0;
}

export function computeConviction(input: ConvictionInput): number {
  const { bullishScore, bearishScore, neutralScore, netBias, agreementLevel, coverage } = input;

  // A RATIO of net directional evidence to all evidence weighed.
  //
  // Was `|netBias| / 2` on an unnormalised weight sum, so conviction scaled with
  // how many factors happened to fire rather than how one-sided they were. Every
  // factor added raised it mechanically — six LLM-generated factors sharing one
  // correlation group moved mean conviction from 0.393 to 0.449 on random-walk
  // data with no edge by construction.
  //
  // Neutral weight is in the denominator on purpose: a factor declining to call
  // the tape is evidence of indecision. Excluding it would let two directional
  // factors out of twenty produce full conviction.
  const totalEvidence = bullishScore + bearishScore + neutralScore;
  const normalizedBias = totalEvidence > 0 ? Math.abs(netBias) / totalEvidence : 0;

  // Coverage dampens rather than erases: signalAgreement divides by SURVIVING
  // buckets, so a symbol whose factors mostly went silent (no options chain, no
  // news) reaches unanimity trivially and absent factors never register as
  // missing information. The 0.5 floor keeps a thin-but-real read usable.
  const coverageMultiplier = 0.5 + 0.5 * Math.max(0, Math.min(1, coverage));

  const raw = Math.min(MAX_CONVICTION, normalizedBias);
  const scaled = raw * AGREEMENT_MULTIPLIER[agreementLevel] * coverageMultiplier;
  return Number(Math.max(MIN_CONVICTION, Math.min(MAX_CONVICTION, scaled)).toFixed(3));
}
