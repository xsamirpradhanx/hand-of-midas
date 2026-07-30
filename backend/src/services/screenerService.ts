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
  reasons: string[];
}

export type ScreenerMode = 'premarket' | 'open';

const DEFAULT_UNIVERSE = [
  'SPY', 'QQQ', 'IWM', 'AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMD', 'AMZN', 'META',
  'GOOGL', 'PLTR', 'NFLX', 'SMCI', 'COIN', 'MSTR', 'MARA', 'RIOT', 'BA', 'DIS',
  'UBER', 'CRWD', 'PANW', 'ARM', 'MU', 'INTC', 'GME', 'AMC', 'HOOD', 'SOFI',
];

interface Candidate {
  ticker: string;
  price: number;
  changePercent: number;
  volume: number;
  rvol: number;
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

export async function runScreener(mode: ScreenerMode): Promise<ScreenerResult[]> {
  console.log(`[ScreenerService] Starting scan for ${mode} via Yahoo Finance...`);

  let rawQuotes: Record<string, unknown>[] = [];
  try {
    const batch = await yf.quote(DEFAULT_UNIVERSE);
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
    const change = (q['regularMarketChange'] as number) ?? price - prevClose;
    const changePercent =
      (q['regularMarketChangePercent'] as number) ??
      (prevClose !== 0 ? (change / prevClose) * 100 : 0);
    const volume = (q['regularMarketVolume'] as number) ?? 0;
    const adv = averageDailyVolume(q);
    const rvol = computeRvol(volume, adv);

    if (!symbol || price < 2 || volume < 50_000) continue;

    enrichedCandidates.push({
      ticker: symbol,
      price,
      changePercent,
      volume,
      rvol,
    });
  }

  let candidates = enrichedCandidates;

  if (mode === 'premarket') {
    candidates = candidates.filter(c => Math.abs(c.changePercent) >= 1);
  } else {
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
        const engineResult = await getPredictiveZones(c.ticker);
        return { candidate: c, engineResult };
      }),
    );

    for (const res of batchResults) {
      if (res.status !== 'fulfilled') {
        console.warn('[ScreenerService] Batch item failed:', res.reason);
        continue;
      }
      const screenerResult = evaluateSetup(res.value.candidate, res.value.engineResult, mode);
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
): ScreenerResult | null {
  const factors = engineResult.aiThesis.factors;
  const thesisBias = engineResult.aiThesis.bias;
  const engineConviction = Math.round(engineResult.aiThesis.overallConviction * 100);

  const reasons: string[] = [];
  let setupScore = 0;

  const hasFactor = (keyword: string) =>
    factors.find(f => f.factorName.toLowerCase().includes(keyword.toLowerCase()));

  if (candidate.rvol >= 1) {
    reasons.push(`RVOL ${candidate.rvol.toFixed(1)}x`);
    setupScore += candidate.rvol >= 2 ? 15 : candidate.rvol >= 1.5 ? 10 : 5;
  }

  if (Math.abs(candidate.changePercent) >= 1) {
    reasons.push(`Move ${candidate.changePercent >= 0 ? '+' : ''}${candidate.changePercent.toFixed(1)}%`);
    setupScore += Math.abs(candidate.changePercent) >= 3 ? 10 : 5;
  }

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
    reasons.push('Smart Money Flow Accumulation');
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

  let setupType = 'Trend Continuation';

  if (mode === 'premarket') {
    setupType = Math.abs(candidate.changePercent) >= 3 ? 'Relative Volume Gap' : 'Momentum Catalyst';
    if (insider?.bias === 'bullish') {
      setupType = 'News Catalyst';
      reasons.push('News/Insider Catalyst');
      setupScore += 15;
    }
  } else if (squeeze && squeeze.bias !== 'neutral' && hurstVal !== null && hurstVal > 0.55) {
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

  // Blend rule-based setup score with predictive engine conviction
  const confidenceScore = Math.min(
    98,
    Math.max(0, Math.round(setupScore * 0.45 + engineConviction * 0.55)),
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
    reasons,
  };
}
