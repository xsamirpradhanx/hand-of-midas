/**
 * Growth Screener Service
 *
 * GARP (growth at a reasonable price): strong revenue/earnings growth AND a
 * PEG ratio that isn't stretched. Pure growth-rate screens tend to surface
 * names already priced for perfection — the PEG gate is what keeps this from
 * just being "buy whatever grew fastest."
 *
 * Universe: same dynamic Yahoo screener universe as the other screeners
 * (buildActiveMarketUniverse), which already pulls growth-oriented
 * predefined lists (growth_technology_stocks, aggressive_small_caps,
 * small_cap_gainers).
 */

import { yf, getQuoteSummary, reconcileMarketCap } from './yahoo.js';
import { buildActiveMarketUniverse } from './universeService.js';

const MIN_PRICE = 10;
const MIN_VOLUME = 200_000;
const PHASE1_TOP_N = 50;
const BATCH_SIZE = 4;

export interface GrowthScreenerResult {
  symbol: string;
  price: number;
  marketCap: number | null;
  forwardPE: number | null;
  pegRatio: number | null;
  revenueGrowth: number | null;   // fraction, e.g. 0.25 = 25%
  earningsGrowth: number | null;  // fraction

  setupScore: number;             // 0–100 composite attractiveness
  reasons: string[];
}

export async function runGrowthScreener(): Promise<GrowthScreenerResult[]> {
  console.log('[GrowthScreener] Starting scan (dynamic universe)...');

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

  // 2. Fetch batch quotes
  let rawQuotes: Record<string, unknown>[] = [];
  try {
    const batch = await yf.quote(symbols);
    rawQuotes = Array.isArray(batch) ? batch : [batch];
  } catch (err) {
    console.error('[GrowthScreener] Quote fetch error:', err);
    throw new Error('Failed to fetch quotes for growth screener universe.');
  }

  // 3. Pre-filter and rank to bound Phase 2 quoteSummary calls. Growth/PEG
  // fields only live in quoteSummary, not the batch quote, so Phase 1 ranks
  // on what IS free: Yahoo consensus (how many growth-oriented lists
  // nominated it) plus today's move as a cheap momentum proxy.
  interface PreRankedCandidate {
    symbol: string;
    price: number;
    marketCap: number | null;
    forwardPE: number | null;
    preScore: number;
  }

  const preFiltered: PreRankedCandidate[] = [];

  for (const q of rawQuotes) {
    const symbol = q['symbol'] as string | undefined;
    const price = (q['regularMarketPrice'] as number) ?? 0;
    const volume = (q['regularMarketVolume'] as number) ?? 0;
    const marketCap = (q['marketCap'] as number) ?? null;
    const forwardPE = (q['forwardPE'] as number) ?? null;
    const changePercent = (q['regularMarketChangePercent'] as number) ?? 0;

    if (!symbol || price < MIN_PRICE || volume < MIN_VOLUME) continue;

    const consensus = yahooConsensusMap.get(symbol) ?? 0;
    const preScore = consensus + Math.max(0, changePercent);

    preFiltered.push({ symbol, price, marketCap, forwardPE, preScore });
  }

  preFiltered.sort((a, b) => b.preScore - a.preScore);
  const topCandidates = preFiltered.slice(0, PHASE1_TOP_N);
  console.log(`[GrowthScreener] Phase 1: Pre-filtered to ${topCandidates.length} candidates for deep scan.`);

  const results: GrowthScreenerResult[] = [];

  // 4. Deep scan
  for (let i = 0; i < topCandidates.length; i += BATCH_SIZE) {
    const batch = topCandidates.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.allSettled(
      batch.map(async c => {
        const summary = await getQuoteSummary(c.symbol, ['financialData', 'defaultKeyStatistics']);
        if (!summary) return null;

        const fin = summary.financialData || {};
        const stats = summary.defaultKeyStatistics || {};

        const revenueGrowth = typeof fin.revenueGrowth === 'number' ? fin.revenueGrowth : null;
        const earningsGrowth = typeof fin.earningsGrowth === 'number' ? fin.earningsGrowth : null;
        const pegRatio = typeof stats.pegRatio === 'number' ? stats.pegRatio : null;
        const forwardPE = c.forwardPE ?? (typeof stats.forwardPE === 'number' ? stats.forwardPE : null);
        const sharesOutstanding = typeof stats.sharesOutstanding === 'number' ? stats.sharesOutstanding : null;
        const marketCap = reconcileMarketCap(c.marketCap, c.price, sharesOutstanding);

        // STRICT: GARP needs both legs present. No growth, or no PEG to
        // evaluate "reasonable price" against, and this isn't a GARP setup.
        if (revenueGrowth === null || revenueGrowth <= 0) return null;
        if (pegRatio === null || pegRatio <= 0) return null;

        const reasons: string[] = [];
        let setupScore = 0;

        // ── Growth leg ─────────────────────────────────────────────────
        if (revenueGrowth >= 0.25) {
          reasons.push(`Revenue Growth ${(revenueGrowth * 100).toFixed(0)}%`);
          setupScore += 25;
        } else if (revenueGrowth >= 0.12) {
          reasons.push(`Revenue Growth ${(revenueGrowth * 100).toFixed(0)}%`);
          setupScore += 12;
        }
        if (earningsGrowth !== null && earningsGrowth >= 0.20) {
          reasons.push(`Earnings Growth ${(earningsGrowth * 100).toFixed(0)}%`);
          setupScore += 20;
        } else if (earningsGrowth !== null && earningsGrowth > 0) {
          setupScore += 8;
        }

        // ── Reasonable-price leg (PEG target zone) ───────────────────────
        if (pegRatio <= 1.0) {
          reasons.push(`PEG ${pegRatio.toFixed(2)} (Undervalued for Growth)`);
          setupScore += 30;
        } else if (pegRatio <= 1.5) {
          reasons.push(`PEG ${pegRatio.toFixed(2)} (Reasonable)`);
          setupScore += 18;
        } else if (pegRatio <= 2.0) {
          setupScore += 5;
        } else {
          reasons.push(`PEG ${pegRatio.toFixed(2)} (Stretched)`);
          setupScore -= 15;
        }

        const finalScore = Math.max(0, Math.min(98, Math.round(setupScore)));

        return {
          symbol: c.symbol,
          price: c.price,
          marketCap,
          forwardPE,
          pegRatio,
          revenueGrowth,
          earningsGrowth,
          setupScore: finalScore,
          reasons,
        } satisfies GrowthScreenerResult;
      }),
    );

    for (const res of batchResults) {
      if (res.status === 'fulfilled' && res.value !== null) {
        results.push(res.value);
      } else if (res.status === 'rejected') {
        console.warn('[GrowthScreener] Symbol failed:', res.reason);
      }
    }
  }

  results.sort((a, b) => b.setupScore - a.setupScore);
  console.log(`[GrowthScreener] Found ${results.length} setups.`);
  return results;
}
