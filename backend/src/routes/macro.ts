/**
 * Macro dashboard data: policy and market rates, the curve, and the dollar.
 *
 * DELIBERATELY INFORMATIONAL. Rates were measured against 13,679 replayed trade
 * outcomes across four decades and showed no stable relationship — positive in
 * two decades, negative in two, and exactly zero on the full sample. So none of
 * this feeds a directional decision. It is context for a human reading a plan,
 * which is a real use that needs no edge claim, and it is the display half of
 * the same data the prediction rows are now stamped with so the question can be
 * revisited on live outcomes later.
 */
import { getCachedData, setCachedData } from '../services/cache.js';
import { FRED_SERIES, fetchSeries, snapshot, type FredSnapshot } from '../services/marketData/fred.js';
import { yf } from '../services/yahoo.js';
import { withCoalescing } from '../utils/inflight.js';
import type { APIGatewayProxyResultV2 } from '../types.js';
import { jsonResponse } from '../index.js';

const CACHE_KEY = 'CACHE#MACRO_DASHBOARD_V1';
/**
 * Six hours. Treasury constant-maturity yields publish once daily around 16:15
 * ET, so a shorter TTL would re-fetch the same numbers; FX is refreshed on the
 * same cycle because the panel is read together.
 */
const TTL_SECONDS = 6 * 60 * 60;

/** FX pairs, quoted the way a dollar-based reader expects to see them. */
const FX = [
  { symbol: 'DX-Y.NYB', label: 'US Dollar Index' },
  { symbol: 'EURUSD=X', label: 'EUR / USD' },
  { symbol: 'USDJPY=X', label: 'USD / JPY' },
  { symbol: 'GBPUSD=X', label: 'GBP / USD' },
  { symbol: 'AUDUSD=X', label: 'AUD / USD' },
  { symbol: 'USDCAD=X', label: 'USD / CAD' },
  { symbol: 'USDCHF=X', label: 'USD / CHF' },
  { symbol: 'USDINR=X', label: 'USD / INR' },
];

export interface FxQuote {
  symbol: string;
  label: string;
  price: number | null;
  changePct: number | null;
}

export interface MacroPayload {
  rates: FredSnapshot[];
  curve: FredSnapshot[];
  inflation: FredSnapshot[];
  fx: FxQuote[];
  /** Plain-language read of the curve, the one derived statement here. */
  curveStatus: string;
  fetchedAt: string;
  /** Stated on the payload so no consumer mistakes this for a signal. */
  note: string;
}

const RATE_IDS = ['DFF', 'DGS3MO', 'DGS2', 'DGS10'] as const;
const CURVE_IDS = ['T10Y2Y', 'T10Y3M'] as const;
const INFLATION_IDS = ['DFII10', 'T10YIE'] as const;

async function build(): Promise<MacroPayload> {
  const load = async (id: string): Promise<FredSnapshot | null> => {
    try {
      const s = await fetchSeries(id);
      return snapshot(s, (FRED_SERIES as Record<string, string>)[id] ?? id);
    } catch (e) {
      console.error(`[Macro] FRED ${id} failed`, e);
      return null;
    }
  };

  const [rates, curve, inflation, fxQuotes] = await Promise.all([
    Promise.all(RATE_IDS.map(load)),
    Promise.all(CURVE_IDS.map(load)),
    Promise.all(INFLATION_IDS.map(load)),
    Promise.all(FX.map(async (f): Promise<FxQuote> => {
      try {
        const q: any = await yf.quote(f.symbol);
        return {
          symbol: f.symbol, label: f.label,
          price: q?.regularMarketPrice ?? null,
          changePct: q?.regularMarketChangePercent ?? null,
        };
      } catch {
        // One unavailable pair must not empty the panel.
        return { symbol: f.symbol, label: f.label, price: null, changePct: null };
      }
    })),
  ]);

  const present = <T,>(xs: (T | null)[]): T[] => xs.filter((x): x is T => x !== null);
  const t10y2y = present(curve).find(c => c.id === 'T10Y2Y');
  const curveStatus = t10y2y?.value == null
    ? 'Term spread unavailable.'
    : t10y2y.value < 0
      ? `Inverted: the 10-year yields ${Math.abs(t10y2y.value).toFixed(2)}pp LESS than the 2-year.`
      : `Upward sloping: the 10-year yields ${t10y2y.value.toFixed(2)}pp more than the 2-year.`;

  return {
    rates: present(rates),
    curve: present(curve),
    inflation: present(inflation),
    fx: fxQuotes,
    curveStatus,
    fetchedAt: new Date().toISOString(),
    note: 'Context only. Rate conditioning was measured against 13,679 replayed trades across four decades and showed no stable relationship to outcomes, so none of this feeds a directional signal.',
  };
}

export async function getMacro(): Promise<APIGatewayProxyResultV2> {
  const cached = await getCachedData<MacroPayload>(CACHE_KEY);
  if (cached) return jsonResponse(200, cached);
  try {
    const payload = await withCoalescing(CACHE_KEY, build);
    await setCachedData(CACHE_KEY, payload, TTL_SECONDS);
    return jsonResponse(200, payload);
  } catch (e: any) {
    console.error('[Macro] build failed', e);
    return jsonResponse(502, { error: 'Macro data unavailable', detail: e?.message });
  }
}
