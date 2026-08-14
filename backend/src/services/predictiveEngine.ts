import { getTickerNews, PolygonNewsArticle } from './polygon.js';
import { getTimeSeriesYahoo } from './yahoo.js';
import { fetchOptionsChainWithFallback } from './optionsFallback.js';
import type { FactorResult, FactorInput, PredictiveFactor } from './factors/types.js';
import { getFactors } from './factors/factorRegistry.js';
import { CompositeScoreAgent } from './compositeScore.js';
import { putItem, getItem } from './dynamodb.js';
import type { FactorStatsItem, SetupStatsItem } from '../types.js';
import { calibratePrediction, learningKey, type LearningAssessment } from './quant/learningEngine.js';
import { generateGroundedTradeNarrative } from './tradeNarrative.js';
import { buildSymbolProfile, applySymbolProfile } from './quant/symbolProfile.js';

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
    aiSynthesis?: string;
    bias: 'bullish' | 'bearish' | 'neutral';
    overallConviction: number;
    /** Conviction derived from independent evidence (not synthetic). 0–1. */
    modelConviction: number;
    /** Always null until empirical data available. */
    historicalWinProbability: null;
    learning: LearningAssessment;
    priceRationale: {
      targetPrice: number;
      targetType: 'support' | 'resistance' | 'none';
      targetSources: string[];
      invalidationPrice: number;
      explanation: string;
    };
    aiNarrative: string;
    /** Agreement between evidence buckets. */
    signalAgreement: number;
    agreementLevel: 'HIGH' | 'MODERATE' | 'LOW';
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

export async function getPredictiveZones(symbol: string, activeExpiry?: string): Promise<PredictiveEngineResult> {
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
    activeExpiry,
    news,
  };

  // 4. Run all factor modules in parallel
  const factorEvaluations = await Promise.all(
    registeredFactors.map(f => f.evaluate(factorInput).catch(err => {
      console.warn(`[PredictiveEngine] Factor ${f.name} failed for ${sym}:`, err);
      return null;
    }))
  );

  let activeFactors = factorEvaluations.filter((res): res is FactorResult => res !== null);

  try {
    const profile = await buildSymbolProfile(sym, bars, news);
    activeFactors = applySymbolProfile(activeFactors, profile);
  } catch (err) {
    console.warn(`[PredictiveEngine] SymbolProfile failed for ${sym}:`, err);
  }

  // 5. Fetch Factor Stats
  let factorStats: Record<string, { wins: number; losses: number; score: number; tries: number }> | undefined;
  let setupStats: SetupStatsItem['stats'] | undefined;
  try {
    const factorStatsItem = await getItem<FactorStatsItem>('SYSTEM', 'FACTOR_STATS');
    if (factorStatsItem) factorStats = factorStatsItem.stats;
  } catch (err) {
    console.warn(`[PredictiveEngine] Could not fetch FACTOR_STATS:`, err);
  }
  try {
    setupStats = (await getItem<SetupStatsItem>('SYSTEM', 'SETUP_STATS'))?.stats;
  } catch (err) {
    console.warn(`[PredictiveEngine] Could not fetch learning stats: ${String(err)}`);
  }

  // 6. Run AI Synthesis Agent over all factor outputs
  // Pass `bars` so the agent can compute ATR-adaptive zone spread
  const synthesis = await aiAgent.synthesize(sym, currentPrice, activeFactors, bars, factorStats, news);

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

  const plan = synthesis.tradePlan;
  const learning = calibratePrediction(
    synthesis.modelConviction,
    plan ? setupStats?.[learningKey(plan.bias)] : undefined,
  );
  const targetPrice = !plan || plan.bias === 'NO TRADE'
    ? currentPrice
    : plan.bias === 'LONG' ? plan.majorResistance : plan.stretchTarget;
  const targetSources = !plan || plan.bias === 'NO TRADE'
    ? []
    : plan.bias === 'LONG' ? synthesis.supplyZone.confluence : synthesis.demandZone.confluence;
  const priceRationale = {
    targetPrice,
    targetType: (!plan || plan.bias === 'NO TRADE' ? 'none' : plan.bias === 'LONG' ? 'resistance' : 'support') as 'support' | 'resistance' | 'none',
    targetSources,
    invalidationPrice: plan?.stop ?? currentPrice,
    explanation: !plan || plan.bias === 'NO TRADE'
      ? 'No executable setup: evidence, location, or reward-to-risk did not clear the trade filter.'
      : `Target $${targetPrice} is the nearest ${plan.bias === 'LONG' ? 'supply/resistance' : 'demand/support'} cluster supported by ${targetSources.join(', ') || 'price structure'}. Invalidation is $${plan.stop}; a break there invalidates the setup.`,
  };
  let aiNarrative = 'No executable setup: evidence, location, or reward-to-risk did not clear the trade filter.';
  if (plan?.bias && plan.bias !== 'NO TRADE') {
    aiNarrative = await generateGroundedTradeNarrative({
      symbol: sym, currentPrice, bias: plan.bias, target: targetPrice,
      stop: plan.stop ?? currentPrice, trigger: plan.trigger ?? currentPrice, factors: activeFactors,
    });
  }

  const result: PredictiveEngineResult = {
    symbol: sym,
    currentPrice,
    zones,
    aiThesis: {
      summary: synthesis.summary,
      aiSynthesis: synthesis.aiSynthesis,
      bias: synthesis.bias,
      overallConviction: synthesis.overallConviction,
      modelConviction: synthesis.modelConviction,
      historicalWinProbability: null,
      learning,
      priceRationale,
      aiNarrative,
      signalAgreement: synthesis.signalAgreement,
      agreementLevel: synthesis.agreementLevel,
      factors: activeFactors,
      tradePlan: synthesis.tradePlan,
    },
  };



  return result;
}
