import { getTickerNews, PolygonNewsArticle } from './polygon.js';
import { getTimeSeriesYahoo } from './yahoo.js';
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
import { IvRvRatioFactor } from './factors/ivRvRatio.js';
import { MaxPainDriftFactor } from './factors/maxPainDrift.js';
import { VannaDeltaPressureFactor } from './factors/vannaDeltaPressure.js';
import { SmartMoneyFlowFactor } from './factors/smartMoneyFlow.js';
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

// Complete Registry of 16 modular quantitative factor plugins
// (12 original + 4 new institutional alpha factors from the quant audit)
const registeredFactors: PredictiveFactor[] = [
  // ── Price Action & Volume ──────────────────────────────────────────────────
  new VolumeProfileFactor(),
  new AnchoredVwapFactor(),
  new EstimatedCvdFactor(),
  new HvlrSupportFactor(),
  new AtrVolatilityFactor(),
  // ── Regime & Momentum ─────────────────────────────────────────────────────
  new HurstExponentFactor(),
  new KamaZScoreFactor(),
  // ── Options & Dealer Dynamics ─────────────────────────────────────────────
  new DealerHedgingFactor(),        // Multi-expiry GEX + interpolated flip
  new OptionsSqueezeFactor(),
  new RiskReversalSkewFactor(),
  new TermStructureFactor(),
  // ── New Institutional Alpha Factors ───────────────────────────────────────
  new IvRvRatioFactor(),            // IV/RV ratio — volatility premium edge
  new MaxPainDriftFactor(),         // Max pain gravitational drift near OpEx
  new VannaDeltaPressureFactor(),   // Vanna-driven MM spot hedging pressure
  new SmartMoneyFlowFactor(),       // Smart money vs retail flow decoupling
  // ── News & Catalyst ───────────────────────────────────────────────────────
  new InsiderCatalystFactor(),
];

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
      priceTop: synthesis.buyZone.top,
      priceBottom: synthesis.buyZone.bottom,
      convictionScore: synthesis.overallConviction,
    },
    {
      type: 'sell',
      priceTop: synthesis.sellZone.top,
      priceBottom: synthesis.sellZone.bottom,
      // Previously artificially halved — both zones now reflect the same underlying conviction
      convictionScore: synthesis.overallConviction,
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
