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
  /**
   * Optional — when present, enables `forwardReturn` and a realized R for
   * TIMEOUT outcomes. Callers grading from OHLC always have it; the older
   * high/low-only call sites still work and simply get nulls for those fields.
   */
  readonly close?: number;
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
  /**
   * Raw fractional price change from entry to the close of the LAST bar in the
   * horizon — not the resolving bar. Positive means price ended higher,
   * regardless of trade direction.
   *
   * Deliberately measured over the full window rather than to the exit: this
   * grades a *directional claim* over the prediction horizon, which is what
   * factor-level learning needs. Using the exit instead would score every
   * factor on the plan's stop placement rather than on its own forecast.
   *
   * null when bars carry no `close`.
   */
  readonly forwardReturn: number | null;
  /**
   * Realized R of the trade: +planned R on TARGET, -1 on STOP, and the actual
   * mark-to-close R on TIMEOUT.
   *
   * A TIMEOUT is not a loss. The original loop scored it 0.0, identical to a
   * stop-out, which biased learning toward setups with targets tight enough to
   * resolve inside the horizon and punished correct-but-slow theses.
   *
   * null for AMBIGUOUS (unknowable) and when risk-per-share is degenerate.
   */
  readonly realizedR: number | null;
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

  // Measured across the whole horizon, independent of when (or whether) the
  // trade resolved — see GradeResult.forwardReturn.
  const horizonClose = bars.length > 0 ? bars[bars.length - 1].close : undefined;
  const forwardReturn =
    horizonClose != null && entryPrice > 0 ? (horizonClose - entryPrice) / entryPrice : null;

  const riskPerShare = Math.abs(entryPrice - stop);
  const rFor = (exit: number): number | null => {
    if (!(riskPerShare > 0)) return null;
    return (isShort ? entryPrice - exit : exit - entryPrice) / riskPerShare;
  };

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
        forwardReturn,
        // Intrabar order unknowable, so the realized R is unknowable too.
        realizedR: null,
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
        forwardReturn,
        realizedR: rFor(target),
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
        forwardReturn,
        // Assume the stop filled at its level; slippage is not observable here.
        realizedR: rFor(stop),
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
    forwardReturn,
    // Marked to the horizon close rather than scored 0.0 — an unresolved plan
    // that drifted favourably is not the same result as a stop-out.
    realizedR: horizonClose != null ? rFor(horizonClose) : null,
  };
}
