/**
 * Diagonal Spread Screener Service
 *
 * Surfaces "SPCX-style" setups: stocks with RSI exhaustion, a genuinely
 * liquid/tradeable option chain, and (preferably, not required) volatility
 * backwardation — conditions that favor a LEAP diagonal (or calendar) spread
 * where:
 *   - Short near-term call captures elevated near-IV when backwardation exists
 *   - Long deep-ITM LEAP benefits from delta, gamma, theta AND vega
 *
 * Calibrated against ~14 real trade writeups (SPCX, META, GOOGL, NFLX, BABA,
 * ADBE, AMZN, CRM, AAPL, MSFT, WMT, WFC, NKE, SHOP). Two early assumptions
 * from a smaller sample didn't hold up against the full set and were reverted:
 *   - Backwardation is NOT universal — only ~1/3 of trades mention it, and
 *     MSFT was explicitly entered during contango. It's a scoring bonus.
 *   - A recent sharp move is NOT required — ADBE (2.5yr decline), NKE (8mo),
 *     SHOP (6mo+), and BABA (extended grind) were all chronic decliners
 *     traded purely off an RSI threshold crossing.
 * What IS consistent across nearly every writeup: every name traded is a
 * large, liquid, well-known ticker, and wide/"sloshy" bid-ask spreads are
 * repeatedly cited as a reason to pass on or delay a trade. That's the real
 * gate on premium quality — not recency or backwardation.
 *
 * Universe: Dynamically pulled from Yahoo Finance screeners.
 */

import { yf, getOptionsChainYahoo, getTimeSeriesYahoo } from './yahoo.js';
import { buildActiveMarketUniverse } from './universeService.js';

// ── Tunable screening thresholds ──────────────────────────────────────────
const MAX_LEG_SPREAD_PCT = 0.35; // reject a leg if bid-ask spread exceeds 35% of the mid — a "sloshy" chain

export interface DiagonalScreenerResult {
  symbol: string;
  price: number;
  drawdownPct: number;       // % below 52-week high
  rsi14: number | null;
  isOversold: boolean;       // STRICT: RSI ≤ 35 or ≥15% 5-day drop
  selloffDepth5d: number;    // % change over last 5 trading days
  hasViableChain: boolean;   // ≥2 expirations, meaningful OI exists (> 500)
  expirations: string[];     // available option expirations
  isBackwardation: boolean;  // near-term IV > far-term IV
  nearTermIV: number | null; // average IV of nearest expiry
  farTermIV: number | null;  // average IV of 2nd/3rd expiry
  ivRatio: number | null;    // nearTermIV / farTermIV
  historicalVol1y: number | null; // 1-year Historical Volatility
  ivRankProxy: number | null;     // nearTermIV / historicalVol1y
  
  longLeg: { strike: number; expiry: string; delta: number; ask: number; dte: number } | null;
  shortLeg: { strike: number; expiry: string; iv: number; bid: number; dte: number } | null;
  netDebit: number | null;
  strikeWidth: number | null;
  debitWidthRatio: number | null; // netDebit / strikeWidth
  breakEven: number | null;  // estimated B/E as % of current price
  
  setupScore: number;         // 0–100 composite attractiveness
  reasons: string[];
}

/**
 * Compute RSI-14 from an array of closing prices (most-recent last).
 */
function computeRSI14(closes: number[]): number | null {
  if (closes.length < 15) return null;
  const recent = closes.slice(-15);
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < recent.length; i++) {
    const diff = recent[i]! - recent[i - 1]!;
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / 14;
  const avgLoss = losses / 14;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Number((100 - 100 / (1 + rs)).toFixed(1));
}

/**
 * Compute 1-Year Historical Volatility (Annualized standard deviation of daily returns)
 */
function computeHistoricalVolatility(closes: number[]): number | null {
  if (closes.length < 2) return null;
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const ret = Math.log(closes[i]! / closes[i - 1]!);
    if (isFinite(ret)) returns.push(ret);
  }
  if (returns.length === 0) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}

/**
 * Compute average implied volatility for contracts near the current price
 * on a given expiration date. Widen strike range to guarantee capture.
 */
function avgIVForExpiry(
  contracts: any[],
  expiry: string,
  currentPrice: number,
  strikeRangePct = 0.25, // Widened to 25% to prevent null IVs
): number | null {
  const relevant = contracts.filter(c => {
    const exp = c.details?.expiration_date;
    const strike = c.details?.strike_price;
    const iv = c.implied_volatility;
    if (exp !== expiry || !strike || !iv || iv <= 0) return false;
    return Math.abs(strike - currentPrice) / currentPrice <= strikeRangePct;
  });

  if (relevant.length === 0) return null;
  const sum = relevant.reduce((acc: number, c: any) => acc + (c.implied_volatility || 0), 0);
  return sum / relevant.length;
}

/** Farthest expiration >= 150 DTE, or the farthest available if none qualify. */
function pickFarExpiry(expirations: string[]): { targetExp: string; targetDte: number } {
  const now = new Date();
  let targetExp = expirations[expirations.length - 1]!;
  let targetDte = 0;

  for (const exp of expirations) {
    const dte = (new Date(exp).getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    if (dte >= 150) {
      targetExp = exp;
      targetDte = Math.round(dte);
      break;
    }
  }
  if (targetDte === 0) {
    targetDte = Math.round((new Date(targetExp).getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  }
  return { targetExp, targetDte };
}

/** Nearest expiration within 25-55 DTE, or the nearest available if none qualify. */
function pickNearExpiry(expirations: string[]): { targetExp: string; targetDte: number } {
  const now = new Date();
  let targetExp = expirations[0]!;
  let targetDte = 0;

  for (const exp of expirations) {
    const dte = (new Date(exp).getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    if (dte >= 25 && dte <= 55) {
      targetExp = exp;
      targetDte = Math.round(dte);
      break;
    }
  }
  if (targetDte === 0) {
    targetDte = Math.round((new Date(targetExp).getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  }
  return { targetExp, targetDte };
}

/**
 * True if a quoted market is too wide (or one-sided/missing) to be
 * realistically tradeable. Anderson's own trade writeups repeatedly cite
 * "sloshy"/"sloppy" bid-ask spreads as a reason to pass on or delay a trade
 * — this is the actual, consistent liquidity gate his methodology applies.
 */
function isSpreadTooWide(bid: number, ask: number): boolean {
  if (bid <= 0 || ask <= 0 || ask < bid) return true;
  const mid = (bid + ask) / 2;
  if (mid <= 0) return true;
  return (ask - bid) / mid > MAX_LEG_SPREAD_PCT;
}

/**
 * Find a deep-ITM LEAP-like contract for the long leg.
 * Target: > 150 DTE, Delta ~ 0.80.
 */
function suggestLongLeg(
  contracts: any[],
  expirations: string[],
  currentPrice: number,
): DiagonalScreenerResult['longLeg'] {
  if (expirations.length < 2) return null;

  const { targetExp, targetDte } = pickFarExpiry(expirations);

  // Delta 0.80 proxy -> Strike at roughly 80-85% of price
  const targetStrike = currentPrice * 0.80; 

  const calls = contracts.filter(c =>
    c.details?.expiration_date === targetExp &&
    c.details?.contract_type === 'call' &&
    c.details?.strike_price != null,
  );

  if (calls.length === 0) return null;

  calls.sort(
    (a: any, b: any) =>
      Math.abs(a.details.strike_price - targetStrike) -
      Math.abs(b.details.strike_price - targetStrike),
  );

  const best = calls[0];
  const strike = best.details.strike_price;
  
  // Estimate delta roughly
  const moneyness = currentPrice / strike;
  const estimatedDelta = Math.min(0.95, Math.max(0.50, 0.5 + (moneyness - 1) * 0.5));
  
  // Get Ask price for Long Leg debit
  const bid = best.last_quote?.bid || 0;
  const ask = best.last_quote?.ask || 0;

  // No real two-sided market (or too wide to fill reasonably) — not tradeable.
  if (isSpreadTooWide(bid, ask)) return null;
  const priceEst = ask;

  return {
    strike,
    expiry: targetExp,
    delta: Number(estimatedDelta.toFixed(2)),
    ask: Number(priceEst.toFixed(2)),
    dte: targetDte
  };
}

/**
 * Find an OTM short call on the near expiry.
 * Target: 30-45 DTE, Delta ~ 0.20
 */
function suggestShortLeg(
  contracts: any[],
  expirations: string[],
  currentPrice: number,
): DiagonalScreenerResult['shortLeg'] {
  if (expirations.length === 0) return null;

  const { targetExp, targetDte } = pickNearExpiry(expirations);

  // Delta 0.20 proxy -> Strike at roughly 10% OTM
  const targetStrike = currentPrice * 1.10;

  const calls = contracts.filter(c =>
    c.details?.expiration_date === targetExp &&
    c.details?.contract_type === 'call' &&
    c.details?.strike_price != null &&
    c.implied_volatility > 0,
  );

  if (calls.length === 0) return null;

  calls.sort(
    (a: any, b: any) =>
      Math.abs(a.details.strike_price - targetStrike) -
      Math.abs(b.details.strike_price - targetStrike),
  );

  const best = calls[0];
  const strike = best.details.strike_price;
  
  const bid = best.last_quote?.bid || 0;
  const ask = best.last_quote?.ask || 0;

  // No real two-sided market (or too wide to fill reasonably) — not tradeable.
  if (isSpreadTooWide(bid, ask)) return null;

  return {
    strike,
    expiry: targetExp,
    iv: Number(((best.implied_volatility || 0) * 100).toFixed(1)),
    bid: Number(bid.toFixed(2)),
    dte: targetDte
  };
}

export async function runDiagonalScreener(): Promise<DiagonalScreenerResult[]> {
  console.log('[DiagonalScreener] Starting scan (dynamic universe)...');

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
    console.error('[DiagonalScreener] Quote fetch error:', err);
    throw new Error('Failed to fetch quotes for diagonal screener universe.');
  }

  // 3. Pre-filter and rank candidates to reduce options chain API calls
  interface PreRankedCandidate {
    symbol: string;
    price: number;
    drawdownPct: number;
    selloffScore: number;
    consensus: number;
  }

  const preFiltered: PreRankedCandidate[] = [];

  for (const q of rawQuotes) {
    const symbol = q['symbol'] as string | undefined;
    const price = (q['regularMarketPrice'] as number) ?? 0;
    const volume = (q['regularMarketVolume'] as number) ?? 0;
    const fiftyTwoWeekHigh = (q['fiftyTwoWeekHigh'] as number) ?? price;
    const changePercent = (q['regularMarketChangePercent'] as number) ?? 0;
    
    // Price floor raised from $15 to $25 — every real trade example (SPCX,
    // META, GOOGL, NFLX, BABA, ADBE, AMZN, CRM, AAPL, MSFT, WMT, WFC, NKE,
    // SHOP) is a large, liquid, well-known name; NKE (~$40) is the cheapest.
    // A low floor mainly let thin penny/microcap noise into the universe.
    if (!symbol || price < 25 || volume < 200_000) continue;

    const drawdownPct = fiftyTwoWeekHigh > 0
      ? Number(((1 - price / fiftyTwoWeekHigh) * 100).toFixed(1))
      : 0;

    const consensus = yahooConsensusMap.get(symbol) ?? 0;
    const dropToday = changePercent < 0 ? Math.abs(changePercent) : 0;
    // Chronic, multi-month decliners (ADBE, NKE, SHOP, BABA in Anderson's own
    // trades) are legitimate candidates, not noise — so drawdown is NOT
    // capped here. The RSI/liquidity gates below are what actually determine
    // tradeability, not how long a name has been declining.
    const selloffScore = (dropToday * 2) + drawdownPct + (consensus * 0.5);

    if (selloffScore > 5) {
      preFiltered.push({ symbol, price, drawdownPct, selloffScore, consensus });
    }
  }

  preFiltered.sort((a, b) => b.selloffScore - a.selloffScore);
  const topCandidates = preFiltered.slice(0, 40);
  console.log(`[DiagonalScreener] Phase 1: Pre-filtered to ${topCandidates.length} candidates for deep scan.`);

  const results: DiagonalScreenerResult[] = [];
  const funnel = { oversold: 0, viableChain: 0, bothLegs: 0 };

  // 4. Process deep scan in batches of 4
  const BATCH_SIZE = 4;
  for (let i = 0; i < topCandidates.length; i += BATCH_SIZE) {
    const batch = topCandidates.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.allSettled(
      batch.map(async c => {
        // ── Historical prices for RSI, 5-day selloff, and HV ─────────────
        let rsi14: number | null = null;
        let selloffDepth5d = 0;
        let historicalVol1y: number | null = null;

        try {
          const bars = await getTimeSeriesYahoo(c.symbol, '1d', 252);
          const closes = bars.map((b: any) => b.close).filter((v: number) => v != null);
          
          historicalVol1y = computeHistoricalVolatility(closes);
          rsi14 = computeRSI14(closes);
          
          if (closes.length >= 6) {
            const prev5 = closes[closes.length - 6]!;
            const curr = closes[closes.length - 1]!;
            selloffDepth5d = Number(((curr - prev5) / prev5 * 100).toFixed(1));
          }
        } catch {
          // proceed without
        }

        // STRICT Filter: RSI <= 35 OR 5-day drop >= 15%. No recency requirement
        // beyond RSI itself — real trade examples include chronic multi-month
        // decliners (ADBE, NKE, SHOP, BABA) entered purely off an RSI threshold
        // crossing, with no sharp recent move.
        const isOversold = (rsi14 !== null && rsi14 <= 35) || selloffDepth5d <= -15;
        if (!isOversold) return null;
        funnel.oversold++;

        // ── Options chain ─────────────────────────────────────────────────
        // Yahoo's options() only returns contracts for ONE expiration per call
        // — the nearest by default, or whichever `date` is passed. The prior
        // version called getOptionsChainYahoo(symbol) exactly once with no
        // date, so `contracts` only ever held the front-week expiry while
        // `expirations` (a separate metadata field) listed every future date.
        // suggestLongLeg targets >=150 DTE and suggestShortLeg targets 25-55
        // DTE — neither is normally the front week, so both always filtered
        // to zero matches and returned null for every candidate, every time.
        // Fetching the two specific expirations the legs actually need and
        // merging their contracts is what makes a leg findable at all.
        let expirations: string[] = [];
        let contracts: any[] = [];
        let hasViableChain = false;
        let nearTermIV: number | null = null;
        let farTermIV: number | null = null;
        let ivRatio: number | null = null;
        let isBackwardation = false;

        try {
          const meta = await getOptionsChainYahoo(c.symbol);
          expirations = meta.expirations;

          hasViableChain = expirations.length >= 2;

          if (hasViableChain) {
            const near = pickNearExpiry(expirations);
            const far = pickFarExpiry(expirations);

            const [nearChain, farChain] = await Promise.all([
              getOptionsChainYahoo(c.symbol, near.targetExp),
              far.targetExp === near.targetExp
                ? Promise.resolve(null)
                : getOptionsChainYahoo(c.symbol, far.targetExp),
            ]);
            contracts = farChain ? [...nearChain.contracts, ...farChain.contracts] : nearChain.contracts;

            // STRICT Liquidity: total call OI > 1000 across the fetched expirations.
            // Raised from 500 — real trade examples are all large, liquid names, and
            // a low OI bar mainly let thin, wide-spread microcap chains through.
            const totalCallOI = contracts
              .filter(contract => contract.details?.contract_type === 'call')
              .reduce((sum, contract) => sum + (contract.day?.open_interest || 0), 0);
            hasViableChain = totalCallOI > 1000;

            if (hasViableChain) {
              nearTermIV = avgIVForExpiry(contracts, near.targetExp, c.price);
              farTermIV = avgIVForExpiry(contracts, far.targetExp, c.price);

              if (nearTermIV !== null && farTermIV !== null && farTermIV > 0) {
                ivRatio = Number((nearTermIV / farTermIV).toFixed(2));
                isBackwardation = nearTermIV > farTermIV * 1.05; // >5%
              }
              // Backwardation is scored (see setupScore below), not required —
              // only ~1/3 of real trade examples explicitly had it, and MSFT was
              // entered during contango. Requiring it excluded most real setups.
            }
          }
        } catch {
          hasViableChain = false;
        }

        if (!hasViableChain) return null;
        funnel.viableChain++;

        // ── Suggest spread legs & calculate metrics ───────────────────────
        // Each leg-finder now rejects contracts with no real two-sided market
        // or a spread too wide to fill (see isSpreadTooWide) — so a null leg
        // here means the chain wasn't actually tradeable, not just unpriced.
        const longLeg = suggestLongLeg(contracts, expirations, c.price);
        const shortLeg = suggestShortLeg(contracts, expirations, c.price);
        if (!longLeg || !shortLeg) return null;
        funnel.bothLegs++;

        let netDebit: number | null = null;
        let strikeWidth: number | null = null;
        let debitWidthRatio: number | null = null;
        let breakEven: number | null = null;

        netDebit = longLeg.ask - shortLeg.bid;
        strikeWidth = shortLeg.strike - longLeg.strike;

        if (strikeWidth > 0 && netDebit > 0) {
          debitWidthRatio = Number((netDebit / strikeWidth).toFixed(2));

          // Estimated B/E: Long Strike + Net Debit Paid
          const bePrice = longLeg.strike + netDebit;
          breakEven = Number(((bePrice / c.price) * 100).toFixed(1));
        }

        // IVR Proxy (Current Near IV / 1Y HV)
        let ivRankProxy: number | null = null;
        if (nearTermIV !== null && historicalVol1y !== null && historicalVol1y > 0) {
          ivRankProxy = Number((nearTermIV / historicalVol1y).toFixed(2));
        }

        // ── Scoring ───────────────────────────────────────────────────────
        const reasons: string[] = [];
        let setupScore = 0;

        if (rsi14 !== null && rsi14 <= 35) {
          reasons.push(`RSI ${rsi14} (Oversold)`);
          setupScore += 20;
        }
        if (selloffDepth5d <= -15) {
          reasons.push(`${selloffDepth5d.toFixed(1)}% 5d drop`);
          setupScore += 20;
        }

        if (isBackwardation && ivRatio !== null) {
          reasons.push(`Vol backwardation (IV ${((nearTermIV || 0) * 100).toFixed(0)}%)`);
          setupScore += 20;
        }

        // IV Rank Proxy target 1.0 - 1.5
        if (ivRankProxy !== null) {
          if (ivRankProxy >= 1.0 && ivRankProxy <= 1.5) {
            reasons.push(`IV Proxy ${ivRankProxy}x (Target Zone)`);
            setupScore += 15;
          } else if (ivRankProxy > 1.5) {
            reasons.push(`IV Proxy ${ivRankProxy}x (Elevated Vega Crush Risk)`);
            setupScore -= 10;
          }
        }

        if (debitWidthRatio !== null) {
          if (debitWidthRatio <= 0.8) {
            reasons.push(`Debit/Width ${debitWidthRatio} (Capital Efficient)`);
            setupScore += 15;
          } else if (debitWidthRatio >= 1.0) {
            reasons.push(`Debit/Width ${debitWidthRatio} (Guaranteed Loss Risk)`);
            setupScore -= 30; // Severe penalty for structural flaw
          }
        }

        if (longLeg && longLeg.delta >= 0.75) {
          reasons.push(`Long Δ ${longLeg.delta}`);
          setupScore += 10;
        }

        const finalScore = Math.max(0, Math.min(98, Math.round(setupScore)));

        return {
          symbol: c.symbol,
          price: c.price,
          drawdownPct: c.drawdownPct,
          rsi14,
          isOversold,
          selloffDepth5d,
          hasViableChain,
          expirations: expirations.slice(0, 6),
          isBackwardation,
          nearTermIV,
          farTermIV,
          ivRatio,
          historicalVol1y,
          ivRankProxy,
          longLeg,
          shortLeg,
          netDebit,
          strikeWidth,
          debitWidthRatio,
          breakEven,
          setupScore: finalScore,
          reasons,
        } satisfies DiagonalScreenerResult;
      }),
    );

    for (const res of batchResults) {
      if (res.status === 'fulfilled' && res.value !== null) {
        results.push(res.value);
      } else if (res.status === 'rejected') {
        console.warn('[DiagonalScreener] Symbol failed:', res.reason);
      }
    }
  }

  results.sort((a, b) => b.setupScore - a.setupScore);
  console.log(`[DiagonalScreener] Funnel: ${topCandidates.length} candidates -> ${funnel.oversold} oversold -> ${funnel.viableChain} viable chain -> ${funnel.bothLegs} both legs.`);
  console.log(`[DiagonalScreener] Found ${results.length} setups.`);
  return results;
}
