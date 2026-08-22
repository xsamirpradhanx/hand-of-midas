/**
 * FRED (St. Louis Fed) macro series.
 *
 * Added for one measured reason. Conditioning trade outcomes on the direction
 * of long rates was the only macro axis that behaved consistently across eras
 * (+0.1225R pre-2013, +0.1139R after, on the LONG book), but the test ran on
 * TLT, which begins in 2002 — two eras and ~2,900 tercile trades. That is
 * exactly the sample where a t of 2.37 cannot be separated from noise.
 *
 * `DGS10` runs from 1962 and `T10Y2Y` from 1976, so both cover the entire
 * replayed trade set back to 1985: roughly four times the sample and four
 * decades instead of two. They are also the actual quantities rather than an
 * ETF standing in for them — TLT carries duration drift, roll and expense that
 * a constant-maturity yield does not.
 *
 * ONE SERIES DELIBERATELY NOT USED. `BAMLH0A0HYM2` (high-yield OAS) would be
 * the right credit measure, but FRED's API serves only the trailing three years
 * of ICE BofA data under licence — 795 observations from 2023. Unusable for
 * history, so credit stays on the HYG/LQD proxy, which already failed its era
 * split.
 *
 * VINTAGE CAVEAT, stated because it bounds what these can be used for. FRED
 * serves the CURRENT revision of a series, not what was known on the day. For
 * market rates (DGS10, T10Y2Y) that is harmless — a Treasury yield is observed,
 * not estimated, and is not revised. It would NOT be harmless for macro
 * aggregates like GDP or payrolls, which are revised for years afterwards;
 * using those here would leak information no one had at the time. Only
 * non-revised market series belong in this module.
 */

import fs from 'node:fs';
import path from 'node:path';

const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';

export const FRED_CACHE_DIR = new URL('../../../.fredcache/', import.meta.url).pathname;

/** One observation: an ISO date and a value, or null where FRED reports ".". */
export interface FredPoint {
  readonly date: string;
  readonly value: number | null;
}

export interface FredSeries {
  readonly id: string;
  readonly points: readonly FredPoint[];
  readonly fetchedAt: string;
}

/**
 * Series this project uses, with why each is here.
 *
 * Restricted to observed market rates — see the vintage caveat above.
 */
export const FRED_SERIES = {
  DGS10: '10-year Treasury constant maturity yield (1962-)',
  DGS2: '2-year Treasury constant maturity yield (1976-)',
  DGS3MO: '3-month Treasury bill yield (1981-)',
  T10Y2Y: '10-year minus 2-year term spread (1976-)',
  T10Y3M: '10-year minus 3-month term spread (1982-)',
  DFF: 'Effective federal funds rate (1954-)',
  DFII10: '10-year TIPS real yield (2003-)',
  T10YIE: '10-year breakeven inflation (2003-)',

  // ── policy rates outside the US ──
  ECBDFR: 'ECB deposit facility rate (1999-)',
  IUDSOIA: 'SONIA, sterling overnight rate (1997-)',
  IRSTCI01JPM156N: 'Japan overnight call money rate (1985-)',
  IRSTCI01CAM156N: 'Canada overnight rate (1975-)',
  IRSTCI01AUM156N: 'Australia interbank overnight rate (1990-)',
} as const;

export type FredSeriesId = keyof typeof FRED_SERIES;

function cacheFile(id: string): string {
  return path.join(FRED_CACHE_DIR, `${id}.json`);
}

export function readCachedSeries(id: string): FredSeries | null {
  try { return JSON.parse(fs.readFileSync(cacheFile(id), 'utf-8')); } catch { return null; }
}

/**
 * Fetch one series and cache it.
 *
 * `observation_start` defaults to 1960 so a series returns its full history in
 * one request; every series here is a few tens of thousands of points at most,
 * which is a single response and no pagination.
 */
export async function fetchSeries(id: string, options: { start?: string; force?: boolean } = {}): Promise<FredSeries> {
  if (!options.force) {
    const cached = readCachedSeries(id);
    if (cached) return cached;
  }
  const apiKey = process.env['FRED_API_KEY'];
  if (!apiKey) throw new Error('FRED_API_KEY is not set — add it to backend/.env');

  const url = `${FRED_BASE}?series_id=${encodeURIComponent(id)}&api_key=${apiKey}` +
    `&file_type=json&observation_start=${options.start ?? '1960-01-01'}&limit=100000`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED ${id}: HTTP ${res.status}`);
  const body = await res.json() as { observations?: Array<{ date: string; value: string }> };
  if (!body.observations) throw new Error(`FRED ${id}: no observations in response`);

  const points: FredPoint[] = body.observations.map(o => ({
    date: o.date,
    // FRED writes "." for a missing observation (holidays, non-publication).
    value: o.value === '.' ? null : Number(o.value),
  }));
  const series: FredSeries = { id, points, fetchedAt: new Date().toISOString() };
  // Best-effort local cache. Lambda's filesystem is read-only outside /tmp, and
  // the route path caches through DynamoDB anyway — losing the file cache costs
  // a refetch, not correctness, so a failure here must not fail the request.
  try {
    fs.mkdirSync(FRED_CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFile(id), JSON.stringify(series));
  } catch { /* research convenience only */ }
  return series;
}

/**
 * Align a series onto a date axis, forward-filling.
 *
 * Forward-fill because a rate that did not publish today has not changed as far
 * as any decision-maker knew — the last print IS the information available.
 * Interpolating would invent a level nobody could have observed, and doing it
 * from a LATER print would leak the future.
 */
export function alignSeries(series: FredSeries, dates: Float64Array): Float64Array {
  const out = new Float64Array(dates.length).fill(NaN);
  const byDate = new Map<string, number>();
  for (const p of series.points) if (p.value !== null && Number.isFinite(p.value)) byDate.set(p.date, p.value);

  // Sorted observation dates, walked in step with the axis so this stays linear.
  const obsDates = [...byDate.keys()].sort();
  let oi = 0;
  let last = NaN;
  for (let d = 0; d < dates.length; d++) {
    const iso = new Date(dates[d]).toISOString().slice(0, 10);
    while (oi < obsDates.length && obsDates[oi] <= iso) {
      last = byDate.get(obsDates[oi])!;
      oi++;
    }
    out[d] = last;
  }
  return out;
}


/** Latest observed value and the change over a lookback, in the series' own units. */
export interface FredSnapshot {
  readonly id: string;
  readonly description: string;
  readonly value: number | null;
  readonly asOf: string | null;
  readonly change1d: number | null;
  readonly change1m: number | null;
  readonly change1y: number | null;
  /** Trailing points for charting, oldest first. */
  readonly history: ReadonlyArray<{ date: string; value: number }>;
}

/**
 * Summarise one series for display.
 *
 * Changes are absolute differences in the series' own units — percentage points
 * for a yield or a spread. A percentage change would be meaningless on a spread
 * that crosses zero, which the 10y-2y does.
 */
export function snapshot(series: FredSeries, description: string, historyDays = 504): FredSnapshot {
  const valued = series.points.filter((p): p is { date: string; value: number } =>
    p.value !== null && Number.isFinite(p.value));
  if (valued.length === 0) {
    return { id: series.id, description, value: null, asOf: null, change1d: null, change1m: null, change1y: null, history: [] };
  }
  const last = valued[valued.length - 1];
  const back = (n: number) => {
    const i = valued.length - 1 - n;
    return i >= 0 ? last.value - valued[i].value : null;
  };
  return {
    id: series.id,
    description,
    value: last.value,
    asOf: last.date,
    change1d: back(1),
    change1m: back(21),
    change1y: back(252),
    history: valued.slice(-historyDays),
  };
}


/**
 * Compact macro snapshot stamped onto each prediction row.
 *
 * A FIELD on the row, never part of the learning KEY. Adding regime to the key
 * would fork every archetype into N macro states — exactly the fragmentation
 * `[LOW QUALITY]` caused, turning 4 setup keys into 8 with the thinnest holding
 * 238 trades. Live it is worse, since the Trade Plan writes once per day per
 * symbol, so each extra key takes proportionally longer to reach a usable
 * sample. As a field it dilutes nothing and can be sliced offline later.
 *
 * Stamped even though rates measured NULL against 13,679 replayed trades. The
 * backtest answered "did this matter historically". The stamp answers "does it
 * matter for the trades this engine actually takes from here" — a different
 * population, and one that cannot be studied retroactively if the data was
 * never recorded. Recording is cheap.
 */
export interface MacroStamp {
  /** 10-year Treasury constant maturity yield, percent. */
  dgs10: number | null;
  /** One-month change in the 10-year, percentage points. */
  dgs10Change1m: number | null;
  /** 10y-2y term spread, percentage points. Negative is inverted. */
  t10y2y: number | null;
  /** 10-year TIPS real yield, percent. */
  realYield10: number | null;
  /** Effective fed funds rate, percent. */
  fedFunds: number | null;
  asOf: string | null;
}

/**
 * Build the stamp from cached series.
 *
 * Never throws: a macro outage must not cost a graded outcome, so every failure
 * degrades to undefined and the prediction is written without it.
 */
export async function macroStamp(): Promise<MacroStamp | undefined> {
  try {
    const [ten, curve, real, funds] = await Promise.all([
      fetchSeries('DGS10').catch(() => null),
      fetchSeries('T10Y2Y').catch(() => null),
      fetchSeries('DFII10').catch(() => null),
      fetchSeries('DFF').catch(() => null),
    ]);
    if (!ten) return undefined;
    const latest = (s: FredSeries | null) => (s ? snapshot(s, '', 2).value : null);
    const tenSnap = snapshot(ten, '', 260);
    return {
      dgs10: tenSnap.value,
      dgs10Change1m: tenSnap.change1m,
      t10y2y: latest(curve),
      realYield10: latest(real),
      fedFunds: latest(funds),
      asOf: tenSnap.asOf,
    };
  } catch {
    return undefined;
  }
}


/**
 * One central bank's current policy stance.
 *
 * `stance` is DERIVED from the observed rate path, not from any statement. It
 * says what a bank has done, which is a fact; it does not say what one intends,
 * which is forward guidance and has no free, machine-readable source. Nothing
 * here should be read as an expectation.
 */
export interface CentralBankRate {
  bank: string;
  region: string;
  seriesId: string;
  /** True when this is the official policy rate; false when it is a market proxy. */
  official: boolean;
  rate: number | null;
  asOf: string | null;
  /** Percentage-point change over the trailing window. */
  change3m: number | null;
  change12m: number | null;
  /** When the rate last moved by a meaningful step, and by how much. */
  lastChangeDate: string | null;
  lastChangeDelta: number | null;
  monthsSinceChange: number | null;
  stance: 'HIKING' | 'CUTTING' | 'ON HOLD' | 'UNKNOWN';
}

interface BankSpec {
  bank: string; region: string; seriesId: string; official: boolean; note: string;
}

/**
 * Which series stands for which bank, and whether it is the real thing.
 *
 * Two of these are proxies and are labelled as such. SONIA is an overnight
 * index that tracks Bank Rate rather than being it, and the OECD call-money
 * series track their policy rates closely without being the announced rate.
 * Presenting a proxy as the official rate would be a small lie that compounds:
 * a reader would take a 4bp drift as a policy move.
 */
export const CENTRAL_BANKS: BankSpec[] = [
  { bank: 'Federal Reserve', region: 'United States', seriesId: 'DFF', official: true,
    note: 'Effective federal funds rate' },
  { bank: 'ECB', region: 'Euro area', seriesId: 'ECBDFR', official: true,
    note: 'Deposit facility rate' },
  { bank: 'Bank of England', region: 'United Kingdom', seriesId: 'IUDSOIA', official: false,
    note: 'SONIA — tracks Bank Rate, not the announced rate' },
  { bank: 'Bank of Japan', region: 'Japan', seriesId: 'IRSTCI01JPM156N', official: false,
    note: 'Overnight call money — tracks the BoJ target' },
  { bank: 'Bank of Canada', region: 'Canada', seriesId: 'IRSTCI01CAM156N', official: false,
    note: 'Overnight rate' },
  { bank: 'Reserve Bank of Australia', region: 'Australia', seriesId: 'IRSTCI01AUM156N', official: false,
    note: 'Interbank overnight cash rate' },
];

/**
 * A policy move worth reporting, in percentage points.
 *
 * Policy rates move in 25bp steps, so 12bp is comfortably below the smallest
 * real decision while staying above the daily drift an overnight market rate
 * shows around its target — which is exactly what the proxy series do.
 */
const MOVE_THRESHOLD = 0.12;

/** Months a rate must sit still before "on hold" rather than "recently moved". */
const HOLD_MONTHS = 9;

export function centralBankStance(series: FredSeries, spec: BankSpec): CentralBankRate {
  const valued = series.points.filter((p): p is { date: string; value: number } =>
    p.value !== null && Number.isFinite(p.value));
  const base: CentralBankRate = {
    bank: spec.bank, region: spec.region, seriesId: spec.seriesId, official: spec.official,
    rate: null, asOf: null, change3m: null, change12m: null,
    lastChangeDate: null, lastChangeDelta: null, monthsSinceChange: null, stance: 'UNKNOWN',
  };
  if (valued.length < 2) return base;

  const last = valued[valued.length - 1];
  const monthsAgo = (months: number): number | null => {
    const cutoff = new Date(last.date);
    cutoff.setMonth(cutoff.getMonth() - months);
    const iso = cutoff.toISOString().slice(0, 10);
    // Nearest observation at or before the cutoff — series here are daily or
    // monthly, so a fixed index offset would mean different spans per series.
    for (let i = valued.length - 1; i >= 0; i--) if (valued[i].date <= iso) return last.value - valued[i].value;
    return null;
  };

  /**
   * Walk back to the last move.
   *
   * Compared against a rolling reference rather than the previous observation:
   * a proxy rate drifts a basis point at a time around its target, so
   * consecutive differences never clear the threshold even across a real hike.
   * Anchoring on the last CONFIRMED level makes a 25bp step register whether it
   * arrives in one print or five.
   */
  let anchor = last.value;
  let lastChangeDate: string | null = null;
  let lastChangeDelta: number | null = null;
  for (let i = valued.length - 1; i >= 0; i--) {
    const delta = anchor - valued[i].value;
    if (Math.abs(delta) >= MOVE_THRESHOLD) {
      lastChangeDate = valued[i + 1]?.date ?? valued[i].date;
      lastChangeDelta = Number(delta.toFixed(2));
      break;
    }
  }

  let monthsSince: number | null = null;
  if (lastChangeDate) {
    const ms = Date.parse(last.date) - Date.parse(lastChangeDate);
    monthsSince = Math.max(0, Math.round(ms / (30.44 * 86_400_000)));
  }

  const stance: CentralBankRate['stance'] =
    lastChangeDelta === null ? 'UNKNOWN'
      : monthsSince !== null && monthsSince >= HOLD_MONTHS ? 'ON HOLD'
        : lastChangeDelta > 0 ? 'HIKING' : 'CUTTING';

  return {
    ...base,
    rate: last.value,
    asOf: last.date,
    change3m: monthsAgo(3),
    change12m: monthsAgo(12),
    lastChangeDate,
    lastChangeDelta,
    monthsSinceChange: monthsSince,
    stance,
  };
}

/** Fetch and summarise every configured central bank. Failures drop their row. */
export async function centralBanks(): Promise<CentralBankRate[]> {
  const rows = await Promise.all(CENTRAL_BANKS.map(async spec => {
    try {
      return centralBankStance(await fetchSeries(spec.seriesId), spec);
    } catch (e) {
      console.error(`[FRED] central bank ${spec.seriesId} failed`, e);
      return null;
    }
  }));
  return rows.filter((r): r is CentralBankRate => r !== null);
}
