/**
 * Learning core — credit assignment, decayed accumulation, and expectancy.
 *
 * Pure functions only (no DynamoDB, no network) so the same code can drive both
 * the live evaluation cycle and a historical backtest replay. This is deliberate:
 * a backtest that learns by different rules than production is measuring the
 * wrong system.
 *
 * Three problems in the original loop this module exists to fix.
 *
 * 1. CREDIT ASSIGNMENT. evaluateQuant credited *every* factor attached to a
 *    thesis with the trade's outcome, regardless of which way that factor
 *    actually voted. A bearish factor on a LONG that won was recorded as a win
 *    for the bearish factor. With enough samples every factor converges to the
 *    same global base rate and FACTOR_STATS loses all discriminative power —
 *    the weight multiplier downstream then does nothing but add noise.
 *
 * 2. WRONG GRADING TARGET FOR FACTORS. A factor claims a *direction*, not a
 *    trade. Grading it on whether a particular target/stop geometry resolved
 *    conflates the factor's prediction with the plan's risk sizing. Factors are
 *    scored here on forward return in their claimed direction; only setups are
 *    scored on realized R.
 *
 * 3. STATIONARITY. Counts accumulated forever with equal weight, so a factor
 *    that worked in 2021 and stopped working in 2024 kept its 2021 wins at full
 *    value. Observations decay exponentially by age.
 */

/** How a factor's directional claim relates to the trade actually taken. */
export type FactorVote = 'AGREE' | 'DISAGREE' | 'ABSTAIN';

export type TradeBias = 'LONG' | 'SHORT' | 'BEARISH' | 'NO TRADE';
export type FactorBias = 'bullish' | 'bearish' | 'neutral';

/**
 * Default half-life for observation decay, in calendar days.
 *
 * ~6 months: long enough that a full earnings cycle of evidence still carries
 * real weight, short enough that a regime change from two years ago is down to
 * ~1/16 influence. Exposed so a backtest can sweep it rather than hardcode it.
 */
export const DEFAULT_HALF_LIFE_DAYS = 180;

/**
 * Observations below this decayed weight are treated as no evidence at all.
 * Prevents a single ancient sample from producing confident-looking ratios.
 */
export const MIN_EFFECTIVE_N = 3;

export interface DecayedStats {
  /** Decayed count of resolved observations. Fractional by construction. */
  n: number;
  /** Decayed count of outcomes in the favourable direction. */
  wins: number;
  /** Decayed count of outcomes in the unfavourable direction. */
  losses: number;
  /** Same-bar target+stop grades. Tracked, never scored — see gradeOutcome. */
  ambiguous: number;
  /** Decayed sum of realized R (setups) or directional score (factors). */
  sumScore: number;
  /** Decayed sum of squared score, for dispersion / confidence work. */
  sumScoreSq: number;
  /** ISO timestamp the decay was last applied at. */
  lastUpdatedAt: string;
}

export function emptyStats(at: string): DecayedStats {
  return { n: 0, wins: 0, losses: 0, ambiguous: 0, sumScore: 0, sumScoreSq: 0, lastUpdatedAt: at };
}

/**
 * Which side of the trade a factor was actually on.
 *
 * A neutral factor ABSTAINs rather than counting as agreement. It made no
 * directional claim, so an outcome is not evidence about it either way —
 * scoring abstentions is how the original loop washed out its own signal.
 */
export function factorVote(factorBias: FactorBias, tradeBias: TradeBias): FactorVote {
  if (factorBias === 'neutral' || tradeBias === 'NO TRADE') return 'ABSTAIN';
  const tradeIsLong = tradeBias === 'LONG';
  const factorIsLong = factorBias === 'bullish';
  return tradeIsLong === factorIsLong ? 'AGREE' : 'DISAGREE';
}

/**
 * Score a factor on its own directional claim, independent of the trade's
 * target/stop geometry.
 *
 * `forwardReturn` is the fractional price change from entry over the grading
 * horizon (+0.04 = price ended 4% higher). A bullish factor is right when it is
 * positive; a bearish factor is right when it is negative. Returns a signed
 * value in R-free units — magnitude carries how *much* the factor was right by,
 * so a factor that calls small chop correctly does not outrank one that calls
 * large moves correctly.
 *
 * Returns null for a neutral factor: no claim, no score. Callers must skip
 * rather than record a 0, which would otherwise drag every average toward zero
 * in proportion to how often a factor abstains.
 */
export function directionalScore(factorBias: FactorBias, forwardReturn: number): number | null {
  if (factorBias === 'neutral') return null;
  return factorBias === 'bullish' ? forwardReturn : -forwardReturn;
}

/**
 * Decay accumulated evidence to `now`.
 *
 * Exponential with a half-life: an observation's weight halves every
 * `halfLifeDays`. Applied to every counter so ratios between them stay valid —
 * decaying wins without decaying losses would silently rewrite history.
 */
export function decayStats(
  stats: DecayedStats,
  now: string,
  halfLifeDays: number = DEFAULT_HALF_LIFE_DAYS,
): DecayedStats {
  const elapsedMs = new Date(now).getTime() - new Date(stats.lastUpdatedAt).getTime();
  // Clock skew or an out-of-order replay must not *amplify* old evidence.
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return { ...stats, lastUpdatedAt: now };

  const elapsedDays = elapsedMs / 86_400_000;
  const factor = Math.pow(0.5, elapsedDays / halfLifeDays);

  return {
    n: stats.n * factor,
    wins: stats.wins * factor,
    losses: stats.losses * factor,
    ambiguous: stats.ambiguous * factor,
    sumScore: stats.sumScore * factor,
    sumScoreSq: stats.sumScoreSq * factor,
    lastUpdatedAt: now,
  };
}

export interface Observation {
  /** Realized R (setups) or directional score (factors). */
  score: number;
  /** Favourable resolution. For setups: hit target. For factors: correct sign. */
  won: boolean;
  /** Same-bar target+stop — recorded but excluded from wins/losses/score. */
  ambiguous?: boolean;
}

/** Fold one graded observation into decayed stats. */
export function observe(
  stats: DecayedStats,
  obs: Observation,
  at: string,
  halfLifeDays: number = DEFAULT_HALF_LIFE_DAYS,
): DecayedStats {
  const decayed = decayStats(stats, at, halfLifeDays);

  if (obs.ambiguous) {
    return { ...decayed, ambiguous: decayed.ambiguous + 1 };
  }

  return {
    ...decayed,
    n: decayed.n + 1,
    wins: decayed.wins + (obs.won ? 1 : 0),
    losses: decayed.losses + (obs.won ? 0 : 1),
    sumScore: decayed.sumScore + obs.score,
    sumScoreSq: decayed.sumScoreSq + obs.score * obs.score,
  };
}

/** Mean score per resolved observation — realized R for setups. */
export function expectancy(stats: DecayedStats): number | null {
  if (stats.n < MIN_EFFECTIVE_N) return null;
  return stats.sumScore / stats.n;
}

export function winRate(stats: DecayedStats): number | null {
  const resolved = stats.wins + stats.losses;
  if (resolved < MIN_EFFECTIVE_N) return null;
  return stats.wins / resolved;
}

/**
 * Win rate at which a plan with this reward:risk breaks even.
 *
 * The original weight multiplier used `accuracy / 0.5`, treating 50% as the
 * neutral point. That is only correct at 1:1. At the 2.3R plans this screener
 * actually emits, break-even is ~30% — so a genuinely profitable 40%-win-rate
 * factor was being *penalized* with a 0.8x multiplier. Anchoring to the real
 * break-even is what makes the multiplier mean "better or worse than a
 * coin-flip-equivalent edge".
 */
export function breakEvenWinRate(plannedR: number): number {
  if (!Number.isFinite(plannedR) || plannedR <= 0) return 0.5;
  return 1 / (1 + plannedR);
}

/**
 * Multiplier applied to a factor's base weight from its track record.
 *
 * Bounded to [0.25, 1.75]. Learned evidence should tilt the model, not replace
 * it — an unbounded multiplier lets one hot streak dominate a 21-factor
 * ensemble, which is the failure mode the RANK_RVOL_CAP comment in
 * screenerService describes for a different signal.
 *
 * Shrinks toward 1.0 when evidence is thin: at n = MIN_EFFECTIVE_N the tilt is
 * a third of its full size, reaching full strength around n = 30. Without this
 * a 3-sample fluke would move weight as hard as a 200-sample track record.
 */
export function factorWeightMultiplier(
  stats: DecayedStats,
  opts: { referenceScore?: number } = {},
): number {
  const exp = expectancy(stats);
  if (exp === null) return 1.0;

  // Scale relative to a reference move size so the multiplier is unitless.
  // Defaults to 1% forward return as "a normal correct call".
  const reference = opts.referenceScore ?? 0.01;
  const raw = 1.0 + exp / reference * 0.25;

  const confidence = Math.min(1, stats.n / 30);
  const shrunk = 1.0 + (raw - 1.0) * confidence;

  return Math.max(0.25, Math.min(1.75, shrunk));
}

/**
 * Bayesian win-probability calibration with decayed evidence.
 *
 * Same shrinkage idea as the original calibratePrediction, but the sample size
 * is the decayed `n` rather than a raw lifetime count, so a model that was
 * accurate two years ago no longer claims that accuracy today.
 */
export function calibrate(
  modelConviction: number,
  stats: DecayedStats | undefined,
  priorStrength = 8,
): { probability: number; effectiveN: number; reliability: 'INSUFFICIENT' | 'EARLY' | 'ESTABLISHED' } {
  const prior = Math.min(0.85, Math.max(0.15, modelConviction));
  const wins = stats?.wins ?? 0;
  const resolved = (stats?.wins ?? 0) + (stats?.losses ?? 0);

  const probability = Number(
    ((wins + prior * priorStrength) / (resolved + priorStrength)).toFixed(3),
  );

  return {
    probability,
    effectiveN: Number(resolved.toFixed(2)),
    reliability: resolved >= 20 ? 'ESTABLISHED' : resolved >= 5 ? 'EARLY' : 'INSUFFICIENT',
  };
}
