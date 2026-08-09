/**
 * Diagonal Spread Screener Service
 *
 * Surfaces "SPCX-style" setups: stocks with RSI exhaustion (oversold), a viable
 * option chain, and volatility backwardation — conditions that favor a LEAP
 * diagonal (or calendar) spread where:
 *   - Short near-term call captures elevated near-IV (backwardation premium)
 *   - Long deep-ITM LEAP benefits from delta, gamma, theta AND vega
 *
 * Universe: stocks with a recent ≥20% drawdown from 52w-high OR listed recent
 * IPOs (approximated by names that have traded < 12 months based on Yahoo data).
 */

import { yf, getOptionsChainYahoo, getTimeSeriesYahoo } from './yahoo.js';

// ── Universe ─────────────────────────────────────────────────────────────────
// Beaten-down names with viable options chains — curated list of recent
// high-profile selloffs, IPOs, and dislocated growth names.
const DIAGONAL_UNIVERSE = [
  // Recent IPOs & SPACs that sold off
  'SPCX', 'RDDT', 'ASTERA', 'ASTS', 'ACMR', 'AIOT', 'CWAN',
  // Deep drawdowns from ATH (growth/tech)
  'RIVN', 'LCID', 'OPEN', 'LMND', 'HIMS', 'IONQ', 'RXRX',
  'ARQT', 'TDUP', 'RELY', 'MIRM', 'ACHR', 'JOBY', 'SPCE',
  // Volatile large-caps with frequent resets
  'SMCI', 'MSTR', 'COIN', 'HOOD', 'SOFI', 'PLTR', 'ARM',
  'MARA', 'RIOT', 'CRSP', 'EDIT', 'NTLA', 'BEAM',
  // Biotech with big recent drops
  'SAVA', 'NVAX', 'OCGN', 'TLRY', 'CGC', 'ACB',
];

export interface DiagonalScreenerResult {
  symbol: string;
  price: number;
  drawdownPct: number;       // % below 52-week high
  rsi14: number | null;
  isOversold: boolean;       // RSI ≤ 35 or drawdown ≥ 15% in 5d
  selloffDepth5d: number;    // % change over last 5 trading days
  hasViableChain: boolean;   // ≥2 expirations, meaningful OI exists
  expirations: string[];     // available option expirations
  isBackwardation: boolean;  // near-term IV > far-term IV
  nearTermIV: number | null; // average IV of nearest expiry
  farTermIV: number | null;  // average IV of 2nd/3rd expiry
  ivRatio: number | null;    // nearTermIV / farTermIV
  suggestedSetup: string;    // e.g. "Long Jan $50 / Short Oct $60 Diagonal"
  longLeg: { strike: number; expiry: string; delta: number } | null;
  shortLeg: { strike: number; expiry: string; iv: number } | null;
  breakEven: number | null;  // estimated B/E as % of current price
  greeksProfile: {
    theta: 'positive' | 'negative' | 'neutral';
    gamma: 'elevated' | 'moderate' | 'low';
    vega: 'net-short' | 'net-long' | 'neutral';
  };
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
 * Compute average implied volatility for contracts near the current price
 * on a given expiration date. Returns null if no qualifying contracts exist.
 */
function avgIVForExpiry(
  contracts: any[],
  expiry: string,
  currentPrice: number,
  strikeRangePct = 0.15,
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

/**
 * Find a deep-ITM LEAP-like contract for the long leg.
 * Targets delta ~0.75–0.85 by proxying with strike ~75-85% of current price (call).
 * Returns the nearest strike at the farthest available expiry.
 */
function suggestLongLeg(
  contracts: any[],
  expirations: string[],
  currentPrice: number,
): { strike: number; expiry: string; delta: number } | null {
  if (expirations.length < 2) return null;
  const farExpiry = expirations[expirations.length - 1]!;
  const targetStrike = currentPrice * 0.80; // ~80% of price → ~0.80 delta proxy

  const farCalls = contracts.filter(c =>
    c.details?.expiration_date === farExpiry &&
    c.details?.contract_type === 'call' &&
    c.details?.strike_price != null,
  );

  if (farCalls.length === 0) return null;

  farCalls.sort(
    (a: any, b: any) =>
      Math.abs(a.details.strike_price - targetStrike) -
      Math.abs(b.details.strike_price - targetStrike),
  );

  const best = farCalls[0];
  if (!best) return null;
  const strike = best.details.strike_price;
  // Estimate delta from strike/price ratio (rough proxy when greeks not available)
  const moneyness = currentPrice / strike;
  const estimatedDelta = Math.min(0.95, Math.max(0.50, 0.5 + (moneyness - 1) * 0.5));

  return { strike, expiry: farExpiry, delta: Number(estimatedDelta.toFixed(2)) };
}

/**
 * Find an ATM or slightly OTM short call on the nearest expiry.
 */
function suggestShortLeg(
  contracts: any[],
  expirations: string[],
  currentPrice: number,
): { strike: number; expiry: string; iv: number } | null {
  if (expirations.length === 0) return null;
  const nearExpiry = expirations[0]!;

  // Prefer calls 2–8% OTM (classical short call in a BuCD)
  const nearCalls = contracts.filter(c =>
    c.details?.expiration_date === nearExpiry &&
    c.details?.contract_type === 'call' &&
    c.details?.strike_price != null &&
    c.implied_volatility > 0,
  );

  if (nearCalls.length === 0) return null;

  const otmTarget = currentPrice * 1.05;
  nearCalls.sort(
    (a: any, b: any) =>
      Math.abs(a.details.strike_price - otmTarget) -
      Math.abs(b.details.strike_price - otmTarget),
  );

  const best = nearCalls[0];
  if (!best) return null;
  return {
    strike: best.details.strike_price,
    expiry: nearExpiry,
    iv: Number(((best.implied_volatility || 0) * 100).toFixed(1)),
  };
}

/**
 * Compute estimated break-even for the diagonal as a % of current price.
 * Simple model: B/E ≈ long strike - (short credit received)
 * Credit ≈ short leg mid-price = (bid + ask) / 2 || last_quote.last
 * We approximate with IV-based rough premium: IV * sqrt(DTE/365) * strike * 0.4
 */
function estimateBreakEven(
  longLeg: { strike: number; expiry: string; delta: number } | null,
  shortLeg: { strike: number; expiry: string; iv: number } | null,
  currentPrice: number,
  contracts: any[],
): number | null {
  if (!longLeg || !shortLeg) return null;

  // Try to get actual mid price of short leg contract
  const shortContract = contracts.find(c =>
    c.details?.expiration_date === shortLeg.expiry &&
    c.details?.strike_price === shortLeg.strike &&
    c.details?.contract_type === 'call',
  );

  let shortCredit = 0;
  if (shortContract) {
    const bid = shortContract.last_quote?.bid || 0;
    const ask = shortContract.last_quote?.ask || 0;
    const last = shortContract.last_quote?.last || 0;
    shortCredit = bid > 0 && ask > 0 ? (bid + ask) / 2 : last;
  }

  // If no real price, estimate from IV * moneyness approximation
  if (shortCredit === 0) {
    const dteMatch = shortLeg.expiry.match(/\d{4}-(\d{2})-(\d{2})/);
    if (dteMatch) {
      const exp = new Date(shortLeg.expiry);
      const now = new Date();
      const dte = Math.max(1, (exp.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      // BS approximation for ATM/near-ATM: C ≈ S * σ * sqrt(T) * 0.4
      shortCredit = currentPrice * (shortLeg.iv / 100) * Math.sqrt(dte / 365) * 0.4;
    }
  }

  // Long leg cost = current price - long strike + some intrinsic (rough)
  const longCost = Math.max(0.5, currentPrice - longLeg.strike + currentPrice * 0.05);
  const netDebit = longCost - shortCredit;
  const breakEven = longLeg.strike + netDebit;

  // Express as % of current price
  return Number(((breakEven / currentPrice) * 100).toFixed(1));
}

export async function runDiagonalScreener(): Promise<DiagonalScreenerResult[]> {
  console.log('[DiagonalScreener] Starting scan...');

  // Fetch batch quotes
  let rawQuotes: Record<string, unknown>[] = [];
  try {
    const batch = await yf.quote(DIAGONAL_UNIVERSE);
    rawQuotes = Array.isArray(batch) ? batch : [batch];
  } catch (err) {
    console.error('[DiagonalScreener] Quote fetch error:', err);
    throw new Error('Failed to fetch quotes for diagonal screener universe.');
  }

  const results: DiagonalScreenerResult[] = [];

  // Process in batches of 4 to avoid rate limits (options chain + history per symbol)
  const BATCH_SIZE = 4;
  for (let i = 0; i < rawQuotes.length; i += BATCH_SIZE) {
    const batchQuotes = rawQuotes.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.allSettled(
      batchQuotes.map(async q => {
        const symbol = q['symbol'] as string;
        const price = (q['regularMarketPrice'] as number) ?? 0;
        const fiftyTwoWeekHigh = (q['fiftyTwoWeekHigh'] as number) ?? price;

        if (!symbol || price < 0.5) return null;

        const drawdownPct = fiftyTwoWeekHigh > 0
          ? Number(((1 - price / fiftyTwoWeekHigh) * 100).toFixed(1))
          : 0;

        // ── Historical prices for RSI and 5-day selloff ──────────────────
        let rsi14: number | null = null;
        let selloffDepth5d = 0;

        try {
          const bars = await getTimeSeriesYahoo(symbol, '1d', 30);
          const closes = bars.map((b: any) => b.close).filter((c: number) => c != null);
          rsi14 = computeRSI14(closes);
          if (closes.length >= 6) {
            const prev5 = closes[closes.length - 6]!;
            const curr = closes[closes.length - 1]!;
            selloffDepth5d = Number(((curr - prev5) / prev5 * 100).toFixed(1));
          }
        } catch {
          // proceed without
        }

        const isOversold = (rsi14 !== null && rsi14 <= 35) || selloffDepth5d <= -15;

        // ── Options chain ─────────────────────────────────────────────────
        let expirations: string[] = [];
        let contracts: any[] = [];
        let hasViableChain = false;
        let nearTermIV: number | null = null;
        let farTermIV: number | null = null;
        let ivRatio: number | null = null;
        let isBackwardation = false;

        try {
          const chain = await getOptionsChainYahoo(symbol);
          expirations = chain.expirations;
          contracts = chain.contracts;

          // Need ≥2 expirations and some OI to be viable
          const hasOI = contracts.some(c => (c.day?.open_interest || 0) >= 10);
          hasViableChain = expirations.length >= 2 && hasOI;

          if (hasViableChain) {
            nearTermIV = avgIVForExpiry(contracts, expirations[0]!, price);
            // Use 2nd or 3rd expiry for far term
            const farExpIdx = Math.min(2, expirations.length - 1);
            farTermIV = avgIVForExpiry(contracts, expirations[farExpIdx]!, price);

            if (nearTermIV !== null && farTermIV !== null && farTermIV > 0) {
              ivRatio = Number((nearTermIV / farTermIV).toFixed(2));
              isBackwardation = nearTermIV > farTermIV * 1.05; // near IV > far IV by >5%
            }
          }
        } catch {
          hasViableChain = false;
        }

        // ── Skip if chain not viable (can't build a diagonal) ─────────────
        if (!hasViableChain) return null;

        // ── Suggest spread legs ───────────────────────────────────────────
        const longLeg = suggestLongLeg(contracts, expirations, price);
        const shortLeg = suggestShortLeg(contracts, expirations, price);

        const breakEvenPct = estimateBreakEven(longLeg, shortLeg, price, contracts);

        let suggestedSetup = 'Diagonal Spread (Long LEAP / Short Near-Term Call)';
        if (longLeg && shortLeg) {
          suggestedSetup = `Long ${longLeg.expiry} $${longLeg.strike} / Short ${shortLeg.expiry} $${shortLeg.strike} Diagonal`;
        }

        // ── Greeks profile ────────────────────────────────────────────────
        // In a BuCD (buy call diagonal):
        //   theta: positive when near-leg decays faster than far-leg
        //   gamma: near-leg drives gamma if stock near short strike
        //   vega: net-short since far-leg vega > near-leg vega in normal term structure,
        //         but in backwardation near IV > far IV → can be net-long on far-leg vega
        const greeksProfile: DiagonalScreenerResult['greeksProfile'] = {
          theta: 'positive',                                          // Diagonals are positive theta by design
          gamma: longLeg && longLeg.delta >= 0.70 ? 'elevated' : 'moderate',
          vega: isBackwardation ? 'net-long' : 'net-short',          // Backwardation inverts normal vega sign
        };

        // ── Scoring ───────────────────────────────────────────────────────
        const reasons: string[] = [];
        let setupScore = 0;

        if (isOversold) {
          if (rsi14 !== null && rsi14 <= 35) {
            reasons.push(`RSI ${rsi14} — Oversold`);
            setupScore += 20;
          }
          if (selloffDepth5d <= -15) {
            reasons.push(`${selloffDepth5d.toFixed(1)}% drop in 5 days`);
            setupScore += 15;
          }
        }

        if (drawdownPct >= 30) {
          reasons.push(`${drawdownPct.toFixed(0)}% below 52w high`);
          setupScore += Math.min(20, drawdownPct * 0.4);
        } else if (drawdownPct >= 20) {
          reasons.push(`${drawdownPct.toFixed(0)}% below 52w high`);
          setupScore += 10;
        }

        if (isBackwardation && ivRatio !== null) {
          reasons.push(`Vol backwardation (near IV ${((nearTermIV || 0) * 100).toFixed(0)}% > far IV ${((farTermIV || 0) * 100).toFixed(0)}%)`);
          setupScore += 25;
        } else if (nearTermIV !== null) {
          reasons.push(`Near IV ${((nearTermIV || 0) * 100).toFixed(0)}% (contango)`);
          setupScore += 5;
        }

        if (breakEvenPct !== null && breakEvenPct <= 90) {
          reasons.push(`B/E at ${breakEvenPct}% of current price (deep ITM buffer)`);
          setupScore += 15;
        } else if (breakEvenPct !== null && breakEvenPct <= 95) {
          reasons.push(`B/E at ${breakEvenPct}% of current price`);
          setupScore += 8;
        }

        if (hasViableChain) {
          reasons.push(`${expirations.length} expirations available`);
          setupScore += 5;
        }

        if (longLeg && longLeg.delta >= 0.75) {
          reasons.push(`Deep ITM long leg (Δ ≈ ${longLeg.delta})`);
          setupScore += 10;
        }

        const finalScore = Math.min(98, Math.round(setupScore));

        // Only surface if it meets a minimum threshold
        if (finalScore < 40 || !isOversold) return null;

        return {
          symbol,
          price,
          drawdownPct,
          rsi14,
          isOversold,
          selloffDepth5d,
          hasViableChain,
          expirations: expirations.slice(0, 6),
          isBackwardation,
          nearTermIV,
          farTermIV,
          ivRatio,
          suggestedSetup,
          longLeg,
          shortLeg,
          breakEven: breakEvenPct,
          greeksProfile,
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

  // Sort by setup score descending
  results.sort((a, b) => b.setupScore - a.setupScore);
  console.log(`[DiagonalScreener] Found ${results.length} setups.`);
  return results;
}
