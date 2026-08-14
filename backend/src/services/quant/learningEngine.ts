import type { LearningStats } from '../../types.js';

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

export function learningKey(bias: 'LONG' | 'SHORT' | 'NO TRADE'): string {
  return `GLOBAL|${bias}`;
}
