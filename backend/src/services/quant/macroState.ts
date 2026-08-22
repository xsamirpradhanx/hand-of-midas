/**
 * Market-wide state, built from instruments already in the bar store.
 *
 * WHY THIS SHAPE. Everything the indicator lab measures is CROSS-SECTIONAL —
 * which names beat their peers on a given day. Macro is the opposite kind of
 * signal: it does not distinguish AAPL from MSFT, it says something about the
 * whole tape. The lab cannot see it by construction, and in fact actively
 * rejects it (`crossSectionalShare` exists to throw market-wide series out).
 * So macro needs its own measurement, and this module supplies the input.
 *
 * WHY NO NEW DATA SOURCE YET. The store already holds ^VIX back to 1990, the
 * Treasury complex to 2002, credit to 2007, and gold / oil / dollar to
 * 2004-2007 — all integrity-clean. A state vector built from those is testable
 * over decades TODAY, where a new provider would need a backfill and an audit
 * before it could be trusted. FRED is the sensible next addition (real yields,
 * the 10y-2y spread and true credit spreads have no ETF proxy), but only once
 * this axis has shown it matters.
 *
 * WAR AND GEOPOLITICS, honestly. Headlines have no clean backtestable history,
 * so a news-driven factor could never be validated here — it would be another
 * unmeasurable addition of exactly the kind that already measured worthless.
 * What IS backtestable is the market SIGNATURE such events produce: oil bid,
 * gold bid, dollar bid, volatility bid, credit under pressure. `geopolitical`
 * below composes that from instruments with real history.
 *
 * EVERY STATE IS CAUSAL AND SELF-NORMALISING. A state at date d uses only data
 * through d, and is expressed as a z-score against its own trailing window, so
 * a VIX of 20 in 1998 and a VIX of 20 in 2026 are compared as regimes rather
 * than as levels.
 */

import type { BarPanel } from '../backtest/barCache.js';
import { rollMean, rollStd, zScore, logReturns } from './indicatorPrimitives.js';

/** A named market-wide series on the global date axis. NaN where undefined. */
export interface MacroState {
  readonly name: string;
  readonly description: string;
  /** Aligned to the global date axis. */
  readonly values: Float64Array;
}

export interface MacroInputs {
  /** Global date axis, ascending epoch ms. */
  readonly dates: Float64Array;
  /** Close series per symbol, aligned to `dates`, forward-filled. NaN before listing. */
  readonly closes: ReadonlyMap<string, Float64Array>;
}

/**
 * Align a panel's closes onto the global date axis, forward-filling gaps.
 *
 * Forward-fill rather than interpolate: on a day an instrument did not trade,
 * the last known price IS the information a decision-maker had. Interpolating
 * would invent a price nobody could have seen.
 */
export function alignClose(panel: BarPanel, dateIndex: Int32Array, nDates: number): Float64Array {
  const out = new Float64Array(nDates).fill(NaN);
  for (let i = 0; i < panel.n; i++) {
    const d = dateIndex[i];
    if (d >= 0) out[d] = panel.c[i];
  }
  for (let d = 1; d < nDates; d++) if (Number.isNaN(out[d])) out[d] = out[d - 1];
  return out;
}

/** Ratio of two aligned series, as a log so it is symmetric in both directions. */
function logRatio(a: Float64Array | undefined, b: Float64Array | undefined): Float64Array | null {
  if (!a || !b) return null;
  const out = new Float64Array(a.length).fill(NaN);
  for (let i = 0; i < a.length; i++) {
    if (a[i] > 0 && b[i] > 0) out[i] = Math.log(a[i] / b[i]);
  }
  return out;
}

/** Trailing z-score, the common normalisation for every state below. */
const Z_WINDOW = 252;
const z = (xs: Float64Array) => zScore(xs, Z_WINDOW);

/** Sum of the finite members, divided by how many were finite. */
function average(series: (Float64Array | null)[]): Float64Array {
  const present = series.filter((s): s is Float64Array => s !== null);
  if (present.length === 0) return new Float64Array(0);
  const n = present[0].length;
  const out = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    let sum = 0, k = 0;
    for (const s of present) if (Number.isFinite(s[i])) { sum += s[i]; k++; }
    // Require most components present, or a composite silently becomes
    // whichever single instrument happened to have history that far back.
    if (k >= Math.ceil(present.length * 0.6)) out[i] = sum / k;
  }
  return out;
}

export function buildMacroStates(inputs: MacroInputs): MacroState[] {
  const { closes } = inputs;
  const get = (s: string) => closes.get(s);
  const n = inputs.dates.length;
  const states: MacroState[] = [];
  const add = (name: string, description: string, values: Float64Array | null) => {
    if (values && values.length === n) states.push({ name, description, values });
  };

  // ── volatility ───────────────────────────────────────────────────────────
  const vix = get('^VIX');
  if (vix) {
    const lv = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) if (vix[i] > 0) lv[i] = Math.log(vix[i]);
    add('vix_level', 'Implied volatility regime, z-scored against its own trailing year', z(lv));
    // Change matters separately from level: a rising VIX at 15 and a falling
    // VIX at 35 are different regimes that a level alone reports identically.
    const chg = new Float64Array(n).fill(NaN);
    for (let i = 21; i < n; i++) if (Number.isFinite(lv[i]) && Number.isFinite(lv[i - 21])) chg[i] = lv[i] - lv[i - 21];
    add('vix_change', 'One-month change in log implied volatility', z(chg));
  }

  // ── credit ───────────────────────────────────────────────────────────────
  // High yield against investment grade. Widening = risk-off, and credit
  // typically leads equities rather than following them.
  add('credit_stress', 'High-yield underperformance vs investment grade (HYG/LQD)',
    (() => { const r = logRatio(get('HYG'), get('LQD')); return r ? z(r) : null; })());

  // ── rates ────────────────────────────────────────────────────────────────
  add('duration_bid', 'Long Treasuries vs short (TLT/SHY) — falling long rates / flight to duration',
    (() => { const r = logRatio(get('TLT'), get('SHY')); return r ? z(r) : null; })());
  add('rate_move', 'One-month move in long Treasuries (TLT)',
    (() => {
      const tlt = get('TLT'); if (!tlt) return null;
      const out = new Float64Array(n).fill(NaN);
      for (let i = 21; i < n; i++) if (tlt[i] > 0 && tlt[i - 21] > 0) out[i] = Math.log(tlt[i] / tlt[i - 21]);
      return z(out);
    })());

  // ── risk appetite ────────────────────────────────────────────────────────
  add('risk_appetite', 'Discretionary vs staples (XLY/XLP) — the classic cyclical risk gauge',
    (() => { const r = logRatio(get('XLY'), get('XLP')); return r ? z(r) : null; })());
  add('breadth', 'Equal-weight vs cap-weight S&P (RSP/SPY) — narrow leadership reads negative',
    (() => { const r = logRatio(get('RSP'), get('SPY')); return r ? z(r) : null; })());

  // ── the geopolitical signature ───────────────────────────────────────────
  // Not headlines — the market state that geopolitical shocks produce, which
  // unlike headlines has two decades of history to test against.
  const oil = (() => {
    const uso = get('USO'); if (!uso) return null;
    const out = new Float64Array(n).fill(NaN);
    for (let i = 21; i < n; i++) if (uso[i] > 0 && uso[i - 21] > 0) out[i] = Math.log(uso[i] / uso[i - 21]);
    return z(out);
  })();
  const gold = (() => {
    const gld = get('GLD'), spy = get('SPY');
    const r = logRatio(gld, spy); return r ? z(r) : null;
  })();
  const dollar = (() => {
    const uup = get('UUP'); if (!uup) return null;
    const out = new Float64Array(n).fill(NaN);
    for (let i = 21; i < n; i++) if (uup[i] > 0 && uup[i - 21] > 0) out[i] = Math.log(uup[i] / uup[i - 21]);
    return z(out);
  })();
  add('oil_shock', 'One-month oil move (USO)', oil);
  add('gold_bid', 'Gold vs equities (GLD/SPY) — flight to safety', gold);
  add('geopolitical', 'Composite of oil bid, gold bid, dollar bid and volatility bid',
    (() => {
      const vixState = states.find(s => s.name === 'vix_level')?.values ?? null;
      const parts = [oil, gold, dollar, vixState];
      const avg = average(parts);
      return avg.length === n ? avg : null;
    })());

  return states;
}
