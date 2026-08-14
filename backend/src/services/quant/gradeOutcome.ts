/**
 * Pure grading logic for a prediction against subsequent OHLC bars.
 *
 * Extracted from evaluateQuant.ts so it can be tested without hitting
 * DynamoDB or Yahoo. The previous inline logic collapsed same-bar
 * target+stop hits into STOP (score 0.0), which manufactured certainty
 * about intrabar order — impossible to know from OHLC alone. Same-bar
 * hits now produce AMBIGUOUS (score 0.5) and are excluded from wins and
 * losses. The rate of ambiguous outcomes is tracked separately so we can
 * see how often the daily-bar horizon is too coarse for the setup.
 */

export type OutcomeCode = 'TARGET' | 'STOP' | 'TIMEOUT' | 'AMBIGUOUS';

export interface GradeInput {
  readonly high: number;
  readonly low: number;
}

export interface GradeResult {
  readonly outcome: OutcomeCode;
  /** 1.0 target, 0.0 stop, 0.0 timeout, 0.5 ambiguous. */
  readonly score: number;
  readonly hitTarget: boolean;
  readonly hitStop: boolean;
  readonly ambiguous: boolean;
  /** Peak favourable excursion (fractional, e.g. 0.05 = 5%). */
  readonly maxExcursion: number;
  /** How many bars were consumed before resolution (0 if bars empty). */
  readonly barsElapsed: number;
}

export function gradeOutcome(
  futureBars: readonly GradeInput[],
  target: number,
  stop: number,
  bias: 'LONG' | 'SHORT' | 'BEARISH',
  entryPrice: number,
  horizon: number,
): GradeResult {
  const isShort = bias === 'SHORT' || bias === 'BEARISH';
  let maxExcursion = 0;
  const bars = futureBars.slice(0, horizon);

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const barHitStop = isShort ? bar.high >= stop : bar.low <= stop;
    const barHitTarget = isShort ? bar.low <= target : bar.high >= target;

    const excursion = isShort
      ? (entryPrice - bar.low) / entryPrice
      : (bar.high - entryPrice) / entryPrice;
    if (excursion > maxExcursion) maxExcursion = excursion;

    if (barHitStop && barHitTarget) {
      // Intrabar order unknowable from OHLC. Neither wins nor losses.
      return {
        outcome: 'AMBIGUOUS',
        score: 0.5,
        hitTarget: true,
        hitStop: true,
        ambiguous: true,
        maxExcursion,
        barsElapsed: i + 1,
      };
    }
    if (barHitTarget) {
      return {
        outcome: 'TARGET',
        score: 1.0,
        hitTarget: true,
        hitStop: false,
        ambiguous: false,
        maxExcursion,
        barsElapsed: i + 1,
      };
    }
    if (barHitStop) {
      return {
        outcome: 'STOP',
        score: 0.0,
        hitTarget: false,
        hitStop: true,
        ambiguous: false,
        maxExcursion,
        barsElapsed: i + 1,
      };
    }
  }

  return {
    outcome: 'TIMEOUT',
    score: 0.0,
    hitTarget: false,
    hitStop: false,
    ambiguous: false,
    maxExcursion,
    barsElapsed: bars.length,
  };
}
