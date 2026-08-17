/**
 * ETF Screener Service
 *
 * Surfaces ETFs that have genuinely outperformed the broad market (SPY) over
 * BOTH a 3-month and a 1-year window — requiring both windows separates
 * durable outperformance from a name that's merely having a hot quarter.
 * Among qualifying ETFs, a lower expense ratio scores higher ("cheapest").
 *
 * Universe: Yahoo has no ETF-oriented predefined screener list (unlike the
 * equity screeners, which reuse buildActiveMarketUniverse()), so this uses a
 * curated, static list of major liquid ETFs — broad market, sector SPDRs,
 * popular thematic/industry funds, international, bonds, and commodities.
 * Deliberately excludes leveraged/inverse funds (TQQQ, SQQQ, etc.) since
 * their "outperformance" vs. SPY is a function of leverage, not genuine
 * relative strength.
 */

import { getTimeSeriesYahoo, getQuoteSummary } from './yahoo.js';

const BENCHMARK = 'SPY';
const THREE_MONTH_TRADING_DAYS = 63;
const ONE_YEAR_TRADING_DAYS = 252;
const BATCH_SIZE = 5;

const ETF_UNIVERSE = [
  // Broad market
  'SPY', 'QQQ', 'IWM', 'DIA', 'VTI', 'VOO', 'VUG', 'VTV', 'MDY',
  // Sector SPDRs
  'XLF', 'XLK', 'XLV', 'XLE', 'XLY', 'XLI', 'XLP', 'XLU', 'XLB', 'XLRE', 'XLC',
  // Thematic / industry
  'SOXX', 'SMH', 'XBI', 'IBB', 'ARKK', 'ICLN', 'HACK', 'ROBO', 'SKYY', 'FDN',
  // International
  'EFA', 'EEM', 'VEA', 'VWO', 'EWZ', 'EWJ', 'FXI', 'KWEB',
  // Bonds
  'TLT', 'IEF', 'HYG', 'LQD', 'AGG',
  // Commodities
  'GLD', 'SLV', 'USO', 'DBC',
  // Real estate / retail / industry baskets
  'VNQ', 'XRT', 'XHB', 'JETS',
];

export interface EtfScreenerResult {
  symbol: string;
  price: number;
  return3mo: number | null;         // fraction, e.g. 0.08 = 8%
  return1yr: number | null;
  benchmarkReturn3mo: number | null; // SPY's own return, for display context
  benchmarkReturn1yr: number | null;
  outperformance3mo: number | null;  // return3mo - benchmarkReturn3mo
  outperformance1yr: number | null;
  expenseRatio: number | null;       // fraction, e.g. 0.0009 = 0.09%

  setupScore: number;                // 0–100 composite attractiveness
  reasons: string[];
}

/** Trailing return over `lookback` trading days, or null if not enough history. */
function computeReturn(closes: number[], lookback: number): number | null {
  if (closes.length <= lookback) return null;
  const past = closes[closes.length - 1 - lookback]!;
  const last = closes[closes.length - 1]!;
  if (past <= 0) return null;
  return (last - past) / past;
}

export async function runEtfScreener(): Promise<EtfScreenerResult[]> {
  console.log('[EtfScreener] Starting scan (curated ETF universe)...');

  // 1. Compute the SPY benchmark returns once, reused for every comparison.
  const spyBars = await getTimeSeriesYahoo(BENCHMARK, '1d', ONE_YEAR_TRADING_DAYS + 10);
  const spyCloses = spyBars.map((b: any) => b.close).filter((v: number) => v != null);
  const benchmarkReturn3mo = computeReturn(spyCloses, THREE_MONTH_TRADING_DAYS);
  const benchmarkReturn1yr = computeReturn(spyCloses, ONE_YEAR_TRADING_DAYS);

  if (benchmarkReturn3mo === null || benchmarkReturn1yr === null) {
    throw new Error('Could not compute SPY benchmark returns — aborting ETF scan.');
  }

  // 2. Fetch price history for every ETF in the universe and compute
  // outperformance vs. SPY over both windows.
  interface Scanned {
    symbol: string;
    price: number;
    return3mo: number;
    return1yr: number;
    outperformance3mo: number;
    outperformance1yr: number;
  }

  const scanned: Scanned[] = [];

  for (let i = 0; i < ETF_UNIVERSE.length; i += BATCH_SIZE) {
    const batch = ETF_UNIVERSE.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.allSettled(
      batch.map(async symbol => {
        if (symbol === BENCHMARK) return null; // comparing SPY to itself is meaningless

        const bars = await getTimeSeriesYahoo(symbol, '1d', ONE_YEAR_TRADING_DAYS + 10);
        const closes = bars.map((b: any) => b.close).filter((v: number) => v != null);
        const price = closes.length > 0 ? closes[closes.length - 1]! : 0;

        const return3mo = computeReturn(closes, THREE_MONTH_TRADING_DAYS);
        const return1yr = computeReturn(closes, ONE_YEAR_TRADING_DAYS);
        if (return3mo === null || return1yr === null || price <= 0) return null;

        // STRICT: must outperform SPY in BOTH windows — a hot quarter alone
        // (or a strong year that's since faded) doesn't qualify.
        const outperformance3mo = return3mo - benchmarkReturn3mo;
        const outperformance1yr = return1yr - benchmarkReturn1yr;
        if (outperformance3mo <= 0 || outperformance1yr <= 0) return null;

        return { symbol, price, return3mo, return1yr, outperformance3mo, outperformance1yr } satisfies Scanned;
      }),
    );

    for (const res of batchResults) {
      if (res.status === 'fulfilled' && res.value !== null) {
        scanned.push(res.value);
      } else if (res.status === 'rejected') {
        console.warn('[EtfScreener] Symbol failed:', res.reason);
      }
    }
  }

  console.log(`[EtfScreener] ${scanned.length} ETF(s) outperformed SPY in both windows.`);

  // 3. Only fetch expense ratio for the ETFs that already cleared the
  // outperformance bar — no point spending a quoteSummary call on names
  // that were already excluded.
  const results: EtfScreenerResult[] = [];

  for (let i = 0; i < scanned.length; i += BATCH_SIZE) {
    const batch = scanned.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.allSettled(
      batch.map(async s => {
        const summary = await getQuoteSummary(s.symbol, ['fundProfile']);
        const feesRaw = summary?.fundProfile?.feesExpensesInvestment?.annualReportExpenseRatio;
        const expenseRatio = typeof feesRaw === 'number' ? feesRaw : null;

        const reasons: string[] = [];
        let setupScore = 0;

        // ── Outperformance ─────────────────────────────────────────────
        if (s.outperformance1yr >= 0.15) {
          reasons.push(`+${(s.outperformance1yr * 100).toFixed(1)}pp vs SPY (1yr)`);
          setupScore += 30;
        } else if (s.outperformance1yr >= 0.05) {
          reasons.push(`+${(s.outperformance1yr * 100).toFixed(1)}pp vs SPY (1yr)`);
          setupScore += 18;
        } else {
          setupScore += 8;
        }

        if (s.outperformance3mo >= 0.08) {
          reasons.push(`+${(s.outperformance3mo * 100).toFixed(1)}pp vs SPY (3mo)`);
          setupScore += 25;
        } else if (s.outperformance3mo >= 0.02) {
          reasons.push(`+${(s.outperformance3mo * 100).toFixed(1)}pp vs SPY (3mo)`);
          setupScore += 14;
        } else {
          setupScore += 6;
        }

        // ── Cheapness ──────────────────────────────────────────────────
        if (expenseRatio !== null) {
          if (expenseRatio <= 0.001) {
            reasons.push(`${(expenseRatio * 100).toFixed(2)}% Expense Ratio (Cheap)`);
            setupScore += 20;
          } else if (expenseRatio <= 0.005) {
            setupScore += 10;
          } else if (expenseRatio > 0.01) {
            reasons.push(`${(expenseRatio * 100).toFixed(2)}% Expense Ratio (Pricey)`);
            setupScore -= 10;
          }
        }

        const finalScore = Math.max(0, Math.min(98, Math.round(setupScore)));

        return {
          symbol: s.symbol,
          price: s.price,
          return3mo: s.return3mo,
          return1yr: s.return1yr,
          benchmarkReturn3mo,
          benchmarkReturn1yr,
          outperformance3mo: s.outperformance3mo,
          outperformance1yr: s.outperformance1yr,
          expenseRatio,
          setupScore: finalScore,
          reasons,
        } satisfies EtfScreenerResult;
      }),
    );

    for (const res of batchResults) {
      if (res.status === 'fulfilled' && res.value !== null) {
        results.push(res.value);
      } else if (res.status === 'rejected') {
        console.warn('[EtfScreener] Symbol failed (expense ratio phase):', res.reason);
      }
    }
  }

  results.sort((a, b) => b.setupScore - a.setupScore);
  console.log(`[EtfScreener] Found ${results.length} outperforming ETF(s).`);
  return results;
}
