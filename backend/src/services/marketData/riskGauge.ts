/**
 * Risk sentiment gauge — a fear/greed reading built from observable prices.
 *
 * WHY NOT SCRAPE CNN. Its Fear & Greed index has no public API; the endpoint
 * people use is undocumented and unversioned, so it can change shape without
 * notice and there is no way to inspect or reproduce the number it returns.
 * Composing the gauge here costs a little more and buys three things: every
 * component is visible, every input is already integrity-audited in this
 * project, and the whole thing is testable.
 *
 * CONSTRUCTION. Six components, each a spread or ratio between instruments that
 * behave differently when risk appetite changes, each expressed as its
 * PERCENTILE within its own trailing year. Percentile rather than a z-score
 * because the output is a 0-100 dial and a percentile already is one — mapping
 * a z through a squashing function would add a scale nobody can read back. A
 * component sitting at 80 means "higher than 80% of the past year", full stop.
 *
 * WHAT IT IS NOT. Context, like everything else on this page. These very
 * components were measured against 13,679 replayed trades earlier in this
 * project — VIX level, credit stress, risk appetite and breadth — and none
 * showed a stable relationship to outcomes. A dial is not a forecast, and this
 * one drives nothing.
 */

import { yf } from '../yahoo.js';

export type RiskLabel = 'Extreme Fear' | 'Fear' | 'Neutral' | 'Greed' | 'Extreme Greed';

export interface RiskComponent {
  key: string;
  label: string;
  /** What the reading means, in the reader's terms. */
  description: string;
  /** 0-100, where 100 is maximum risk appetite. Null when data was unavailable. */
  score: number | null;
  /** The underlying value, for transparency about what produced the score. */
  detail: string;
}

export interface RiskGauge {
  /** 0-100 composite, the mean of the available components. */
  score: number | null;
  label: RiskLabel;
  components: RiskComponent[];
  asOf: string | null;
  note: string;
}

/** Instruments the gauge needs. All already used elsewhere in this project. */
const SYMBOLS = ['SPY', 'TLT', 'HYG', 'LQD', 'RSP', 'XLY', 'XLP', '^VIX'] as const;
type Symbol = (typeof SYMBOLS)[number];

/** Trailing window the percentile is taken over: one year of sessions. */
const WINDOW = 252;
/** Lookback for the relative-performance components. */
const SPAN = 20;
/** Momentum lookback, matching the conventional 125-day trend reference. */
const TREND = 125;

type Series = { dates: string[]; closes: number[] };

/**
 * Percentile of the final value within the trailing window, 0-100.
 *
 * Rank-based, so a single spike cannot drag the reading the way a mean-and-
 * sigma mapping would — and these series are heavy-tailed by nature.
 */
function percentile(values: number[]): number | null {
  const window = values.slice(-WINDOW).filter(Number.isFinite);
  if (window.length < 60) return null;
  const last = window[window.length - 1];
  const below = window.filter(v => v < last).length;
  return Number(((below / (window.length - 1)) * 100).toFixed(1));
}

/** Trailing n-session return series, aligned to the input's tail. */
function rollingReturn(closes: number[], span: number): number[] {
  const out: number[] = [];
  for (let i = span; i < closes.length; i++) {
    const a = closes[i - span], b = closes[i];
    out.push(a > 0 && b > 0 ? Math.log(b / a) : NaN);
  }
  return out;
}

/** Difference of two rolling returns, aligned from the right. */
function spread(a: number[], b: number[]): number[] {
  const n = Math.min(a.length, b.length);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(a[a.length - n + i] - b[b.length - n + i]);
  return out;
}

/**
 * Restrict every series to the dates they ALL share, in order.
 *
 * Without this, `spread` aligns two series from the right and is correct only
 * while both happen to end on the same session. That held when checked — every
 * ETF returned 480 bars ending 2026-08-21 — but ^VIX returned 481 over the same
 * span, which is proof the feeds do not agree bar-for-bar. A single stale or
 * missing print from one symbol would silently compare Monday's SPY against
 * Friday's TLT and there would be nothing in the output to show it.
 *
 * Intersecting on the date is the difference between "correct" and "correct so
 * far". Everything downstream then shares one axis, so positional alignment is
 * true by construction rather than by luck.
 */
function alignOnCommonDates(data: Partial<Record<Symbol, Series>>): Partial<Record<Symbol, Series>> {
  const present = (Object.entries(data) as Array<[Symbol, Series]>).filter(([, v]) => v && v.dates.length);
  if (present.length === 0) return data;

  let common: string[] | null = null;
  for (const [, series] of present) {
    const set = new Set(series.dates);
    common = common === null ? [...set] : common.filter(d => set.has(d));
  }
  common!.sort();
  const keep = new Set(common!);

  const out: Partial<Record<Symbol, Series>> = {};
  for (const [sym, series] of present) {
    const dates: string[] = [];
    const closes: number[] = [];
    for (let i = 0; i < series.dates.length; i++) {
      if (keep.has(series.dates[i])) { dates.push(series.dates[i]); closes.push(series.closes[i]); }
    }
    out[sym] = { dates, closes };
  }
  return out;
}

export function labelFor(score: number): RiskLabel {
  if (score < 25) return 'Extreme Fear';
  if (score < 45) return 'Fear';
  if (score <= 55) return 'Neutral';
  if (score <= 75) return 'Greed';
  return 'Extreme Greed';
}

/** Build the gauge from already-fetched series. Separated so it can be tested. */
export function computeRiskGauge(raw: Partial<Record<Symbol, Series>>): RiskGauge {
  const data = alignOnCommonDates(raw);
  const closes = (s: Symbol) => data[s]?.closes;
  const components: RiskComponent[] = [];

  const add = (
    key: string, label: string, description: string,
    series: number[] | null, detail: string,
  ) => {
    components.push({ key, label, description, score: series ? percentile(series) : null, detail });
  };

  // 1. Volatility — a calm tape is a greedy one, so the percentile is inverted.
  const vix = closes('^VIX');
  if (vix) {
    const p = percentile(vix);
    components.push({
      key: 'volatility',
      label: 'Volatility',
      description: 'Implied volatility against its own trailing year. Calm reads as greed.',
      score: p === null ? null : Number((100 - p).toFixed(1)),
      detail: `VIX ${vix[vix.length - 1]?.toFixed(2) ?? '—'}`,
    });
  }

  // 2. Safe-haven demand — equities against long Treasuries.
  const spy = closes('SPY'), tlt = closes('TLT');
  if (spy && tlt) {
    add('safeHaven', 'Safe-haven demand',
      `Equities against long Treasuries over ${SPAN} sessions. Stocks winning reads as greed.`,
      spread(rollingReturn(spy, SPAN), rollingReturn(tlt, SPAN)),
      'SPY vs TLT');
  }

  // 3. Junk bond demand — the classic credit risk-appetite tell.
  const hyg = closes('HYG'), lqd = closes('LQD');
  if (hyg && lqd) {
    add('junkDemand', 'Junk bond demand',
      `High yield against investment grade over ${SPAN} sessions. Credit bid reads as greed.`,
      spread(rollingReturn(hyg, SPAN), rollingReturn(lqd, SPAN)),
      'HYG vs LQD');
  }

  // 4. Momentum — the index against its own intermediate trend.
  if (spy && spy.length > TREND) {
    const rel: number[] = [];
    for (let i = TREND; i < spy.length; i++) {
      const mean = spy.slice(i - TREND, i).reduce((a, b) => a + b, 0) / TREND;
      rel.push(mean > 0 ? spy[i] / mean - 1 : NaN);
    }
    add('momentum', 'Market momentum',
      `S&P 500 against its ${TREND}-session average. Above trend reads as greed.`,
      rel, 'SPY vs 125d mean');
  }

  // 5. Breadth — equal weight against cap weight. Narrow leadership reads as fear.
  const rsp = closes('RSP');
  if (rsp && spy) {
    add('breadth', 'Breadth',
      `Equal-weight against cap-weight S&P over ${SPAN} sessions. Broad participation reads as greed.`,
      spread(rollingReturn(rsp, SPAN), rollingReturn(spy, SPAN)),
      'RSP vs SPY');
  }

  // 6. Cyclical appetite — discretionary against staples.
  const xly = closes('XLY'), xlp = closes('XLP');
  if (xly && xlp) {
    add('cyclicals', 'Cyclical appetite',
      `Consumer discretionary against staples over ${SPAN} sessions. Cyclicals leading reads as greed.`,
      spread(rollingReturn(xly, SPAN), rollingReturn(xlp, SPAN)),
      'XLY vs XLP');
  }

  const scored = components.map(c => c.score).filter((s): s is number => s !== null);
  const score = scored.length >= 3
    ? Number((scored.reduce((a, b) => a + b, 0) / scored.length).toFixed(1))
    : null;

  const dates = data['SPY']?.dates;
  return {
    score,
    label: score === null ? 'Neutral' : labelFor(score),
    components,
    asOf: dates?.[dates.length - 1] ?? null,
    note: 'Composed from observable prices, not from a third-party index. Context only — these components were measured against 13,679 replayed trades and none showed a stable relationship to outcomes.',
  };
}

/** Fetch the inputs and build. Never throws; a missing symbol drops its component. */
export async function fetchRiskGauge(): Promise<RiskGauge> {
  const period1 = new Date(Date.now() - 700 * 86_400_000).toISOString().slice(0, 10);
  const entries = await Promise.all(SYMBOLS.map(async sym => {
    try {
      const quotes = await yf.chart(sym, { period1, interval: '1d' }).then(r => r.quotes);
      const dates: string[] = [];
      const closes: number[] = [];
      for (const q of quotes) {
        if (q?.close == null || !Number.isFinite(q.close)) continue;
        dates.push(new Date(q.date).toISOString().slice(0, 10));
        closes.push(q.close);
      }
      return [sym, { dates, closes }] as const;
    } catch (e) {
      console.error(`[RiskGauge] ${sym} failed`, e);
      return [sym, null] as const;
    }
  }));
  const data: Partial<Record<Symbol, Series>> = {};
  for (const [sym, series] of entries) if (series) data[sym] = series;
  return computeRiskGauge(data);
}
