import { yf } from './yahoo.js';
import { getPredictiveZones } from './predictiveEngine.js';
import { putItem, getItem } from './dynamodb.js';
import type { PredictionItem, SetupStatsItem } from '../types.js';
import { evaluateEventRisk } from './quant/eventRiskEngine.js';
import { evaluateTrigger, triggerStateLabel } from './quant/triggerEngine.js';

export interface ScreenerResult {
  symbol: string;
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  setupType: string;
  setupStage: 'EARLY' | 'DEVELOPING' | 'BREAKOUT' | 'EXTENDED' | 'BREAKDOWN';
  midasScore: number;
  longMomentum: number;
  shortMomentum: number;
  /** Always null — midasModel.ts deprecated this; it's candidate quality, not a win probability. */
  probability: null;
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
  
  // P1 Engine Updates
  tradeScore: number;
  opportunityScore: number;
  location: string;
  sentimentScore?: number;
  
  // Phase 1 Statistical Metrics
  eventRisk: 'HIGH' | 'MEDIUM' | 'LOW';
  eventRiskReasons?: string[];
  marketRegime: string;
  triggerStatus: string;
  expectedR: number;
  adjustedEV: number;

  modelPT1: number;
  modelPStop: number;
  modelPTimeout: number;
  modelSampleSize: number;

  tradePlan?: {
    bias: 'LONG' | 'SHORT' | 'NO TRADE';
    archetype: string;
    trigger: number;
    entryZone: string;
    chasePrice: number;
    expectedMove: number;
    majorResistance: number;
    stretchTarget: number;
    stop: number;
    rewardRisk: number;
    roomToResistance: number;
    roomToSupport: number;
    confirmation: string;
    invalidation: string;
    whyNow: string;
    confidence: number;
  };
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
  adv: number;
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

function calculateIntradayMetrics(chart: any): { pmVwap: number | null, pmHigh: number | null, pmLow: number | null, volumeAcceleration: number, totalVolume: number } {
  if (!chart?.quotes || chart.quotes.length === 0) return { pmVwap: null, pmHigh: null, pmLow: null, volumeAcceleration: 0, totalVolume: 0 };
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

  return { pmVwap, pmHigh: high === -Infinity ? null : high, pmLow: low === Infinity ? null : low, volumeAcceleration, totalVolume: cumVol };
}

export async function runScreener(mode: ScreenerMode = 'open'): Promise<ScreenerResult[]> {
  // buildActiveMarketUniverse takes no arguments — it fetches the same broad
  // Yahoo-screener universe regardless of mode; mode-specific filtering
  // happens below against that universe, not at fetch time.
  const universeCandidates = await buildActiveMarketUniverse();
  
  if (universeCandidates.length === 0) {
    console.log(`[ScreenerService] Universe empty for mode ${mode}.`);
    return [];
  }

  // P2: Fetch historical empirical stats for regime/setup grading
  let setupStats: Record<string, { wins: number; tries: number }> = {};
  try {
    const item = await getItem<SetupStatsItem>('SYSTEM', 'SETUP_STATS');
    if (item && item.stats) setupStats = item.stats;
  } catch (err) {
    console.warn('[ScreenerService] Could not fetch SETUP_STATS:', err);
  }

  // Get SPY context for relative strength & regime
  const spyQuote = await yf.quote('SPY');

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
      adv,
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
   // Phase 1: Cheap first-pass ranking (volume leads price)
  candidates.sort((a, b) => {
    // If volume data is missing (common in premarket), prioritize actual price change to ensure movers pass phase 1
    const scoreA = Math.pow(Math.max(1, a.intradayRvol), 0.7) * (1 + Math.min(Math.abs(a.changePercent), 5) / 10) 
                 + (a.volume === 0 ? Math.abs(a.changePercent) : 0) 
                 + a.yahooConsensus * 0.3;
    const scoreB = Math.pow(Math.max(1, b.intradayRvol), 0.7) * (1 + Math.min(Math.abs(b.changePercent), 5) / 10) 
                 + (b.volume === 0 ? Math.abs(b.changePercent) : 0) 
                 + b.yahooConsensus * 0.3;
    return scoreB - scoreA;
  });

  const phase1Candidates = candidates.slice(0, 50);
  console.log(`[ScreenerService] Phase 1: ${phase1Candidates.length} candidates advanced.`);

  // Phase 2: Fetch 1m intraday data to calculate volume acceleration and VWAP distance
  const phase2Candidates: (Candidate & { pmVwap: number | null, pmHigh: number | null, pmLow: number | null, volumeAcceleration: number })[] = [];
  const BATCH_SIZE_P2 = 10;
  
  for (let i = 0; i < phase1Candidates.length; i += BATCH_SIZE_P2) {
    const batch = phase1Candidates.slice(i, i + BATCH_SIZE_P2);
    const batchResults = await Promise.allSettled(
      batch.map(async c => {
        let pmVwap: number | null = null;
        let pmHigh: number | null = null;
        let pmLow: number | null = null;
        let volumeAcceleration = 0;

        try {
          // yahoo-finance2's chart() schema requires period1 (start) — it rejects the
          // `range` shorthand this used to pass, so every Phase 2 fetch here was
          // throwing and getting swallowed by the catch below: pmVwap/pmHigh/pmLow and
          // volumeAcceleration silently stayed null/0 for every candidate on every
          // scan. 2 days back comfortably covers today's session (including
          // pre-market) even right after a weekend; calculateIntradayMetrics filters
          // to the current session itself.
          const period1 = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
          const chart1m = await yf.chart(c.ticker, { interval: '1m', period1, includePrePost: true });
          const metrics = calculateIntradayMetrics(chart1m);
          pmVwap = metrics.pmVwap;
          pmHigh = metrics.pmHigh;
          pmLow = metrics.pmLow;
          volumeAcceleration = metrics.volumeAcceleration;
          
          if (c.volume === 0 && metrics.totalVolume > 0) {
            c.volume = metrics.totalVolume;
            c.dollarVolume = c.price * c.volume;
            c.rvol = computeRvol(c.volume, c.adv);
            c.intradayRvol = computeIntradayRvol(c.volume, c.adv);
          }
        } catch {
          // ignore intraday chart failure
        }
        return { ...c, pmVwap, pmHigh, pmLow, volumeAcceleration };
      })
    );

    for (const res of batchResults) {
      if (res.status === 'fulfilled') {
        phase2Candidates.push(res.value);
      }
    }
  }

  // Phase 2 Ranking: Now we actually have volume acceleration!
  phase2Candidates.sort((a, b) => {
    const scoreA = Math.pow(a.intradayRvol, 0.7) * (1 + Math.min(Math.abs(a.changePercent), 5) / 10) + a.volumeAcceleration * 3 + a.yahooConsensus * 0.3;
    const scoreB = Math.pow(b.intradayRvol, 0.7) * (1 + Math.min(Math.abs(b.changePercent), 5) / 10) + b.volumeAcceleration * 3 + b.yahooConsensus * 0.3;
    return scoreB - scoreA;
  });

  const topCandidates = phase2Candidates.slice(0, 20);
  console.log(`[ScreenerService] Phase 2: ${topCandidates.length} candidates advanced to Deep Scan.`);

  // Phase 3: Deep Analysis (Options, Factors, Predictive Engine)
  const results: ScreenerResult[] = [];
  const BATCH_SIZE = 5;

  for (let i = 0; i < topCandidates.length; i += BATCH_SIZE) {
    const batch = topCandidates.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.allSettled(
      batch.map(async c => {
        let rsi14: number | null = null;
        let shortFloatPct: number | null = null;

        // Compute RSI
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

        // Pass the screener's own live quote through so compositeScore's trade-plan
        // geometry (trigger, chase price, overextension gate) and the trigger
        // evaluation below (which uses candidate.price) look at the exact same
        // price — otherwise a gap between them could hide overextension on gap days.
        const engineResult = await getPredictiveZones(c.ticker, undefined, c.price);
        return { candidate: c, engineResult, rsi14, shortFloatPct };
      })
    );

    for (const res of batchResults) {
      if (res.status !== 'fulfilled') continue;
      const { candidate, engineResult, rsi14, shortFloatPct } = res.value;
      const screenerResult = await evaluateSetup(
        candidate, 
        engineResult, 
        mode, 
        rsi14, 
        shortFloatPct, 
        candidate.pmVwap, 
        candidate.pmHigh, 
        candidate.pmLow, 
        spyChange, 
        candidate.volumeAcceleration,
        setupStats
      );
      
      const threshold = mode === 'premarket' ? 45 : 60;
      if (screenerResult && screenerResult.midasScore >= threshold) {
        results.push(screenerResult);
      }
    }
  }

  results.sort((a, b) => {
    const getSortScore = (r: ScreenerResult) => {
      if (r.eventRisk === 'HIGH') return -100;
      if (r.expectedR < 0.25 || r.triggerStatus === 'NO TRADE') return -50;
      return r.adjustedEV;
    };
    return getSortScore(b) - getSortScore(a);
  });
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
  volumeAcceleration: number = 0,
  setupStats: Record<string, { wins: number; tries: number }> = {}
): Promise<ScreenerResult | null> {
  const relativeStrength = Number((candidate.changePercent - spyChange).toFixed(2));
  
  let marketRegime = 'Neutral';
  if (spyChange > 0.5) marketRegime = 'Risk-On';
  else if (spyChange < -0.5) marketRegime = 'Risk-Off';
  
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

  // 2D Matrix Classification (P2)
  if (pmVwap) {
    if (relativeStrength >= 5) {
      if (candidate.price < pmVwap) {
        setupType = 'Dislocation';
        setupStage = 'EARLY';
      } else {
        setupType = 'Pullback';
        setupStage = 'DEVELOPING';
      }
    } else if (relativeStrength <= -5) {
      if (candidate.price < pmVwap) {
        setupType = 'Weakness';
        setupStage = 'DEVELOPING';
      } else {
        setupType = 'Fade';
        setupStage = 'EARLY';
      }
    } else {
      // Neutral RS
      if (candidate.price < pmVwap) {
        setupType = 'Below VWAP';
      } else {
        setupType = 'Above VWAP';
      }
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

  // ── P0: Calculate Trade Score ──
  let tsTrend = Math.min(100, Math.max(0, subScores.momentumQuality));
  let tsVolume = Math.min(100, candidate.intradayRvol * 15);
  let tsRS = Math.min(100, Math.max(0, 50 + relativeStrength * 10));
  let tsCatalyst = insider?.bias !== 'neutral' ? 100 : smf ? 80 : 50;
  let tsLiquidity = Math.min(100, candidate.dollarVolume / 1_000_000);
  
  let tsStructure = engineResult.aiThesis.tradePlan?.bias !== 'NO TRADE' ? 90 : 30;
  let tsLocation = 50;
  let tsRR = 0;
  
  const tp = engineResult.aiThesis.tradePlan;
  if (tp) {
    if (tp.rewardRisk >= 3) tsRR = 100;
    else if (tp.rewardRisk >= 2) tsRR = 80;
    else if (tp.rewardRisk >= 1.5) tsRR = 60;
    else tsRR = 0;
    
    if (pmVwap) {
      const vwapDist = Math.abs(candidate.price - pmVwap) / pmVwap;
      if (vwapDist < 0.01) tsLocation = 95;
      else if (vwapDist < 0.02) tsLocation = 80;
      else if (vwapDist < 0.05) tsLocation = 40;
      else tsLocation = 20;
    }
  }

  const tradeScore = Math.round(
    tsTrend * 0.15 +
    tsVolume * 0.15 +
    tsRS * 0.10 +
    tsStructure * 0.20 +
    tsLocation * 0.15 +
    tsRR * 0.15 +
    tsCatalyst * 0.05 +
    tsLiquidity * 0.05
  );

  let locationStrParts = [];
  if (pmVwap) {
    const vwapDistPct = (((candidate.price - pmVwap) / pmVwap) * 100).toFixed(1);
    locationStrParts.push(`${Math.abs(Number(vwapDistPct))}% ${candidate.price > pmVwap ? 'above' : 'below'} VWAP`);
  }
  if (pmHigh && candidate.price < pmHigh) {
    const pmHighDist = (((pmHigh - candidate.price) / candidate.price) * 100).toFixed(1);
    locationStrParts.push(`${pmHighDist}% below PM high`);
  }
  if (tp && tp.roomToResistance > 0) {
    locationStrParts.push(`${tp.roomToResistance}% below resistance`);
  }
  let locationStr = locationStrParts.length > 0 ? locationStrParts.join(', ') : 'Consolidating';

  // P1 Trade Opportunity Score
  let oppScore = Math.round(
    tradeScore * 0.25 +
    tsRR * 0.20 +
    tsLocation * 0.15 +
    Math.max(longMomentum, shortMomentum) * 0.15 +
    Math.min(100, candidate.intradayRvol * 10) * 0.10 +
    Math.min(100, Math.max(0, 50 + relativeStrength * 5)) * 0.10 +
    50 * 0.05 // default sentiment score placeholder
  );

  // Apply Hard Penalties
  if (tp && tp.rewardRisk < 1.0) oppScore -= 30;
  if (isExtremeMover || (tp && tp.roomToSupport > 15)) oppScore -= 20;
  if (tp && tp.bias === 'LONG' && pmVwap && candidate.price < pmVwap) oppScore -= 10;
  if (candidate.dollarVolume < 2_000_000) oppScore -= 15;

  const opportunityScore = Math.max(0, Math.min(100, oppScore));

  // ── EventRiskEngine (authoritative source for event risk) ─────────────────
  const eventRiskResult = evaluateEventRisk({
    symbol: candidate.ticker,
    rvol: candidate.rvol,
    intradayRvol: candidate.intradayRvol,
    changePercent: candidate.changePercent,
    volumeAcceleration,
    newsCount: engineResult.aiThesis.factors.filter(f => f.bucket === 'CATALYST').length,
    insiderFactor: insider ?? null,
  });
  const eventRisk = eventRiskResult.level === 'NONE' ? 'LOW' : eventRiskResult.level;
  const eventRiskReasons = eventRiskResult.reasons;



  let expectedR = 0;
  let adjustedEV = 0;
  let triggerStatus = 'WAIT FOR TRIGGER';
  
  let modelPT1 = 0;
  let modelPStop = 0;
  let modelPTimeout = 0;
  let modelSampleSize = 0;

  if (tp && tp.bias !== 'NO TRADE') {
    // Use modelConviction from synthesis (not synthetic probability)
    modelPT1 = engineResult.aiThesis.modelConviction ?? (engineConviction / 100);
    
    // P2: Override with Empirical Win Rate if sufficient historical data
    const setupKey = `${marketRegime}|${setupType}`;
    if (setupStats[setupKey] && setupStats[setupKey].tries >= 3) {
      modelSampleSize = setupStats[setupKey].tries;
      modelPT1 = setupStats[setupKey].wins / setupStats[setupKey].tries;
    }

    modelPTimeout = 0.05;
    modelPStop = Math.max(0, 1 - modelPT1 - modelPTimeout);
    
    expectedR = (modelPT1 * tp.rewardRisk) - (modelPStop * 1.0);
    adjustedEV = expectedR * (legacyConfidenceScore / 100);

    // ── TriggerEngine (authoritative source for trigger state) ───────────────
    const cvdFactor = engineResult.aiThesis.factors.find(f => f.correlationGroup === 'CVD');
    const triggerState = evaluateTrigger({
      currentPrice: candidate.price,
      tradePlanBias: tp.bias,
      triggerPrice: tp.trigger,
      chasePrice: tp.chasePrice,
      stop: tp.stop,
      rewardRisk: tp.rewardRisk,
      pmVwap,
      volumeAcceleration,
      cvdBias: cvdFactor?.bias,
    });
    triggerStatus = triggerStateLabel(triggerState);
    
    // Phase 1: Persist prediction to DynamoDB
    try {
      const timestamp = new Date().toISOString();
      const vwapDistPct = pmVwap ? Number((((candidate.price - pmVwap) / pmVwap) * 100).toFixed(2)) : undefined;
      
      const predictionItem: PredictionItem = {
        pk: `PREDICTION#${candidate.ticker}`,
        sk: `TIMESTAMP#${timestamp}`,
        symbol: candidate.ticker,
        currentPrice: candidate.price,
        zones: engineResult.zones,
        aiThesis: engineResult.aiThesis,
        createdAt: timestamp,
        marketRegime,
        setupType,
        rvol: candidate.intradayRvol,
        relativeStrength,
        vwapDistancePct: vwapDistPct,
        eventRisk: eventRisk as 'HIGH' | 'MEDIUM' | 'LOW',
        entry: tp.trigger,
        stop: tp.stop,
        target: tp.bias === 'LONG' ? tp.majorResistance : tp.stretchTarget,
      };
      await putItem(predictionItem);
    } catch (err) {
      console.error(`[ScreenerService] Failed to persist prediction for ${candidate.ticker}:`, err);
    }
  } else {
    triggerStatus = 'NO TRADE';
    if (tp) {
      setupType = '⚠️ ' + setupType;
    }
  }

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
    tradeScore,
    opportunityScore,
    location: locationStr,
    eventRisk,
    eventRiskReasons,
    marketRegime,
    triggerStatus,
    expectedR,
    adjustedEV,
    modelPT1,
    modelPStop,
    modelPTimeout,
    modelSampleSize,
    tradePlan: tp,
  };
}
