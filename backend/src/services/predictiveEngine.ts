import { getTickerNews, PolygonNewsArticle } from './polygon.js';
import { getTimeSeriesYahoo } from './yahoo.js';
import { fetchOptionsChainWithFallback } from './optionsFallback.js';
import type { FactorResult, FactorInput, PredictiveFactor } from './factors/types.js';
import { getFactors } from './factors/factorRegistry.js';
import { CompositeScoreAgent } from './compositeScore.js';

export interface PredictiveZone {
  type: 'buy' | 'sell';
  priceTop: number;
  priceBottom: number;
  convictionScore: number;
  confluence: string[];
}

export interface PredictiveEngineResult {
  symbol: string;
  currentPrice: number;
  zones: PredictiveZone[];
  aiThesis: {
    summary: string;
    bias: 'bullish' | 'bearish' | 'neutral';
    overallConviction: number;
    factors: FactorResult[];
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
  };
}

const aiAgent = new CompositeScoreAgent();

// Complete Registry of 16 modular quantitative factor plugins
// (12 original + 4 new institutional alpha factors from the quant audit)
const registeredFactors: PredictiveFactor[] = getFactors();

export async function getPredictiveZones(symbol: string): Promise<PredictiveEngineResult> {
  const sym = symbol.toUpperCase();

  // 1. Fetch OHLCV (6 months / 126 trading days)
  const bars = await getTimeSeriesYahoo(sym, '1d', 126);
  if (!bars || bars.length === 0) {
    throw new Error(`Insufficient historical price data found for ticker ${sym}`);
  }

  const currentPrice = bars[bars.length - 1].close;

  // 2. Fetch Options Chain safely (graceful fallback if unsupported/empty)
  let optionsChain: { expirations: string[]; contracts: any[] } | undefined;
  try {
    optionsChain = await fetchOptionsChainWithFallback(sym);
  } catch (err) {
    console.warn(`[PredictiveEngine] Options chain unavailable for ${sym}, proceeding with price action factors:`, err);
  }

  // 3. Fetch News safely
  let news: PolygonNewsArticle[] | undefined;
  try {
    await new Promise(resolve => setTimeout(resolve, Math.random() * 750));
    news = await getTickerNews(sym, 15);
  } catch (err) {
    console.warn(`[PredictiveEngine] News unavailable for ${sym}, proceeding without news sentiment: ${err instanceof Error ? err.message : String(err)}`);
  }

  const factorInput: FactorInput = {
    symbol: sym,
    currentPrice,
    bars,
    optionsChain,
    news,
  };

  // 4. Run all factor modules in parallel
  const factorEvaluations = await Promise.all(
    registeredFactors.map(f => f.evaluate(factorInput).catch(err => {
      console.warn(`[PredictiveEngine] Factor ${f.name} failed for ${sym}:`, err);
      return null;
    }))
  );

  const activeFactors = factorEvaluations.filter((res): res is FactorResult => res !== null);

  // 5. Run AI Synthesis Agent over all factor outputs
  // Pass `bars` so the agent can compute ATR-adaptive zone spread
  const synthesis = aiAgent.synthesize(sym, currentPrice, activeFactors, bars);

  const zones: PredictiveZone[] = [
    {
      type: 'buy',
      priceTop: synthesis.demandZone.top,
      priceBottom: synthesis.demandZone.bottom,
      convictionScore: synthesis.overallConviction,
      confluence: synthesis.demandZone.confluence,
    },
    {
      type: 'sell',
      priceTop: synthesis.supplyZone.top,
      priceBottom: synthesis.supplyZone.bottom,
      // Previously artificially halved — both zones now reflect the same underlying conviction
      convictionScore: synthesis.overallConviction,
      confluence: synthesis.supplyZone.confluence,
    },
  ];

  return {
    symbol: sym,
    currentPrice,
    zones,
    aiThesis: {
      summary: synthesis.summary,
      bias: synthesis.bias,
      overallConviction: synthesis.overallConviction,
      factors: activeFactors,
      tradePlan: synthesis.tradePlan,
    },
  };
}
