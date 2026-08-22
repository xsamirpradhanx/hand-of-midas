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
import { accuracyEdge, informedness, type FactorVote, type MeasuredAccuracy } from './conviction.js';

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

/**
 * Realised performance of one trade direction.
 *
 * `sumR` is signed modelled R across `n` resolved trades — the same convention
 * SETUP_STATS uses, so the live path can hand its GLOBAL|LONG / GLOBAL|SHORT
 * records straight in.
 */
export interface DirectionRecord {
  readonly n: number;
  readonly sumR: number;
}

export interface DirectionStats {
  readonly LONG?: DirectionRecord;
  readonly SHORT?: DirectionRecord;
}

/**
 * Trades required in EACH direction before the tilt is applied.
 *
 * A direction prior is a claim about a whole side of the book, so it should not
 * be drawn from a handful of trades in a single regime.
 */
export const MIN_DIRECTION_TRADES = 100;

/**
 * Ceiling on the direction tilt, in size units.
 *
 * Deliberately far below what the measured gap would justify. Over the replayed
 * universe LONG earns +0.193R against SHORT's +0.072R — a ratio of 2.7 — and
 * sizing in proportion to that would be a very large bet on one side of the
 * book continuing to pay. +/-0.25 caps the ratio at 1.67. The direction edge is
 * the best-established finding in this engine, and it is still an estimate.
 */
export const MAX_DIRECTION_TILT = 0.25;

/**
 * Size tilt from the measured expectancy gap between LONG and SHORT.
 *
 * WHY THIS IS SEPARATE, AND EXPLICIT. The previous sizing signal appeared to
 * work: over 11,703 replayed trades it lifted return-per-drawdown by 11.0%. It
 * was not measuring what it claimed. Its factor term scored each factor by raw
 * accuracy against a fixed coin flip, which in a market that rises 56% of the
 * time is dominated by how often a factor votes long. Bullish-leaning factors
 * therefore carried a permanent positive edge, so plans they agreed with — LONG
 * plans — were systematically sized up. Measured on the trades themselves:
 * mean size 1.095 on LONG against 0.928 on SHORT, a +0.167 tilt nobody
 * designed. The lift was real and the mechanism was an accident.
 *
 * An accidental tilt is worse than an explicit one even when it pays. It cannot
 * be turned off, it cannot be re-estimated when the regime changes, and it is
 * invisible in the code that produces it. So the tilt is stated here, computed
 * from the quantity it was implicitly using all along, and left inspectable.
 *
 * The scale is one-for-one: half the measured R gap becomes the tilt in size
 * units, then clamped. No coefficient was fitted to reproduce the old lift.
 */
export function directionTilt(
  planBias: 'LONG' | 'SHORT' | 'NO TRADE' | 'bullish' | 'bearish' | 'neutral',
  stats: DirectionStats | undefined,
): number {
  if (!stats?.LONG || !stats?.SHORT) return 0;
  const { LONG, SHORT } = stats;
  if (LONG.n < MIN_DIRECTION_TRADES || SHORT.n < MIN_DIRECTION_TRADES) return 0;

  const long = planBias === 'LONG' || planBias === 'bullish';
  const short = planBias === 'SHORT' || planBias === 'bearish';
  if (!long && !short) return 0;

  const expLong = LONG.sumR / LONG.n;
  const expShort = SHORT.sumR / SHORT.n;
  const halfGap = (long ? expLong - expShort : expShort - expLong) / 2;
  return Math.max(-MAX_DIRECTION_TILT, Math.min(MAX_DIRECTION_TILT, halfGap));
}

export interface SizingSignal {
  /** Raw signed edge from measured factor skill, ~[-0.1, +0.1]. 0 when untrained. */
  readonly edge: number;
  /** Signed size tilt from the measured LONG/SHORT expectancy gap. */
  readonly directionTilt: number;
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
  directions?: DirectionStats,
  /**
   * Direction that would actually be traded. Defaults to `planBias` when the
   * caller has no separate trade plan — the two normally agree, but the tilt is
   * a claim about an executed direction, so the executed one wins when they
   * differ.
   */
  tradeDirection?: 'LONG' | 'SHORT' | 'NO TRADE',
): SizingSignal {
  const edge = accuracyEdge(votes, planBias, measured);
  const contributing = countContributing(votes, measured);
  /**
   * `LEGACY_ACCURACY=1` restores the PREVIOUS sizing rule in full — raw
   * accuracy and no explicit tilt — so a replay can score old against new over
   * identical trades. Both halves have to be switched together or the
   * comparison measures a rule that never shipped. Measurement only; never set
   * in production.
   */
  const legacy = process.env['LEGACY_ACCURACY'] === '1';
  const tilt = legacy ? 0 : directionTilt(tradeDirection ?? planBias, directions);

  // No track record on either term means no opinion: size at baseline rather
  // than guessing.
  if ((contributing === 0 || edge === 0) && tilt === 0) {
    return {
      edge: 0,
      directionTilt: 0,
      sizeMultiplier: 1,
      contributingFactors: contributing,
      rationale: contributing === 0
        ? 'No factor has enough graded history yet, and no measured direction edge — baseline size.'
        : 'Measured factor skill is balanced and directions perform alike — baseline size.',
    };
  }

  const raw = 1 + GAIN * edge + tilt;
  const sizeMultiplier = Number(Math.max(MIN_SIZE, Math.min(MAX_SIZE, raw)).toFixed(2));

  const parts: string[] = [];
  if (contributing > 0 && edge !== 0) {
    parts.push(
      `${contributing} factor${contributing === 1 ? '' : 's'} with graded history ` +
      `${edge > 0 ? 'support' : 'contradict'} this plan (skill ${edge >= 0 ? '+' : ''}${(edge * 100).toFixed(1)}pp)`,
    );
  }
  if (tilt !== 0) {
    parts.push(
      `this direction has historically earned ${tilt > 0 ? 'more' : 'less'} per trade ` +
      `than the other side (${tilt >= 0 ? '+' : ''}${tilt.toFixed(2)}x)`,
    );
  }
  return {
    edge: Number(edge.toFixed(4)),
    directionTilt: Number(tilt.toFixed(4)),
    sizeMultiplier,
    contributingFactors: contributing,
    rationale: `${parts.join('; ')} — size ${sizeMultiplier}x.`,
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
    // Must match accuracyEdge's admission rule exactly, or the rationale would
    // report a factor count that did not actually feed the number.
    if (!m || m.wins + m.losses < 30) continue;
    if (process.env['LEGACY_ACCURACY'] !== '1' && informedness(m) === null) continue;
    n++;
  }
  return n;
}
