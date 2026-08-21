/**
 * Position sizing from measured factor accuracy.
 *
 * Deliberately separate from conviction. Conviction is a weight-sum score that
 * does not separate outcomes — measured over 3,154 replayed trades its top and
 * bottom quartiles differ by t≈1.6, and over the post-2009 half not at all.
 * Blending a small correct term into it only diluted the correct term.
 *
 * The accuracy edge does separate. Ranking the same trades by it — trained on
 * 1985-2009 and tested on 2009-2026 — gave +0.278R in the top quartile against
 * +0.159R overall, with six of seven factor edges keeping their sign across the
 * 17-year gap.
 *
 * Sizing rather than filtering, because that is what the evidence supports:
 * taking only the top quartile lifted per-trade expectancy but CUT total return
 * from +250.6R to +109.4R and left return-over-drawdown slightly worse. The
 * separation is real, so lean into the better trades — but discarding the rest
 * gives up more return than risk.
 *
 * ESTABLISHED OUT-OF-SAMPLE. Tested on 11,676 trades across 171 symbols that
 * were backfilled specifically because none of them were used to design this —
 * the earlier 87-symbol store had all become in-sample:
 *
 *   score separates            top-vs-bottom +0.201R, t≈5.35
 *   buckets                    +0.002 / +0.078 / +0.191 / +0.203R, monotone
 *   paired sign test, 40 years sized beat flat in 30/40, p≈0.0016
 *   scaling with strength      R/DD 26.25 / 27.34 / 27.94 / 28.53 / 29.10, monotone
 *   block bootstrap on R/DD    better in 97.0% of resamples, CI [-0.09, +6.20]
 *
 * The bootstrap is the one test that does not clear the bar, and only barely.
 * Three of four pass, including the paired sign test, which is the strongest
 * design available here because sized and flat are the SAME trades under two
 * weightings rather than two different populations.
 *
 * Effect size shrank from +13.4% return-per-drawdown in-sample to +6.4% out of
 * sample, which is the expected direction. Treat +6% as the honest estimate.
 *
 * For contrast, the learning-loop claim tested the same way came back at 50.1%
 * of bootstrap resamples and 22/42 years — a coin flip — and was retracted.
 */
import { accuracyEdge, type FactorVote, type MeasuredAccuracy } from './conviction.js';

/**
 * Bounds on the multiplier.
 *
 * Floored well above zero because the low-edge bucket still earns a positive
 * +0.070R — it is worth less, not worth nothing. Capped at 2x because the edge
 * is estimated from a few thousand trades and the honest response to that
 * uncertainty is to refuse to bet the estimate hard.
 */
export const MIN_SIZE = 0.4;
export const MAX_SIZE = 2.0;

/**
 * Converts an edge of roughly ±0.1 into a useful spread of sizes. At GAIN=6 an
 * edge of +0.08 sizes ~1.5x and -0.08 sizes ~0.5x, which spans the observed
 * range without ever approaching the caps on typical input.
 */
const GAIN = 6;

export interface SizingSignal {
  /** Raw signed edge from measured accuracy, ~[-0.1, +0.1]. 0 when untrained. */
  readonly edge: number;
  /** Position size as a multiple of the baseline unit. */
  readonly sizeMultiplier: number;
  /** How many factors carried enough history to contribute. */
  readonly contributingFactors: number;
  /** Plain-language reason, for display next to a suggested size. */
  readonly rationale: string;
}

export function computeSizing(
  votes: readonly FactorVote[],
  planBias: 'bullish' | 'bearish' | 'neutral',
  measured: MeasuredAccuracy | undefined,
): SizingSignal {
  const edge = accuracyEdge(votes, planBias, measured);
  const contributing = countContributing(votes, measured);

  // No track record means no opinion: size at baseline rather than guessing.
  if (contributing === 0 || edge === 0) {
    return {
      edge: 0,
      sizeMultiplier: 1,
      contributingFactors: contributing,
      rationale: contributing === 0
        ? 'No factor has enough graded history yet — baseline size.'
        : 'Measured accuracy is balanced on this setup — baseline size.',
    };
  }

  const raw = 1 + GAIN * edge;
  const sizeMultiplier = Number(Math.max(MIN_SIZE, Math.min(MAX_SIZE, raw)).toFixed(2));

  const direction = edge > 0 ? 'support' : 'contradict';
  return {
    edge: Number(edge.toFixed(4)),
    sizeMultiplier,
    contributingFactors: contributing,
    rationale:
      `${contributing} factor${contributing === 1 ? '' : 's'} with graded history ${direction} this plan ` +
      `(edge ${edge >= 0 ? '+' : ''}${(edge * 100).toFixed(1)}pp vs a coin flip) — size ${sizeMultiplier}x.`,
  };
}

function countContributing(
  votes: readonly FactorVote[],
  measured: MeasuredAccuracy | undefined,
): number {
  if (!measured) return 0;
  let n = 0;
  for (const v of votes) {
    if (v.bias === 'neutral') continue;
    const m = measured[v.factorName];
    if (m && m.wins + m.losses >= 30) n++;
  }
  return n;
}
