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

export interface FactorAccuracyRecord {
  readonly wins: number;
  readonly losses: number;
  /**
   * Resolved votes and hits SPLIT BY THE DIRECTION VOTED.
   *
   * Optional because stats accumulated before this existed do not carry it.
   * A factor without the split cannot be assessed — see `accuracyEdge`.
   */
  readonly bullishVotes?: number;
  readonly bullishWins?: number;
  readonly bearishVotes?: number;
  readonly bearishWins?: number;
}

export interface MeasuredAccuracy {
  readonly [factorName: string]: FactorAccuracyRecord;
}

/** A factor needs this many resolved votes before its accuracy is trusted. */
export const MIN_RESOLVED_FOR_ACCURACY = 30;

/**
 * And this many in EACH direction, before its informedness is trusted.
 *
 * Half the overall minimum. A factor that voted bullish 400 times and bearish
 * three times has no usable estimate of what it means when it turns bearish,
 * and averaging the two anyway is how the old metric ended up reporting the
 * vote mix.
 */
export const MIN_PER_DIRECTION = 15;

/**
 * Informedness of one factor: P(up | it voted bullish) - P(up | it voted
 * bearish), on a +/-0.5 scale. `null` when either direction is too thin.
 *
 * Youden's J. Zero means the factor's vote tells you nothing about what happens
 * next, whatever the market did and whatever the factor's own long/short mix
 * is, because any drift common to both conditional rates cancels in the
 * difference.
 */
export function informedness(m: FactorAccuracyRecord): number | null {
  const bullVotes = m.bullishVotes ?? 0;
  const bearVotes = m.bearishVotes ?? 0;
  if (bullVotes < MIN_PER_DIRECTION || bearVotes < MIN_PER_DIRECTION) return null;
  const bullAcc = (m.bullishWins ?? 0) / bullVotes;
  const bearAcc = (m.bearishWins ?? 0) / bearVotes;
  return (bullAcc + bearAcc - 1) / 2;
}

/**
 * Signed edge of the evidence, weighted by each factor's MEASURED skill.
 *
 * WHAT THIS USED TO DO, AND WHY IT WAS WRONG. Each factor contributed
 * `accuracy - 0.5`: its raw hit rate against a fixed coin-flip baseline. That
 * baseline is not a coin flip. Equities drift up — 56.2% of sampled bars in
 * this store are higher twenty bars later — so a factor that votes bullish most
 * of the time scores above 50% and one that leans bearish scores below it, both
 * while knowing nothing at all.
 *
 * It is not a small effect. Measured over 390,733 decision bars across 255
 * symbols, raw accuracy correlates 0.816 with a factor's long-share across the
 * production stack, and 0.94 across a wider pool of 76 research candidates.
 * The old term was, to first order, a readout of each factor's vote mix.
 *
 * Splitting the same votes by direction shows what was hiding underneath: for
 * nearly every factor P(up | bullish) and P(up | bearish) both land on the
 * unconditional base rate — Volume Profile 55.6% and 57.1%, Anchored VWAP 55.8%
 * and 56.8%, against a base rate of 56.2%. The apparent spread in raw accuracy,
 * from 48.7% to 53.3%, is entirely the mix.
 *
 * This also RETRACTS the claim that four factors are reliably wrong at
 * 42.7%-46.7%. Re-measured on clean bars with the drift removed they sit at
 * -0.4pp to -0.8pp informedness: fractionally negative, nowhere near enough to
 * trade, and the reason inverting them never helped. The one factor with real
 * discrimination is KAMA & Z-Score Distance at +2.0pp over 42,294 votes.
 *
 * A factor now contributes its informedness, signed by whether it agrees with
 * `planBias`. Factors without enough votes IN EACH DIRECTION contribute
 * nothing, because a one-sided factor's accuracy cannot be separated from the
 * drift no matter how many votes it has. Returns 0 when nothing qualifies, so a
 * cold system behaves exactly as before.
 */
export function accuracyEdge(
  votes: readonly FactorVote[],
  planBias: 'bullish' | 'bearish' | 'neutral',
  measured: MeasuredAccuracy | undefined,
): number {
  if (!measured || planBias === 'neutral') return 0;
  /**
   * A/B escape hatch, for measurement only.
   *
   * `LEGACY_ACCURACY=1` restores the raw `accuracy - 0.5` term this replaced,
   * so a replay can score the two rules over identical trades rather than
   * against a remembered number from a different run. It exists because the
   * claim "informedness beats raw accuracy" has to be demonstrated on this
   * engine, not asserted. Never set in production.
   */
  const legacy = process.env['LEGACY_ACCURACY'] === '1';
  let sum = 0;
  let n = 0;
  for (const v of votes) {
    if (v.bias === 'neutral') continue;
    const m = measured[v.factorName];
    if (!m) continue;
    const resolved = m.wins + m.losses;
    if (resolved < MIN_RESOLVED_FOR_ACCURACY) continue;
    const skill = legacy ? m.wins / resolved - 0.5 : informedness(m);
    if (skill === null) continue;
    const agrees = v.bias === planBias;
    sum += skill * (agrees ? 1 : -1);
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
