
import { yf } from './yahoo.js';
import { getPredictiveZones } from './predictiveEngine.js';

export interface ScreenerResult {
  symbol: string;
  setupType: string;
  setupStage: 'EARLY' | 'DEVELOPING' | 'BREAKOUT' | 'EXTENDED';
  midasScore: number;
  momentumScore: number;
  probability: number;
  riskScore: number;
  subScores: {
    momentumQuality: number;
    volumeConfirmation: number;
    extensionPenalty: number;
    catalystQuality: number;
    liquidity: number;
    riskInverse: number;
  };
  price: number;
  changePercent: number;
  relativeStrength?: number;
  volume: number;
  rvol: number;
  floatTurnover?: number;
  rsi14?: number;
  shortFloatPct?: number;
  isGapUp?: boolean;
  isExtremeMover?: boolean;
  dataQuality: 'VERIFIED' | 'CHECK' | 'SUSPICIOUS';
  yahooSources: string[];
  yahooConsensus: number;
  reasons: string[];
}

export type ScreenerMode = 'premarket' | 'open' | 'momentum' | 'highdemand';

import { calculateMidasScore } from './midasModel.js';
import { buildActiveMarketUniverse } from './universeService.js';

interface Candidate {
  ticker: string;
  price: number;
  changePercent: number;
  volume: number;
  rvol: number;
  intradayRvol: number;
  openPrice?: number;
  prevClose?: number;
  yahooSources: string[];
  yahooConsensus: number;
  floatTurnover?: number;
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
 * Time-of-day adjusted RVOL proxy.
 * Estimates what percentage of a standard trading session's volume *should* have
 * traded by the current minute, and normalizes the denominator.
 */
function computeIntradayRvol(volume: number, adv: number): number {
  if (adv <= 0 || volume <= 0) return 0;
  
  // Get current time in New York
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  });
  const parts = formatter.formatToParts(now);
  const hour = parseInt(parts.find(p => p.type === 'hour')!.value, 10);
  const minute = parseInt(parts.find(p => p.type === 'minute')!.value, 10);

  const currentMinutes = hour * 60 + minute;
  const openMinutes = 9 * 60 + 30; // 9:30 AM
  const closeMinutes = 16 * 60;    // 4:00 PM

  let elapsedRatio = 1.0;
  
  if (currentMinutes < openMinutes) {
    // Premarket: extremely early, volume is naturally very low compared to ADV.
    // We assume by 9:30 AM, premarket usually does ~5-10% of ADV.
    const premarketStart = 4 * 60; // 4:00 AM
    const elapsedPre = Math.max(0, currentMinutes - premarketStart);
    const totalPre = openMinutes - premarketStart;
    const premarketMaxRatio = 0.08; // 8% of daily volume expected by open
    elapsedRatio = Math.max(0.01, (elapsedPre / totalPre) * premarketMaxRatio);
  } else if (currentMinutes < closeMinutes) {
    // Open market: 390 minutes total
    const elapsedOpen = currentMinutes - openMinutes;
    // Volume curve is U-shaped, but linear is a safe conservative proxy
    elapsedRatio = Math.max(0.1, elapsedOpen / 390);
  }

  // Normalization: if we are 50% through the day, compare current volume against 50% of ADV
  const timeAdjustedAdv = adv * elapsedRatio;
  return volume / timeAdjustedAdv;
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

  const universeCandidates = await buildActiveMarketUniverse();

  if (universeCandidates.length === 0) {
    throw new Error('Could not determine dynamic universe from market data.');
  }

  // Build lookup maps for Yahoo Consensus data
  const yahooSourcesMap = new Map<string, string[]>();
  const yahooConsensusMap = new Map<string, number>();
  for (const uc of universeCandidates) {
    yahooSourcesMap.set(uc.symbol, uc.yahooSources);
    yahooConsensusMap.set(uc.symbol, uc.yahooConsensus);
  }
  const symbols = universeCandidates.map(uc => uc.symbol);

  let rawQuotes: Record<string, unknown>[] = [];
  try {
    const batch = await yf.quote(symbols);
    rawQuotes = Array.isArray(batch) ? batch : [batch];
  } catch (error) {
    console.error('Yahoo Finance batch quote error:', error);
    throw new Error('Failed to fetch batch quotes from Yahoo Finance.');
  }

  if (rawQuotes.length === 0) {
    throw new Error('No quote data returned for the predefined universe.');
  }

  // Find SPY for relative strength baseline
  const spyQuote = rawQuotes.find(q => q['symbol'] === 'SPY');
  let spyChange = 0;
  if (spyQuote) {
    const pPrice = (spyQuote['regularMarketPrice'] as number) ?? 0;
    const pPrev = (spyQuote['regularMarketPreviousClose'] as number) ?? pPrice;
    if (pPrev !== 0) spyChange = ((pPrice - pPrev) / pPrev) * 100;
  }

  const enrichedCandidates: Candidate[] = [];

  for (const q of rawQuotes) {
    const symbol = q['symbol'] as string | undefined;
    let price = (q['regularMarketPrice'] as number) ?? 0;
    const prevClose = (q['regularMarketPreviousClose'] as number) ?? price;
    const openPrice = (q['regularMarketOpen'] as number) ?? price;
    let change = (q['regularMarketChange'] as number) ?? price - prevClose;
    let changePercent =
      (q['regularMarketChangePercent'] as number) ??
      (prevClose !== 0 ? (change / prevClose) * 100 : 0);

    const isPreMarket = q['marketState'] === 'PRE' || q['marketState'] === 'PREPRE' || mode === 'premarket';
    if (isPreMarket && q['preMarketPrice'] !== undefined) {
      price = q['preMarketPrice'] as number;
      change = (q['preMarketChange'] as number) ?? change;
      changePercent = (q['preMarketChangePercent'] as number) ?? changePercent;
    }

    const volume = (q['regularMarketVolume'] as number) ?? 0;
    const adv = averageDailyVolume(q);
    const rvol = computeRvol(volume, adv);
    const intradayRvol = computeIntradayRvol(volume, adv);

    // Price gates per mode
    if (!symbol || price < 2 || volume < 50_000) continue;
    if ((mode === 'momentum' || mode === 'highdemand') && price > 20) continue;
    // highdemand: hard gate — must already be up ≥10% and have 5x RVOL
    if (mode === 'highdemand' && (changePercent < 10 || rvol < 5)) continue;

    enrichedCandidates.push({
      ticker: symbol,
      price,
      changePercent,
      volume,
      rvol,
      intradayRvol,
      openPrice,
      prevClose,
      yahooSources: yahooSourcesMap.get(symbol) ?? [],
      yahooConsensus: yahooConsensusMap.get(symbol) ?? 0,
    });
  }

  // ── Mode-specific filtering ────────────────────────────────────────────────
  let candidates = enrichedCandidates;

  if (mode === 'premarket') {
    candidates = candidates.filter(c => Math.abs(c.changePercent) >= 1);
  } else if (mode === 'highdemand') {
    // Hard gates already applied above; no further filtering needed
  } else if (mode === 'momentum') {
    candidates = candidates.filter(
      c => c.rvol >= 1.5 || Math.abs(c.changePercent) >= 5,
    );
  } else {
    // open
    candidates = candidates.filter(
      c => c.rvol >= 1.2 || Math.abs(c.changePercent) >= 1.5 || c.volume >= 1_000_000,
    );
  }

  // ── Phase 1 sort: blend RVOL * move with Yahoo Consensus ──────────────────
  // Stocks appearing in more Yahoo screener lists get a ranking boost.
  // This surfaces tickers with broad market agreement over single-list flukes.
  candidates.sort((a, b) => {
    const scoreA = a.rvol * Math.abs(a.changePercent) + a.yahooConsensus * 0.5;
    const scoreB = b.rvol * Math.abs(b.changePercent) + b.yahooConsensus * 0.5;
    return scoreB - scoreA;
  });

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

        if (mode === 'momentum' || mode === 'highdemand') {
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
            if (stats?.floatShares?.raw != null) {
              c.floatTurnover = c.volume / stats.floatShares.raw;
            }
            
            // Supply gate: shares outstanding < 20M for highdemand
            if (mode === 'highdemand') {
              const sharesOut = stats?.sharesOutstanding?.raw as number | undefined;
              if (sharesOut != null && sharesOut >= 20_000_000) {
                // Skip this candidate — too much supply
                throw new Error(`SUPPLY_SKIP: ${c.ticker} shares outstanding ${sharesOut} >= 20M`);
              }
            }
          } catch (err: any) {
            if (err?.message?.startsWith('SUPPLY_SKIP')) throw err;
            // short float / shares data is optional for non-highdemand
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
      const screenerResult = await evaluateSetup(candidate, engineResult, mode, rsi14, shortFloatPct, spyChange);
      const threshold = mode === 'premarket' ? 45 : 60;
      if (screenerResult && screenerResult.midasScore >= threshold) {
        results.push(screenerResult);
      }
    }
  }

  results.sort((a, b) => b.midasScore - a.midasScore);
  return results;
}

async function evaluateSetup(
  candidate: Candidate & { floatTurnover?: number },
  engineResult: Awaited<ReturnType<typeof getPredictiveZones>>,
  mode: ScreenerMode,
  rsi14: number | null,
  shortFloatPct: number | null,
  spyChange: number
): Promise<ScreenerResult | null> {
  const relativeStrength = Number((candidate.changePercent - spyChange).toFixed(2));
  let setupStage: 'EARLY' | 'DEVELOPING' | 'BREAKOUT' | 'EXTENDED' = 'DEVELOPING';
  
  if (Math.abs(candidate.changePercent) > 40 || (rsi14 && rsi14 > 80)) {
    setupStage = 'EXTENDED';
  } else if (Math.abs(candidate.changePercent) > 15 || (rsi14 && rsi14 > 65)) {
    setupStage = 'BREAKOUT';
  } else if (Math.abs(candidate.changePercent) < 5 && (!rsi14 || rsi14 < 50)) {
    setupStage = 'EARLY';
  }

  let dataQuality: 'VERIFIED' | 'CHECK' | 'SUSPICIOUS' = 'VERIFIED';
  if (candidate.intradayRvol > 100 || Math.abs(candidate.changePercent) > 200) {
    dataQuality = 'SUSPICIOUS';
  } else if (candidate.intradayRvol > 30 || Math.abs(candidate.changePercent) > 50) {
    dataQuality = 'CHECK';
  }
  // ── highdemand: dedicated scoring path ───────────────────────────────────
  if (mode === 'highdemand') {
    const reasons: string[] = [];
    let setupScore = 0;
    const factors = engineResult.aiThesis.factors;
    const thesisBias = engineResult.aiThesis.bias;
    const engineConviction = Math.round(engineResult.aiThesis.overallConviction * 100);
    const hasFactor = (keyword: string) =>
      factors.find(f => f.factorName.toLowerCase().includes(keyword.toLowerCase()));
    const insider = hasFactor('catalyst');

    // Criterion 1 — Up ≥10% on the day (hard gate already passed, score it)
    reasons.push(`Up ${candidate.changePercent.toFixed(1)}% today`);
    setupScore += candidate.changePercent >= 20 ? 25 : candidate.changePercent >= 15 ? 20 : 15;

    // Criterion 2 — 5x RVOL (hard gate already passed, score it)
    reasons.push(`RVOL ${candidate.rvol.toFixed(1)}x (High Demand)`);
    setupScore += candidate.rvol >= 10 ? 25 : candidate.rvol >= 7 ? 20 : 15;

    // Criterion 3 — News catalyst (soft bonus)
    if (insider?.bias === 'bullish') {
      reasons.push('News / Catalyst Detected');
      setupScore += 20;
    }

    // Criterion 4 — Price range $2–$20 already enforced; confirm proximity to low end
    if (candidate.price < 10) {
      reasons.push(`Price $${candidate.price.toFixed(2)} (Day-trader sweet spot)`);
      setupScore += 5;
    }

    // Criterion 5 — Float already gate-checked; bonus if short interest elevated
    if (shortFloatPct != null && shortFloatPct >= 15) {
      reasons.push(`Short Float ${shortFloatPct.toFixed(1)}% — Squeeze Risk`);
      setupScore += 10;
    }

    // Gap-up signal
    const isGapUp = !!(
      candidate.openPrice &&
      candidate.prevClose &&
      candidate.openPrice > candidate.prevClose * 1.05
    );
    if (isGapUp) {
      reasons.push('Gap & Go');
      setupScore += 10;
    }

    // RSI momentum range
    if (rsi14 != null && rsi14 >= 60 && rsi14 < 85) {
      reasons.push(`RSI ${rsi14} (Momentum zone)`);
      setupScore += 8;
    }

    const smf = hasFactor('smart money');
    if (smf?.bias === 'bullish' && thesisBias !== 'bearish') {
      reasons.push('Smart Money Accumulation');
      setupScore += 10;
    }

    const legacyConfidenceScore = Math.min(
      98,
      Math.max(0, Math.round(setupScore * 0.70 + engineConviction * 0.30)),
    );

    const isExtremeMover = candidate.intradayRvol > 50 || Math.abs(candidate.changePercent) > 100;
    if (isExtremeMover) {
      reasons.unshift('⚠️ Extreme Mover — Verify data / halt risk');
    }

    const { midasScore, momentumScore, probability, riskScore, subScores } = await calculateMidasScore(
      candidate.ticker,
      candidate.price,
      candidate.changePercent,
      candidate.rvol,
      candidate.intradayRvol,
      legacyConfidenceScore,
      mode,
      candidate.volume,
      candidate.floatTurnover,
      rsi14
    );

    if (midasScore < 60 && riskScore < 80 && momentumScore < 80) return null; // Keep high risk or high momentum things so users can see them!

    return {
      symbol: candidate.ticker,
      setupType: isGapUp ? 'Gap & Go — High Demand' : 'High Demand Setup',
      setupStage,
      midasScore,
      momentumScore,
      probability,
      riskScore,
      subScores,
      price: candidate.price,
      changePercent: candidate.changePercent,
      relativeStrength,
      volume: candidate.volume,
      rvol: Number(candidate.intradayRvol.toFixed(2)),
      floatTurnover: candidate.floatTurnover ? Number(candidate.floatTurnover.toFixed(2)) : undefined,
      rsi14: rsi14 ?? undefined,
      shortFloatPct: shortFloatPct ?? undefined,
      isGapUp,
      isExtremeMover,
      dataQuality,
      yahooSources: candidate.yahooSources,
      yahooConsensus: candidate.yahooConsensus,
      reasons,
    };
  }

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
  const ruleWeight = mode === 'momentum' ? 0.60 : 0.45;
  const engineWeight = mode === 'momentum' ? 0.40 : 0.55;

  const legacyConfidenceScore = Math.min(
    98,
    Math.max(0, Math.round(setupScore * ruleWeight + engineConviction * engineWeight)),
  );

  const isExtremeMover = candidate.intradayRvol > 50 || Math.abs(candidate.changePercent) > 100;
  if (isExtremeMover) {
    reasons.unshift('⚠️ Extreme Mover — Verify data / halt risk');
  }

  const { midasScore, momentumScore, probability, riskScore, subScores } = await calculateMidasScore(
    candidate.ticker,
    candidate.price,
    candidate.changePercent,
    candidate.rvol,
    candidate.intradayRvol,
    legacyConfidenceScore,
    mode,
    candidate.volume,
    candidate.floatTurnover,
    rsi14
  );
  
  const threshold = mode === 'premarket' ? 45 : 60;
  if (midasScore < threshold && riskScore < 80 && momentumScore < 80) return null;

  return {
    symbol: candidate.ticker,
    setupType,
    setupStage,
    midasScore,
    momentumScore,
    probability,
    riskScore,
    subScores,
    price: candidate.price,
    changePercent: candidate.changePercent,
    relativeStrength,
    volume: candidate.volume,
    rvol: Number(candidate.intradayRvol.toFixed(2)),
    floatTurnover: candidate.floatTurnover ? Number(candidate.floatTurnover.toFixed(2)) : undefined,
    rsi14: rsi14 ?? undefined,
    shortFloatPct: shortFloatPct ?? undefined,
    isGapUp,
    isExtremeMover,
    dataQuality,
    yahooSources: candidate.yahooSources,
    yahooConsensus: candidate.yahooConsensus,
    reasons,
  };
}
