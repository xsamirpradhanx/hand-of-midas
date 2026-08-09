import { yf } from './yahoo.js';
import { getPredictiveZones } from './predictiveEngine.js';

export interface ScreenerResult {
  symbol: string;
  setupType: string;
  confidenceScore: number;
  price: number;
  changePercent: number;
  volume: number;
  rvol: number;
  rsi14?: number;
  shortFloatPct?: number;
  isGapUp?: boolean;
  reasons: string[];
}

export type ScreenerMode = 'premarket' | 'open' | 'momentum';

// ── Large-cap / ETF universe (existing premarket + open modes) ──────────────
const DEFAULT_UNIVERSE = [
  'SPY', 'QQQ', 'IWM', 'AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMD', 'AMZN', 'META',
  'GOOGL', 'PLTR', 'NFLX', 'SMCI', 'COIN', 'MSTR', 'MARA', 'RIOT', 'BA', 'DIS',
  'UBER', 'CRWD', 'PANW', 'ARM', 'MU', 'INTC', 'GME', 'AMC', 'HOOD', 'SOFI',
];

// ── $2–$20 small/micro-cap momentum universe ─────────────────────────────────
// Liquid names with listed options or high retail interest; refreshed periodically.
const LOW_PRICE_UNIVERSE = [
  // Biotech / pharma (frequent gap plays)
  'SOUN', 'ACHR', 'JOBY', 'CLOV', 'MVIS', 'SKLZ', 'IRBT', 'SPCE',
  'PTRA', 'BLNK', 'IDEX', 'NKLA', 'HYLN', 'RIDE', 'WKHS',
  // EV / Clean energy
  'ARVL', 'SOLO', 'AYRO', 'KNDI', 'XPEV', 'NIO', 'LI',
  // Fintech / digital
  'OPEN', 'LMND', 'ROOT', 'PSFE', 'SMAR', 'HIMS', 'CURO',
  // Recent IPOs / SPACs that have come down
  'IONQ', 'RXRX', 'LIDR', 'ARRY', 'OPAD', 'PRST', 'SLNA',
  // High retail-interest
  'BBBY', 'BGFV', 'EXPR', 'NAKD', 'SNDL',
];

interface Candidate {
  ticker: string;
  price: number;
  changePercent: number;
  volume: number;
  rvol: number;
  openPrice?: number;
  prevClose?: number;
}

function averageDailyVolume(quote: Record<string, unknown>): number {
  const tenDay = quote['averageDailyVolume10Day'] as number | undefined;
  const threeMonth = quote['averageDailyVolume3Month'] as number | undefined;
  return tenDay ?? threeMonth ?? 0;
}

function computeRvol(volume: number, adv: number): number {
  if (adv <= 0 || volume <= 0) return 0;
  return volume / adv;
}

/**
 * Compute RSI-14 from an array of closing prices (most-recent last).
 * Returns null if fewer than 15 bars are available.
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

export async function runScreener(mode: ScreenerMode): Promise<ScreenerResult[]> {
  console.log(`[ScreenerService] Starting scan for mode="${mode}" via Yahoo Finance...`);

  const universe = mode === 'momentum' ? LOW_PRICE_UNIVERSE : DEFAULT_UNIVERSE;

  let rawQuotes: Record<string, unknown>[] = [];
  try {
    const batch = await yf.quote(universe);
    rawQuotes = Array.isArray(batch) ? batch : [batch];
  } catch (error) {
    console.error('Yahoo Finance batch quote error:', error);
    throw new Error('Failed to fetch batch quotes from Yahoo Finance.');
  }

  if (rawQuotes.length === 0) {
    throw new Error('No quote data returned for the predefined universe.');
  }

  const enrichedCandidates: Candidate[] = [];

  for (const q of rawQuotes) {
    const symbol = q['symbol'] as string | undefined;
    const price = (q['regularMarketPrice'] as number) ?? 0;
    const prevClose = (q['regularMarketPreviousClose'] as number) ?? price;
    const openPrice = (q['regularMarketOpen'] as number) ?? price;
    const change = (q['regularMarketChange'] as number) ?? price - prevClose;
    const changePercent =
      (q['regularMarketChangePercent'] as number) ??
      (prevClose !== 0 ? (change / prevClose) * 100 : 0);
    const volume = (q['regularMarketVolume'] as number) ?? 0;
    const adv = averageDailyVolume(q);
    const rvol = computeRvol(volume, adv);

    // Price gates per mode
    if (!symbol || price < 2 || volume < 50_000) continue;
    if (mode === 'momentum' && price > 20) continue;

    enrichedCandidates.push({
      ticker: symbol,
      price,
      changePercent,
      volume,
      rvol,
      openPrice,
      prevClose,
    });
  }

  // ── Mode-specific filtering ────────────────────────────────────────────────
  let candidates = enrichedCandidates;

  if (mode === 'premarket') {
    candidates = candidates.filter(c => Math.abs(c.changePercent) >= 1);
  } else if (mode === 'momentum') {
    // Higher RVOL bar for small-caps: 1.5x minimum, or big % move
    candidates = candidates.filter(
      c => c.rvol >= 1.5 || Math.abs(c.changePercent) >= 5,
    );
  } else {
    // open
    candidates = candidates.filter(
      c => c.rvol >= 1.2 || Math.abs(c.changePercent) >= 1.5 || c.volume >= 1_000_000,
    );
  }

  candidates.sort(
    (a, b) => b.rvol * Math.abs(b.changePercent) - a.rvol * Math.abs(a.changePercent),
  );

  const topCandidates = candidates.slice(0, 15);
  console.log(`[ScreenerService] Phase 1: ${topCandidates.length} candidates for deep scan.`);

  const results: ScreenerResult[] = [];
  const BATCH_SIZE = 5;

  for (let i = 0; i < topCandidates.length; i += BATCH_SIZE) {
    const batch = topCandidates.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.allSettled(
      batch.map(async c => {
        // For momentum mode, also fetch 20 days of closes for RSI-14
        let rsi14: number | null = null;
        let shortFloatPct: number | null = null;

        if (mode === 'momentum') {
          try {
            const { yf: yfInst } = await import('./yahoo.js');
            const chart = await yfInst.chart(c.ticker, {
              period1: (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d; })(),
              period2: new Date(),
              interval: '1d' as const,
            });
            const closes = (chart?.quotes ?? [])
              .filter((q: any) => q.close != null)
              .map((q: any) => q.close as number);
            rsi14 = computeRSI14(closes);
          } catch {
            // RSI optional — proceed without it
          }

          try {
            const yfInst = yf;
            const summary = await (yfInst as any).quoteSummary(c.ticker, {
              modules: ['defaultKeyStatistics'],
            });
            const stats = summary?.defaultKeyStatistics;
            if (stats?.shortPercentOfFloat?.raw != null) {
              shortFloatPct = Number((stats.shortPercentOfFloat.raw * 100).toFixed(1));
            }
          } catch {
            // short float is optional
          }
        }

        const engineResult = await getPredictiveZones(c.ticker);
        return { candidate: c, engineResult, rsi14, shortFloatPct };
      }),
    );

    for (const res of batchResults) {
      if (res.status !== 'fulfilled') {
        console.warn('[ScreenerService] Batch item failed:', res.reason);
        continue;
      }
      const { candidate, engineResult, rsi14, shortFloatPct } = res.value;
      const screenerResult = evaluateSetup(candidate, engineResult, mode, rsi14, shortFloatPct);
      if (screenerResult && screenerResult.confidenceScore >= 65) {
        results.push(screenerResult);
      }
    }
  }

  results.sort((a, b) => b.confidenceScore - a.confidenceScore);
  return results;
}

function evaluateSetup(
  candidate: Candidate,
  engineResult: Awaited<ReturnType<typeof getPredictiveZones>>,
  mode: ScreenerMode,
  rsi14: number | null,
  shortFloatPct: number | null,
): ScreenerResult | null {
  const factors = engineResult.aiThesis.factors;
  const thesisBias = engineResult.aiThesis.bias;
  const engineConviction = Math.round(engineResult.aiThesis.overallConviction * 100);

  const reasons: string[] = [];
  let setupScore = 0;

  const hasFactor = (keyword: string) =>
    factors.find(f => f.factorName.toLowerCase().includes(keyword.toLowerCase()));

  // ── RVOL signal ──────────────────────────────────────────────────────────
  if (candidate.rvol >= 1) {
    reasons.push(`RVOL ${candidate.rvol.toFixed(1)}x`);
    setupScore += candidate.rvol >= 3 ? 18 : candidate.rvol >= 2 ? 15 : candidate.rvol >= 1.5 ? 10 : 5;
  }

  // ── % Move signal ────────────────────────────────────────────────────────
  if (Math.abs(candidate.changePercent) >= 1) {
    reasons.push(`Move ${candidate.changePercent >= 0 ? '+' : ''}${candidate.changePercent.toFixed(1)}%`);
    setupScore += Math.abs(candidate.changePercent) >= 5 ? 12 : Math.abs(candidate.changePercent) >= 3 ? 10 : 5;
  }

  // ── Gap-up detection (momentum mode) ────────────────────────────────────
  const isGapUp = !!(
    candidate.openPrice &&
    candidate.prevClose &&
    candidate.openPrice > candidate.prevClose * 1.03 &&
    candidate.changePercent > 0
  );
  if (isGapUp && mode === 'momentum') {
    reasons.push('Gap & Go');
    setupScore += 12;
  }

  // ── RSI signals (momentum mode) ─────────────────────────────────────────
  if (rsi14 !== null && mode === 'momentum') {
    if (rsi14 >= 60 && rsi14 < 80) {
      reasons.push(`RSI ${rsi14} (Momentum)`);
      setupScore += 10;
    } else if (rsi14 >= 80) {
      reasons.push(`RSI ${rsi14} (Overbought — caution)`);
      setupScore += 3;
    } else if (rsi14 <= 40 && thesisBias === 'bullish') {
      reasons.push(`RSI ${rsi14} (Oversold bounce)`);
      setupScore += 8;
    }
  }

  // ── Short float squeeze potential (momentum mode) ─────────────────────
  if (shortFloatPct !== null && shortFloatPct >= 15 && mode === 'momentum') {
    reasons.push(`Short Float ${shortFloatPct.toFixed(1)}% (Squeeze potential)`);
    setupScore += 10;
  }

  // ── Factor-derived signals ────────────────────────────────────────────
  const vwap = hasFactor('anchored vwap');
  const squeeze = hasFactor('squeeze');
  const hurst = hasFactor('hurst');
  const smf = hasFactor('smart money');
  const gamma = hasFactor('dealer');
  const insider = hasFactor('catalyst');

  if (vwap?.bias === 'bullish' && candidate.changePercent >= 0) {
    reasons.push('Above VWAP');
    setupScore += 8;
  } else if (vwap?.bias === 'bearish' && candidate.changePercent < 0) {
    reasons.push('Below VWAP');
    setupScore += 8;
  }

  if (smf?.bias === 'bullish' && thesisBias !== 'bearish') {
    reasons.push('Smart Money Accumulation');
    setupScore += 12;
  } else if (smf?.bias === 'bearish' && thesisBias !== 'bullish') {
    reasons.push('Smart Money Distribution');
    setupScore += 10;
  }

  if (gamma?.bias === 'bullish') {
    reasons.push('Positive Gamma Confirmation');
    setupScore += 8;
  }

  let hurstVal: number | null = null;
  if (hurst?.reasoning) {
    const match = hurst.reasoning.match(/H\s*=\s*([\d.]+)/);
    if (match) hurstVal = parseFloat(match[1]!);
  }

  // ── Setup type classification ─────────────────────────────────────────
  let setupType = 'Trend Continuation';

  if (mode === 'premarket') {
    setupType = Math.abs(candidate.changePercent) >= 3 ? 'Relative Volume Gap' : 'Momentum Catalyst';
    if (insider?.bias === 'bullish') {
      setupType = 'News Catalyst';
      reasons.push('News/Insider Catalyst');
      setupScore += 15;
    }
  } else if (mode === 'momentum') {
    if (isGapUp && candidate.rvol >= 2) {
      setupType = 'Gap & Go Momentum';
      setupScore += 10;
    } else if (rsi14 !== null && rsi14 >= 60 && smf?.bias === 'bullish') {
      setupType = 'Momentum Breakout';
      setupScore += 12;
    } else if (rsi14 !== null && rsi14 <= 35 && thesisBias === 'bullish') {
      setupType = 'Oversold Bounce';
      setupScore += 8;
    } else if (shortFloatPct !== null && shortFloatPct >= 20) {
      setupType = 'Short Squeeze Setup';
      setupScore += 10;
    } else if (candidate.rvol >= 2 && candidate.changePercent >= 3) {
      setupType = 'High RVOL Momentum';
      setupScore += 10;
    }
  } else {
    // open mode — original logic preserved
    if (squeeze && squeeze.bias !== 'neutral' && hurstVal !== null && hurstVal > 0.55) {
      setupType = 'Volatility Expansion';
      setupScore += 12;
    } else if (hurstVal !== null && hurstVal < 0.45) {
      setupType = 'Mean Reversion';
      setupScore += 8;
    } else if (
      candidate.rvol >= 1.8 &&
      candidate.changePercent >= 0.5 &&
      vwap?.bias === 'bullish'
    ) {
      setupType = 'Opening Range Breakout';
      setupScore += 12;
    } else if (gamma?.bias === 'bullish' && candidate.changePercent >= 0) {
      setupType = 'Gamma Confirmation';
      setupScore += 10;
    }
  }

  // ── Blend score ──────────────────────────────────────────────────────────
  // Momentum mode: 60% rule-based / 40% engine (engine calibrated on large-caps)
  // Other modes: 45% rule / 55% engine (original)
  const ruleWeight = mode === 'momentum' ? 0.60 : 0.45;
  const engineWeight = mode === 'momentum' ? 0.40 : 0.55;

  const confidenceScore = Math.min(
    98,
    Math.max(0, Math.round(setupScore * ruleWeight + engineConviction * engineWeight)),
  );

  if (confidenceScore < 65) return null;

  return {
    symbol: candidate.ticker,
    setupType,
    confidenceScore,
    price: candidate.price,
    changePercent: candidate.changePercent,
    volume: candidate.volume,
    rvol: Number(candidate.rvol.toFixed(2)),
    rsi14: rsi14 ?? undefined,
    shortFloatPct: shortFloatPct ?? undefined,
    isGapUp,
    reasons,
  };
}
