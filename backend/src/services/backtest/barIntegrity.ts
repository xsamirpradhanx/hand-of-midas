/**
 * Bar-store integrity audit.
 *
 * WHAT WENT WRONG. A subset of the Schwab-sourced daily history in the store is
 * dividend-adjusted by SUBTRACTION rather than by ratio: each historical price
 * has the dividends paid since then deducted from it. For a long-lived payer
 * the deduction eventually exceeds the old price and the series goes negative —
 * COST reads -29.56 in August 1986, COP -17.19 — and the closer to the present,
 * the smaller the error, so it converges to correct data and hides in plain
 * sight. Coverage metadata claims "split-adjusted, NOT dividend-adjusted",
 * which is what the series looks like once the deduction has decayed away.
 *
 * WHY IT MATTERS MORE THAN IT LOOKS. A percentage return divides by the price.
 * Shrinking a historical price toward zero inflates every return computed
 * across it without bound, and no plausibility check on the RETURN catches it,
 * because the inflated values are the input to the check. On the worst symbols
 * a single day reads as a move of 10^17 percent. Any statistic pooled over
 * those symbols is dominated by them.
 *
 * HOW IT IS DETECTED. Intrinsically it is not reliably detectable: once the
 * deduction is smaller than the price, the series stays positive and merely
 * wrong, and no self-consistency test distinguishes "wrong by 20%" from a
 * genuinely cheaper stock. So it is detected against an external reference.
 * Yahoo's chart close carries the SAME convention the store claims to —
 * split-adjusted, not dividend-adjusted — which makes the comparison a direct
 * ratio: agreement is 1.00x and any sustained departure is a defect.
 *
 * The verdict is a per-symbol `trustedFrom` date rather than a keep/drop flag,
 * because the corruption decays: COST is unusable in 1995, off by 22% in 2015,
 * and exact today. Truncating at the point the error falls under tolerance
 * keeps most of the history of most affected symbols.
 */

import fs from 'node:fs';
import { readPanel, DEFAULT_CACHE_DIR } from './barCache.js';

export const INTEGRITY_FILE = new URL('../../../bar-integrity.json', import.meta.url).pathname;

/**
 * Return-space tolerance: how far a stored daily return may sit from the
 * reference before the bar counts against the symbol.
 *
 * 20 bp is generous against how exactly the clean symbols agree — they match to
 * floating-point rounding — and comfortably absorbs the odd late print or
 * half-cent difference in a low-priced name.
 */
export const RETURN_TOLERANCE = 0.002;

/**
 * Comparisons the discrepancy must persist across before the history is called
 * corrupt. One trading month: long enough that no isolated reference glitch
 * survives it, short enough to locate the boundary of a decaying distortion to
 * within a few weeks.
 */
export const PERSISTENCE_WINDOW = 21;

export interface SymbolVerdict {
  readonly symbol: string;
  /** Earliest date whose bars are trustworthy; null when the whole series is. */
  readonly trustedFrom: string | null;
  /** Worst absolute daily-return discrepancy seen, or the level ratio when clean. */
  readonly worstError: number;
  /** Bars discarded by `trustedFrom`, and the total checked. */
  readonly droppedBars: number;
  readonly comparedBars: number;
  readonly verdict: 'clean' | 'truncated' | 'unusable' | 'unchecked';
  readonly note?: string;
}

export interface IntegrityReport {
  readonly auditedAt: string;
  readonly tolerance: number;
  readonly symbols: Record<string, SymbolVerdict>;
}

export function loadIntegrityReport(file = INTEGRITY_FILE): IntegrityReport | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

/**
 * Compare one symbol's stored series against a reference close series.
 *
 * `reference` is keyed by ISO date. Bars with no reference entry are skipped
 * rather than failed — Yahoo's history is shorter than the store's for some
 * names, and absence of a reference is not evidence of corruption.
 *
 * `trustedFrom` is the first date after which NO bar exceeds tolerance, scanned
 * backwards. Scanning backwards rather than forwards matters: the error decays
 * toward the present, so the first in-tolerance bar going forward can easily be
 * a crossing of the zero line inside a still-corrupt span.
 */
export function verdictFor(
  symbol: string,
  bars: { date: string; close: number }[],
  reference: ReadonlyMap<string, number>,
  tolerance = RETURN_TOLERANCE,
): SymbolVerdict {
  /**
   * Compared in RETURN space, not price space.
   *
   * The first version of this compared price levels and it was measuring the
   * wrong thing. A stored series that is a CONSTANT multiple of the reference —
   * GE sits at 1.04x for its whole life, from an old spinoff convention — has
   * every return exactly right, because the constant cancels in a ratio. Judged
   * on levels it looked as broken as COST and cost 8,617 perfectly good bars.
   *
   * What actually destroys a return is a ratio that MOVES, which is precisely
   * what subtractive dividend adjustment does: it shrinks old prices by an
   * amount that decays toward the present. Differencing both series first makes
   * the detector blind to level offsets and sensitive only to the drift, which
   * is the defect and also the only part research consumes.
   */
  const compared: { date: string; err: number }[] = [];
  let prev: { stored: number; ref: number } | null = null;
  let worstLevelRatio = 0;
  for (const b of bars) {
    const ref = reference.get(b.date);
    if (ref === undefined || !(ref > 0) || !Number.isFinite(b.close)) continue;

    /**
     * A stored price that is not positive is invalid on its face and counts as
     * maximally wrong immediately.
     *
     * Without this the worst corruption in the store is the one case the
     * detector cannot see. A return needs a previous price to divide by, so a
     * RUN of zeros yields no comparisons at all — the loop just keeps skipping —
     * and a symbol whose first 3,978 bars are zero reads as clean because only
     * its intact tail was ever examined. The subtractive dividend adjustment
     * produces exactly this: prices crossing zero on their way negative.
     */
    if (b.close <= 0) {
      compared.push({ date: b.date, err: Infinity });
      prev = { stored: b.close, ref };
      continue;
    }
    worstLevelRatio = Math.max(worstLevelRatio, Math.abs(b.close / ref - 1));

    if (prev && prev.stored > 0 && prev.ref > 0) {
      const storedRet = b.close / prev.stored - 1;
      const refRet = ref / prev.ref - 1;
      compared.push({ date: b.date, err: Math.abs(storedRet - refRet) });
    } else if (prev) {
      // The bar immediately after an invalid price has no usable base to
      // difference against, so it is out of tolerance too.
      compared.push({ date: b.date, err: Infinity });
    }
    prev = { stored: b.close, ref };
  }

  if (compared.length < 50) {
    return {
      symbol, trustedFrom: null, worstError: 0, droppedBars: 0, comparedBars: compared.length,
      verdict: 'unchecked', note: 'too few overlapping reference bars to judge',
    };
  }

  const finite = compared.filter(c => Number.isFinite(c.err));
  const worstError = finite.length ? finite.reduce((m, c) => Math.max(m, c.err), 0) : Infinity;

  /**
   * The boundary is the last bar whose discrepancy is PERSISTENTLY out of
   * tolerance, as a rolling median. A plain backwards scan for the last bad bar
   * is far too brittle — one stale reference print in 2026 would discard the
   * entire preceding history. The corruption being hunted is smooth and
   * monotone, so it always appears as a sustained run, never as a lone bar.
   */
  const w = Math.min(PERSISTENCE_WINDOW, compared.length);
  const errs = compared.map(c => c.err);
  let firstBad = -1;
  for (let i = compared.length - 1; i >= w - 1; i--) {
    const window = errs.slice(i - w + 1, i + 1).sort((a, b) => a - b);
    const med = window[Math.floor(window.length / 2)];
    if (med > tolerance) { firstBad = i; break; }
  }
  if (firstBad === -1) {
    return {
      symbol, trustedFrom: null, worstError: worstLevelRatio, droppedBars: 0,
      comparedBars: compared.length, verdict: 'clean',
    };
  }
  const trustedFrom = firstBad + 1 < compared.length ? compared[firstBad + 1].date : null;
  const dropped = bars.filter(b => trustedFrom === null || b.date < trustedFrom).length;
  return {
    symbol,
    trustedFrom,
    worstError,
    droppedBars: dropped,
    comparedBars: compared.length,
    verdict: trustedFrom === null ? 'unusable' : 'truncated',
    note: `stored daily returns diverge from the reference by up to ${
      Number.isFinite(worstError) ? (worstError * 100).toFixed(1) + '%' : 'a non-finite amount'
    } before ${trustedFrom ?? 'the end of the series'}`,
  };
}

/** Per-symbol earliest trustworthy timestamp, for filtering a panel. */
export function trustedFromMs(report: IntegrityReport | null, symbol: string): number {
  const v = report?.symbols[symbol];
  if (!v) return -Infinity;
  if (v.verdict === 'unusable') return Infinity;
  return v.trustedFrom ? Date.parse(v.trustedFrom) : -Infinity;
}

/** Bars of a cached symbol as {date, close}, for the audit. */
export function storedCloses(symbol: string, dir = DEFAULT_CACHE_DIR): { date: string; close: number }[] {
  const p = readPanel(dir, symbol, '1day');
  if (!p) return [];
  const out: { date: string; close: number }[] = [];
  for (let i = 0; i < p.n; i++) out.push({ date: new Date(p.t[i]).toISOString().slice(0, 10), close: p.c[i] });
  return out;
}
