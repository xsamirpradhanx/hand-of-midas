import { getTimeSeries, getTickerNews, PolygonNewsArticle } from './polygon.js';
import { fetchOptionsChainWithFallback } from './optionsFallback.js';
import type { FactorResult, FactorInput, PredictiveFactor } from './factors/types.js';
import { VolumeProfileFactor } from './factors/volumeProfile.js';
import { AtrVolatilityFactor } from './factors/atrVolatility.js';
import { DealerHedgingFactor } from './factors/dealerHedging.js';
import { AnchoredVwapFactor } from './factors/anchoredVwap.js';
import { EstimatedCvdFactor } from './factors/estimatedCvd.js';
import { HvlrSupportFactor } from './factors/hvlrSupport.js';
import { OptionsSqueezeFactor } from './factors/squeezeScore.js';
import { RiskReversalSkewFactor } from './factors/riskReversalSkew.js';
import { TermStructureFactor } from './factors/termStructure.js';
import { HurstExponentFactor } from './factors/hurstExponent.js';
import { KamaZScoreFactor } from './factors/kamaZScore.js';
import { InsiderCatalystFactor } from './factors/insiderCatalyst.js';
import { CompositeScoreAgent } from './compositeScore.js';

export interface PredictiveZone {
  type: 'buy' | 'sell';
  priceTop: number;
  priceBottom: number;
  convictionScore: number;
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
  };
}

const aiAgent = new CompositeScoreAgent();

// Complete Registry of 12 modular quantitative factor plugins
const registeredFactors: PredictiveFactor[] = [
  new VolumeProfileFactor(),
  new AnchoredVwapFactor(),
  new EstimatedCvdFactor(),
  new HvlrSupportFactor(),
  new AtrVolatilityFactor(),
  new DealerHedgingFactor(),
  new OptionsSqueezeFactor(),
  new RiskReversalSkewFactor(),
  new TermStructureFactor(),
  new HurstExponentFactor(),
  new KamaZScoreFactor(),
  new InsiderCatalystFactor(),
];

export async function getPredictiveZones(symbol: string): Promise<PredictiveEngineResult> {
  const sym = symbol.toUpperCase();

  // 1. Fetch OHLCV (6 months / 126 trading days)
  const bars = await getTimeSeries(sym, '1d', 126);
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
    news = await getTickerNews(sym, 15);
  } catch (err) {
    console.warn(`[PredictiveEngine] News unavailable for ${sym}, proceeding without news sentiment:`, err);
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
  const synthesis = aiAgent.synthesize(sym, currentPrice, activeFactors);

  const zones: PredictiveZone[] = [
    {
      type: 'buy',
      priceTop: synthesis.buyZone.top,
      priceBottom: synthesis.buyZone.bottom,
      convictionScore: synthesis.overallConviction,
    },
    {
      type: 'sell',
      priceTop: synthesis.sellZone.top,
      priceBottom: synthesis.sellZone.bottom,
      convictionScore: Number((1 - (synthesis.overallConviction * 0.5)).toFixed(2)),
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
    },
  };
}
