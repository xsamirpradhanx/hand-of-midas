import { yf } from './yahoo.js';
import { getPredictiveZones } from './predictiveEngine.js';

export interface ScreenerResult {
  symbol: string;
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  setupType: string;
  setupStage: 'EARLY' | 'DEVELOPING' | 'BREAKOUT' | 'EXTENDED' | 'BREAKDOWN';
  midasScore: number;
  longMomentum: number;
  shortMomentum: number;
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
  dollarVolume: number;
  pmVwap?: number | null;
  pmHigh?: number | null;
  pmLow?: number | null;
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
  dollarVolume: number;
  openPrice?: number;
  prevClose?: number;
  yahooSources: string[];
  yahooConsensus: number;
  floatTurnover?: number;
  volumeAcceleration?: number;
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

function computeIntradayRvol(volume: number, adv: number): number {
  if (adv <= 0 || volume <= 0) return 0;
  
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
    const premarketStart = 4 * 60; // 4:00 AM
    const elapsedPre = Math.max(0, currentMinutes - premarketStart);
    const totalPre = openMinutes - premarketStart;
    const premarketMaxRatio = 0.08; 
    elapsedRatio = Math.max(0.01, (elapsedPre / totalPre) * premarketMaxRatio);
  } else if (currentMinutes < closeMinutes) {
    const elapsedOpen = currentMinutes - openMinutes;
    elapsedRatio = Math.max(0.1, elapsedOpen / 390);
  }

  const timeAdjustedAdv = adv * elapsedRatio;
  return volume / timeAdjustedAdv;
}

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

function calculateIntradayMetrics(chart: any): { pmVwap: number | null, pmHigh: number | null, pmLow: number | null, volumeAcceleration: number } {
  if (!chart?.quotes || chart.quotes.length === 0) return { pmVwap: null, pmHigh: null, pmLow: null, volumeAcceleration: 0 };
  let high = -Infinity;
  let low = Infinity;
  let cumVolPrice = 0;
  let cumVol = 0;
  const barVolumes: number[] = [];
  for (const q of chart.quotes) {
    if (q.close == null || q.volume == null) continue;
    if (q.high > high) high = q.high;
    if (q.low < low) low = q.low;
    const typicalPrice = (q.high + q.low + q.close) / 3;
    cumVolPrice += typicalPrice * q.volume;
    cumVol += q.volume;
    barVolumes.push(q.volume || 0);
  }
  const pmVwap = cumVol > 0 ? cumVolPrice / cumVol : null;

  // Volume Acceleration: ratio of last 5 bars' avg volume to full session avg volume.
  // Values > 3.0 indicate a significant volume burst — institutional entry beginning.
  let volumeAcceleration = 0;
  if (barVolumes.length >= 10) {
    const sessionAvg = barVolumes.reduce((a, b) => a + b, 0) / barVolumes.length;
    const recentWindow = barVolumes.slice(-5);
    const recentAvg = recentWindow.reduce((a, b) => a + b, 0) / recentWindow.length;
    volumeAcceleration = sessionAvg > 0 ? recentAvg / sessionAvg : 0;
  }

  return { pmVwap, pmHigh: high === -Infinity ? null : high, pmLow: low === Infinity ? null : low, volumeAcceleration };
}

export async function runScreener(mode: ScreenerMode): Promise<ScreenerResult[]> {
  console.log(`[ScreenerService] Starting scan for mode="${mode}" via Yahoo Finance...`);

  const universeCandidates = await buildActiveMarketUniverse();

  if (universeCandidates.length === 0) {
    throw new Error('Could not determine dynamic universe from market data.');
  }

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
    let volume = 0;

    if (isPreMarket) {
      if (q['preMarketPrice'] !== undefined) {
        price = q['preMarketPrice'] as number;
        change = (q['preMarketChange'] as number) ?? change;
        changePercent = (q['preMarketChangePercent'] as number) ?? changePercent;
      }
      volume = (q['preMarketVolume'] as number) ?? 0;
    } else {
      volume = (q['regularMarketVolume'] as number) ?? 0;
    }

    const adv = averageDailyVolume(q);
    const rvol = computeRvol(volume, adv);
    const intradayRvol = computeIntradayRvol(volume, adv);
    const dollarVolume = price * volume;

    // Premarket volume is much lower than regular hours. However, Yahoo Finance
    // often no longer returns `preMarketVolume` in the quote payload (it comes back undefined).
    // If we are in premarket and volume is 0 (because it was undefined), we bypass the volume gate
    // to avoid filtering out the entire market.
    const minVolume = isPreMarket ? 5_000 : 50_000;
    const failsVolumeGate = isPreMarket && volume === 0 ? false : volume < minVolume;
    
    if (!symbol || price < 2 || failsVolumeGate) continue;
    if ((mode === 'momentum' || mode === 'highdemand') && price > 20) continue;
    if (mode === 'highdemand' && (changePercent < 10 || intradayRvol < 5)) continue;

    enrichedCandidates.push({
      ticker: symbol,
      price,
      changePercent,
      volume,
      rvol,
      intradayRvol,
      dollarVolume,
      openPrice,
      prevClose,
      yahooSources: yahooSourcesMap.get(symbol) ?? [],
      yahooConsensus: yahooConsensusMap.get(symbol) ?? 0,
    });
  }

  let candidates = enrichedCandidates;

  if (mode === 'premarket') {
    // Premarket: accept any stock with meaningful premarket activity
    candidates = candidates.filter(c => Math.abs(c.changePercent) >= 1 || c.intradayRvol >= 3);
  } else if (mode === 'highdemand') {
    // Hard gates applied above
  } else if (mode === 'momentum') {
    // Use intradayRvol (time-adjusted) — catches early movers before price extends
    candidates = candidates.filter(
      c => c.intradayRvol >= 3 || Math.abs(c.changePercent) >= 5,
    );
  } else {
    // Open market: intradayRvol catches volume surges early in the session
    candidates = candidates.filter(
      c => c.intradayRvol >= 2 || Math.abs(c.changePercent) >= 1.5 || c.volume >= 1_000_000,
    );
  }

  // Early Signal Ranking: volume leads price. Weight intradayRvol heavily,
  // cap changePercent contribution so already-extended movers don't dominate,
  // and boost stocks showing volume acceleration (institutional entry).
  candidates.sort((a, b) => {
    const volAccelA = a.volumeAcceleration ?? 0;
    const volAccelB = b.volumeAcceleration ?? 0;
    const scoreA = Math.pow(a.intradayRvol, 0.7) * (1 + Math.min(Math.abs(a.changePercent), 5) / 10)
      + volAccelA * 3
      + a.yahooConsensus * 0.3;
    const scoreB = Math.pow(b.intradayRvol, 0.7) * (1 + Math.min(Math.abs(b.changePercent), 5) / 10)
      + volAccelB * 3
      + b.yahooConsensus * 0.3;
    return scoreB - scoreA;
  });

  const topCandidates = candidates.slice(0, 20);
  console.log(`[ScreenerService] Phase 1: ${topCandidates.length} candidates for deep scan.`);

  const results: ScreenerResult[] = [];
  const BATCH_SIZE = 5;

  for (let i = 0; i < topCandidates.length; i += BATCH_SIZE) {
    const batch = topCandidates.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.allSettled(
      batch.map(async c => {
        let rsi14: number | null = null;
        let shortFloatPct: number | null = null;
        let pmVwap: number | null = null;
        let pmHigh: number | null = null;
        let pmLow: number | null = null;

        let volumeAcceleration = 0;
        try {
          const chart1m = await yf.chart(c.ticker, {
            interval: '1m',
            range: '1d',
            includePrePost: true
          });
          const metrics = calculateIntradayMetrics(chart1m);
          pmVwap = metrics.pmVwap;
          pmHigh = metrics.pmHigh;
          pmLow = metrics.pmLow;
          volumeAcceleration = metrics.volumeAcceleration;
          c.volumeAcceleration = volumeAcceleration;
        } catch {
          // ignore intraday chart failure
        }

        // Compute RSI for ALL modes — extension penalty needs RSI regardless of mode
        try {
          const chart1d = await yf.chart(c.ticker, {
            period1: (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d; })(),
            period2: new Date(),
            interval: '1d' as const,
          });
          const closes = (chart1d?.quotes ?? [])
            .filter((q: any) => q.close != null)
            .map((q: any) => q.close as number);
          rsi14 = computeRSI14(closes);
        } catch {}

        if (mode === 'momentum' || mode === 'highdemand' || mode === 'premarket') {
          try {
            const summary = await (yf as any).quoteSummary(c.ticker, {
              modules: ['defaultKeyStatistics', 'assetProfile'],
            });
            const stats = summary?.defaultKeyStatistics;
            if (stats?.shortPercentOfFloat?.raw != null) {
              shortFloatPct = Number((stats.shortPercentOfFloat.raw * 100).toFixed(1));
            }
            if (stats?.floatShares?.raw != null) {
              c.floatTurnover = c.volume / stats.floatShares.raw;
            }
            
            if (mode === 'highdemand') {
              const sharesOut = stats?.sharesOutstanding?.raw as number | undefined;
              if (sharesOut != null && sharesOut >= 20_000_000) {
                throw new Error(`SUPPLY_SKIP: ${c.ticker} shares outstanding ${sharesOut} >= 20M`);
              }
            }
          } catch (err: any) {
            if (err?.message?.startsWith('SUPPLY_SKIP')) throw err;
          }
        }

        const engineResult = await getPredictiveZones(c.ticker);
        return { candidate: c, engineResult, rsi14, shortFloatPct, pmVwap, pmHigh, pmLow, volumeAcceleration };
      }),
    );

    for (const res of batchResults) {
      if (res.status !== 'fulfilled') continue;
      const { candidate, engineResult, rsi14, shortFloatPct, pmVwap, pmHigh, pmLow, volumeAcceleration } = res.value;
      const screenerResult = await evaluateSetup(candidate, engineResult, mode, rsi14, shortFloatPct, pmVwap, pmHigh, pmLow, spyChange, volumeAcceleration);
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
  pmVwap: number | null,
  pmHigh: number | null,
  pmLow: number | null,
  spyChange: number,
  volumeAcceleration: number = 0
): Promise<ScreenerResult | null> {
  const relativeStrength = Number((candidate.changePercent - spyChange).toFixed(2));
  
  let dataQuality: 'VERIFIED' | 'CHECK' | 'SUSPICIOUS' = 'VERIFIED';
  if (candidate.intradayRvol > 100 || Math.abs(candidate.changePercent) > 200) {
    dataQuality = 'SUSPICIOUS';
  } else if (candidate.intradayRvol > 30 || Math.abs(candidate.changePercent) > 50) {
    dataQuality = 'CHECK';
  }

  const reasons: string[] = [];
  let setupScore = 0;
  const factors = engineResult.aiThesis.factors;
  const thesisBias = engineResult.aiThesis.bias;
  const engineConviction = Math.round(engineResult.aiThesis.overallConviction * 100);
  const hasFactor = (keyword: string) => factors.find(f => f.factorName.toLowerCase().includes(keyword.toLowerCase()));

  if (candidate.rvol >= 1) {
    reasons.push(`RVOL ${candidate.rvol.toFixed(1)}x`);
    setupScore += candidate.rvol >= 3 ? 18 : candidate.rvol >= 2 ? 15 : candidate.rvol >= 1.5 ? 10 : 5;
  }
  if (Math.abs(candidate.changePercent) >= 1) {
    reasons.push(`Move ${candidate.changePercent >= 0 ? '+' : ''}${candidate.changePercent.toFixed(1)}%`);
    setupScore += Math.abs(candidate.changePercent) >= 5 ? 12 : Math.abs(candidate.changePercent) >= 3 ? 10 : 5;
  }

  const isGapUp = !!(candidate.openPrice && candidate.prevClose && candidate.openPrice > candidate.prevClose * 1.03 && candidate.changePercent > 0);
  if (isGapUp) {
    reasons.push('Gap & Go');
    setupScore += 12;
  }

  if (pmVwap) {
    if (candidate.price > pmVwap && candidate.changePercent >= 0) {
      reasons.push('Above VWAP');
      setupScore += 10;
    } else if (candidate.price < pmVwap && candidate.changePercent < 0) {
      reasons.push('Below VWAP');
      setupScore += 10;
    }
  }

  if (rsi14 !== null) {
    if (rsi14 >= 60 && rsi14 < 80) setupScore += 8;
    else if (rsi14 <= 40) setupScore += 8;
  }

  if (shortFloatPct !== null && shortFloatPct >= 15) {
    reasons.push(`Short Float ${shortFloatPct.toFixed(1)}%`);
    setupScore += 10;
  }

  const smf = hasFactor('smart money');
  if (smf?.bias === 'bullish') {
    reasons.push('Smart Money Accumulation');
    setupScore += 10;
  } else if (smf?.bias === 'bearish') {
    reasons.push('Smart Money Distribution');
    setupScore += 10;
  }

  const insider = hasFactor('catalyst');
  if (insider?.bias !== 'neutral') {
    reasons.push('Catalyst Detected');
    setupScore += 15;
  }

  let setupType = 'Trend Continuation';
  let setupStage: 'EARLY' | 'DEVELOPING' | 'BREAKOUT' | 'EXTENDED' | 'BREAKDOWN' = 'DEVELOPING';

  // Strict Breakout / Breakdown Classification
  if (candidate.changePercent > 4) {
    if (pmVwap && candidate.price > pmVwap && pmHigh && (pmHigh - candidate.price) / pmHigh < 0.02) {
      setupType = 'Bullish Breakout';
      setupStage = 'BREAKOUT';
    } else if (pmVwap && candidate.price > pmVwap) {
      setupType = 'Bullish Continuation';
      setupStage = 'DEVELOPING';
    } else {
      setupType = 'Weak Gap (Below VWAP)';
      setupStage = 'EARLY';
    }
  } else if (candidate.changePercent < -4) {
    if (pmVwap && candidate.price < pmVwap && pmLow && (candidate.price - pmLow) / pmLow < 0.02) {
      setupType = 'Bearish Breakdown';
      setupStage = 'BREAKDOWN';
    } else {
      setupType = 'Bearish Continuation';
      setupStage = 'DEVELOPING';
    }
  } else {
    if (insider?.bias !== 'neutral') setupType = 'News Catalyst';
    else setupType = 'Accumulation / Base';
  }

  if (Math.abs(candidate.changePercent) > 40 || (rsi14 && rsi14 > 80) || (rsi14 && rsi14 < 20)) {
    setupStage = 'EXTENDED';
  }

  const legacyConfidenceScore = Math.min(98, Math.max(0, Math.round(setupScore * 0.5 + engineConviction * 0.5)));

  const isExtremeMover = candidate.intradayRvol > 50 || Math.abs(candidate.changePercent) > 100;
  if (isExtremeMover) reasons.unshift('⚠️ Extreme Mover');

  const { midasScore, longMomentum, shortMomentum, direction, probability, riskScore, subScores } = await calculateMidasScore(
    candidate.ticker,
    candidate.price,
    candidate.changePercent,
    candidate.rvol,
    candidate.intradayRvol,
    legacyConfidenceScore,
    mode,
    candidate.volume,
    candidate.floatTurnover,
    rsi14,
    volumeAcceleration
  );
  
  const threshold = mode === 'premarket' ? 45 : 60;
  if (midasScore < threshold && riskScore < 80 && Math.max(longMomentum, shortMomentum) < 80) return null;

  return {
    symbol: candidate.ticker,
    direction,
    setupType,
    setupStage,
    midasScore,
    longMomentum,
    shortMomentum,
    probability,
    riskScore,
    subScores,
    price: candidate.price,
    changePercent: candidate.changePercent,
    relativeStrength,
    volume: candidate.volume,
    dollarVolume: candidate.dollarVolume,
    rvol: Number(candidate.intradayRvol.toFixed(2)),
    pmVwap: pmVwap ? Number(pmVwap.toFixed(2)) : undefined,
    pmHigh: pmHigh ? Number(pmHigh.toFixed(2)) : undefined,
    pmLow: pmLow ? Number(pmLow.toFixed(2)) : undefined,
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
