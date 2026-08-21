/**
 * Model conviction from independent evidence.
 *
 * Extracted so there is exactly one definition. The audit suite previously
 * re-implemented this formula inline, which meant it kept passing after the
 * production formula changed — testing an expression nothing ran.
 *
 * Conviction is NOT a probability. It is an evidence-strength score in [0.05,
 * 0.95] and must never be presented as a win rate.
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
  return Number(Math.max(MIN_CONVICTION, scaled).toFixed(3));
}
