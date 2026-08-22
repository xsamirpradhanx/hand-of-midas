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
  fs.mkdirSync(FRED_CACHE_DIR, { recursive: true });
  fs.writeFileSync(cacheFile(id), JSON.stringify(series));
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
