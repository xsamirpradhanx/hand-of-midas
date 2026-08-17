/**
 * Value Screener Service
 *
 * Quality-value blend: cheap on valuation multiples (P/E, P/B, P/S, FCF
 * yield) AND fundamentally healthy (ROE, margins, leverage). The quality leg
 * exists specifically to screen out "cheap for a reason" value traps that a
 * pure low-multiple screen would surface — a stock with negative ROE and
 * heavy leverage isn't a value play, it's a stock that's cheap because
 * something is actually wrong.
 *
 * Universe: same dynamic Yahoo screener universe as the other screeners
 * (buildActiveMarketUniverse), which already pulls several value-oriented
 * predefined lists (undervalued_large_caps, undervalued_growth_stocks,
 * undervalued_wide_moat_stocks, morningstar_five_star_stocks).
 */

import { yf, getQuoteSummary, reconcileMarketCap } from './yahoo.js';
import { buildActiveMarketUniverse } from './universeService.js';

const MIN_PRICE = 10;
const MIN_VOLUME = 200_000;
const PHASE1_TOP_N = 40;
const BATCH_SIZE = 4;

export interface ValueScreenerResult {
  symbol: string;
  price: number;
  marketCap: number | null;
  trailingPE: number | null;
  priceToBook: number | null;
  priceToSales: number | null;
  returnOnEquity: number | null;  // fraction, e.g. 0.18 = 18%
  profitMargin: number | null;
  operatingMargin: number | null;
  debtToEquity: number | null;
  freeCashflow: number | null;
  fcfYield: number | null;        // freeCashflow / marketCap
  revenueGrowth: number | null;

  setupScore: number;             // 0–100 composite attractiveness
  reasons: string[];
}

export async function runValueScreener(): Promise<ValueScreenerResult[]> {
  console.log('[ValueScreener] Starting scan (dynamic universe)...');

  // 1. Build dynamic universe
  const universeCandidates = await buildActiveMarketUniverse();
  if (universeCandidates.length === 0) {
    throw new Error('Could not determine dynamic universe from market data.');
  }

  const yahooConsensusMap = new Map<string, number>();
  for (const uc of universeCandidates) {
    yahooConsensusMap.set(uc.symbol, uc.yahooConsensus);
  }
  const symbols = universeCandidates.map(uc => uc.symbol);

  // 2. Fetch batch quotes — trailingPE/priceToBook/marketCap come free on the
  // batch quote payload, no extra request needed.
  let rawQuotes: Record<string, unknown>[] = [];
  try {
    const batch = await yf.quote(symbols);
    rawQuotes = Array.isArray(batch) ? batch : [batch];
  } catch (err) {
    console.error('[ValueScreener] Quote fetch error:', err);
    throw new Error('Failed to fetch quotes for value screener universe.');
  }

  // 3. Pre-filter and rank on cheap (no extra API call) valuation proxies to
  // bound how many quoteSummary calls Phase 2 has to make.
  interface PreRankedCandidate {
    symbol: string;
    price: number;
    marketCap: number | null;
    trailingPE: number | null;
    priceToBook: number | null;
    priceToSales: number | null;
    preScore: number;
  }

  const preFiltered: PreRankedCandidate[] = [];

  for (const q of rawQuotes) {
    const symbol = q['symbol'] as string | undefined;
    const price = (q['regularMarketPrice'] as number) ?? 0;
    const volume = (q['regularMarketVolume'] as number) ?? 0;
    const marketCap = (q['marketCap'] as number) ?? null;
    const trailingPE = (q['trailingPE'] as number) ?? null;
    const priceToBook = (q['priceToBook'] as number) ?? null;
    const priceToSales = (q['priceToSalesTrailing12Months'] as number) ?? null;

    if (!symbol || price < MIN_PRICE || volume < MIN_VOLUME) continue;
    // Must be profitable to even be a valuation-screen candidate — an
    // unprofitable "cheap" stock isn't a value play, it's a speculation.
    if (trailingPE === null || trailingPE <= 0) continue;

    const consensus = yahooConsensusMap.get(symbol) ?? 0;

    let preScore = consensus * 0.5;
    preScore += Math.max(0, 40 - trailingPE); // richer bonus the lower P/E is, tapers past P/E 40
    if (priceToBook !== null && priceToBook > 0) preScore += Math.max(0, 10 - priceToBook) * 2;

    preFiltered.push({ symbol, price, marketCap, trailingPE, priceToBook, priceToSales, preScore });
  }

  preFiltered.sort((a, b) => b.preScore - a.preScore);
  const topCandidates = preFiltered.slice(0, PHASE1_TOP_N);
  console.log(`[ValueScreener] Phase 1: Pre-filtered to ${topCandidates.length} candidates for deep scan.`);

  const results: ValueScreenerResult[] = [];

  // 4. Deep scan: fetch fundamentals in small batches so one bad symbol
  // never aborts the run (Promise.allSettled), mirroring the diagonal
  // screener's batching pattern.
  for (let i = 0; i < topCandidates.length; i += BATCH_SIZE) {
    const batch = topCandidates.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.allSettled(
      batch.map(async c => {
        const summary = await getQuoteSummary(c.symbol, ['financialData', 'summaryDetail', 'defaultKeyStatistics']);
        if (!summary) return null;

        const fin = summary.financialData || {};
        const det = summary.summaryDetail || {};
        const stats = summary.defaultKeyStatistics || {};

        const returnOnEquity = typeof fin.returnOnEquity === 'number' ? fin.returnOnEquity : null;
        const profitMargin = typeof fin.profitMargins === 'number' ? fin.profitMargins : null;
        const operatingMargin = typeof fin.operatingMargins === 'number' ? fin.operatingMargins : null;
        const debtToEquity = typeof fin.debtToEquity === 'number' ? fin.debtToEquity : null;
        const freeCashflow = typeof fin.freeCashflow === 'number' ? fin.freeCashflow : null;
        const revenueGrowth = typeof fin.revenueGrowth === 'number' ? fin.revenueGrowth : null;
        const priceToSales = c.priceToSales ??
          (typeof det.priceToSalesTrailing12Months === 'number' ? det.priceToSalesTrailing12Months : null);

        const sharesOutstanding = typeof stats.sharesOutstanding === 'number' ? stats.sharesOutstanding : null;
        const marketCap = reconcileMarketCap(c.marketCap, c.price, sharesOutstanding);

        let fcfYield = freeCashflow !== null && marketCap && marketCap > 0
          ? Number((freeCashflow / marketCap).toFixed(4))
          : null;
        // Sanity guard: no going-concern sustains FCF/market-cap above ~50%.
        // Observed live on foreign ADRs (e.g. PBR/PBR-A) where Yahoo's
        // freeCashflow comes back in the filing's local currency (BRL) while
        // marketCap is USD — treat an implausible ratio as unreliable rather
        // than reward a currency-mismatch with a false "cheap" score.
        if (fcfYield !== null && fcfYield > 0.5) fcfYield = null;

        // STRICT: value-trap guard. Missing/negative FCF disqualifies outright
        // (FCF yield is half the valuation leg) — and cheap + negative ROE +
        // heavy leverage together means "cheap for a real reason," not value.
        if (freeCashflow === null || freeCashflow <= 0) return null;
        if (returnOnEquity !== null && returnOnEquity < 0 && debtToEquity !== null && debtToEquity > 150) return null;

        const reasons: string[] = [];
        let setupScore = 0;

        // ── Valuation leg ──────────────────────────────────────────────
        if (c.trailingPE !== null && c.trailingPE <= 15) {
          reasons.push(`P/E ${c.trailingPE.toFixed(1)} (Cheap)`);
          setupScore += 20;
        } else if (c.trailingPE !== null && c.trailingPE <= 22) {
          setupScore += 8;
        }
        if (c.priceToBook !== null && c.priceToBook > 0 && c.priceToBook <= 2) {
          reasons.push(`P/B ${c.priceToBook.toFixed(1)}`);
          setupScore += 10;
        }
        if (priceToSales !== null && priceToSales > 0 && priceToSales <= 2) {
          reasons.push(`P/S ${priceToSales.toFixed(1)}`);
          setupScore += 10;
        }
        if (fcfYield !== null && fcfYield >= 0.05) {
          reasons.push(`FCF Yield ${(fcfYield * 100).toFixed(1)}%`);
          setupScore += 15;
        }

        // ── Quality leg ────────────────────────────────────────────────
        if (returnOnEquity !== null && returnOnEquity >= 0.15) {
          reasons.push(`ROE ${(returnOnEquity * 100).toFixed(0)}%`);
          setupScore += 15;
        }
        if (profitMargin !== null && profitMargin >= 0.10) {
          reasons.push(`Profit Margin ${(profitMargin * 100).toFixed(0)}%`);
          setupScore += 10;
        }
        if (debtToEquity !== null) {
          if (debtToEquity <= 100) {
            setupScore += 10;
          } else if (debtToEquity > 200) {
            reasons.push(`D/E ${debtToEquity.toFixed(0)} (Leveraged)`);
            setupScore -= 10;
          }
        }
        if (revenueGrowth !== null && revenueGrowth > 0) {
          setupScore += 5;
        }

        const finalScore = Math.max(0, Math.min(98, Math.round(setupScore)));

        return {
          symbol: c.symbol,
          price: c.price,
          marketCap,
          trailingPE: c.trailingPE,
          priceToBook: c.priceToBook,
          priceToSales,
          returnOnEquity,
          profitMargin,
          operatingMargin,
          debtToEquity,
          freeCashflow,
          fcfYield,
          revenueGrowth,
          setupScore: finalScore,
          reasons,
        } satisfies ValueScreenerResult;
      }),
    );

    for (const res of batchResults) {
      if (res.status === 'fulfilled' && res.value !== null) {
        results.push(res.value);
      } else if (res.status === 'rejected') {
        console.warn('[ValueScreener] Symbol failed:', res.reason);
      }
    }
  }

  results.sort((a, b) => b.setupScore - a.setupScore);
  console.log(`[ValueScreener] Found ${results.length} setups.`);
  return results;
}
