import type { LearningStats, PredictionSource } from '../../types.js';

export interface LearningAssessment {
  /** Posterior probability, not a guarantee or recommendation. */
  calibratedProbability: number;
  sampleSize: number;
  source: 'MODEL_PRIOR' | 'EMPIRICAL';
  reliability: 'INSUFFICIENT' | 'EARLY' | 'ESTABLISHED';
  explanation: string;
}

const PRIOR_SAMPLE_SIZE = 8;
const MIN_ESTABLISHED_SAMPLE = 20;

/**
 * Bayesian calibration prevents a handful of wins from becoming a 100% model.
 * The structural model supplies a conservative prior and finalized outcomes
 * progressively take control as the sample grows.
 */
export function calibratePrediction(
  modelConviction: number,
  stats?: LearningStats,
): LearningAssessment {
  const prior = Math.min(0.85, Math.max(0.15, modelConviction));
  const wins = stats?.wins ?? 0;
  const losses = stats?.losses ?? 0;
  const sampleSize = wins + losses;
  const calibratedProbability = Number(
    ((wins + prior * PRIOR_SAMPLE_SIZE) / (sampleSize + PRIOR_SAMPLE_SIZE)).toFixed(3),
  );

  const reliability = sampleSize >= MIN_ESTABLISHED_SAMPLE
    ? 'ESTABLISHED'
    : sampleSize >= 5 ? 'EARLY' : 'INSUFFICIENT';

  return {
    calibratedProbability,
    sampleSize,
    source: sampleSize > 0 ? 'EMPIRICAL' : 'MODEL_PRIOR',
    reliability,
    explanation: sampleSize === 0
      ? 'No finalized matching outcomes yet; this uses a conservative model prior.'
      : `Bayesian calibration from ${sampleSize} finalized matching outcomes (${wins} target hits, ${losses} stops/timeouts).`,
  };
}

export function learningKey(
  bias: 'LONG' | 'SHORT' | 'NO TRADE',
  source?: PredictionSource,
): string {
  /**
   * The `source` prefix is what keeps the Trade Plan's outcomes from being
   * buried by the screener's.
   *
   * The screener writes predictions on every scan pass across several cadences,
   * while the Trade Plan writes once per day per symbol — orders of magnitude
   * apart. `evaluateQuant` therefore WRITES `${source}|GLOBAL|${bias}`, but this
   * helper returned the bare `GLOBAL|${bias}` and read sites that used it
   * verbatim looked up a key nothing writes. `calibratePrediction` in
   * predictiveEngine was one of them, so live calibration silently matched
   * nothing and fell back to its uncalibrated default.
   *
   * Source is optional so the existing write site, which composes the prefix
   * itself, keeps producing byte-identical keys.
   */
  return source ? `${source}|GLOBAL|${bias}` : `GLOBAL|${bias}`;
}
