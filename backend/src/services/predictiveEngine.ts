import { getTickerNews, PolygonNewsArticle } from './polygon.js';
import { fetchBarsWithFallback } from './marketData/fetchBars.js';
import { fetchOptionsChainWithFallback } from './optionsFallback.js';
import type { FactorResult, FactorInput, PredictiveFactor } from './factors/types.js';

/**
 * Daily bars fetched per symbol, and the benchmark they are compared against.
 *
 * 300 covers the longest factor lookback in the stack (Relative Momentum's
 * 252-bar window plus a 21-bar skip) with headroom for holidays and listing
 * gaps.
 */
const DAILY_BAR_COUNT = 300;
const BENCHMARK_SYMBOL = 'SPY';

/** Learning namespace for this engine — never share a keyspace with the screener. */
const TRADE_PLAN_SOURCE = 'TRADE_PLAN' as const;
import { getFactors } from './factors/factorRegistry.js';
import { CompositeScoreAgent } from './compositeScore.js';
import { putItem, getItem } from './dynamodb.js';
import type { FactorStatsItem, SetupStatsItem, OHLCVDataPoint } from '../types.js';
import { calibratePrediction, learningKey, type LearningAssessment } from './quant/learningEngine.js';
import { generateGroundedTradeNarrative } from './tradeNarrative.js';
import { buildSymbolProfile, applySymbolProfile } from './quant/symbolProfile.js';
import { getAggregatedSentiment, type AggregatedSentiment } from './sentimentAggregator.js';

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
      /** Whether the setup is actionable now, waiting on price, or absent. */
      readiness: 'ACTIONABLE' | 'WAITING' | 'NO SETUP';
      archetype: string;
      trigger: number;
      entryZone: string;
      chasePrice: number;
      /** ONE-DAY expected move in dollars, ~0.35x ATR. Signed by bias. */
      expectedMove: number;
      /** The same move scaled to the 20-bar grading horizon — the figure
       *  comparable to `majorResistance`. See compositeScore. */
      expectedMoveHorizon: number;
      majorResistance: number;
      stretchTarget: number;
      stop: number;
      rewardRisk: number;
      /** True geometric R:R, populated even on NO TRADE. See compositeScore.ts. */
      potentialRewardRisk: number;
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

/**
 * Explain a NO TRADE verdict in terms of this symbol's own numbers.
 *
 * Both this and the AI Evidence Review below used to emit one hardcoded sentence —
 * "No executable setup: evidence, location, or reward-to-risk did not clear the trade
 * filter." — for every rejected plan. Since the geometry and structure gates landed,
 * NO TRADE is the common verdict, so two of the three explanation panels showed the
 * same text on every symbol and neither said which gate actually fired. The engine
 * already knows: `whyNow` carries the specific blocking condition and the zones carry
 * their levels and contributors. This reports them.
 */
function explainNoTrade(
  plan: { whyNow: string; trigger: number; potentialRewardRisk: number } | undefined,
  currentPrice: number,
  demandZone: { top: number; bottom: number; confluence: string[] },
  supplyZone: { top: number; bottom: number; confluence: string[] },
): string {
  if (!plan) return 'No trade plan could be built — insufficient factor coverage for this symbol.';

  const NO_STRUCT = 'No structural level identified';
  const demandOk = demandZone.confluence[0] !== NO_STRUCT;
  const supplyOk = supplyZone.confluence[0] !== NO_STRUCT;
  const parts: string[] = [plan.whyNow];

  if (demandOk && supplyOk) {
    const toDemand = ((currentPrice - demandZone.top) / currentPrice) * 100;
    const toSupply = ((supplyZone.bottom - currentPrice) / currentPrice) * 100;
    parts.push(
      `At $${currentPrice.toFixed(2)}, price sits ${toDemand.toFixed(1)}% above demand ($${demandZone.bottom}–$${demandZone.top}: ${demandZone.confluence.join(' + ')}) and ${toSupply.toFixed(1)}% below supply ($${supplyZone.bottom}–$${supplyZone.top}: ${supplyZone.confluence.join(' + ')}).`,
    );
    parts.push(
      plan.potentialRewardRisk >= 1
        ? `The geometry itself is sound — ${plan.potentialRewardRisk}R if price reaches $${plan.trigger}. This is a level to watch, not a setup to take here.`
        : `Even at the trigger the geometry only offers ${plan.potentialRewardRisk}R, so it would not qualify on a pullback either.`,
    );
  } else {
    const missing = !demandOk && !supplyOk
      ? 'Neither side is'
      : !demandOk ? 'The demand side is not' : 'The supply side is not';
    parts.push(
      `${missing} anchored in observed price behaviour — no pivot cluster, volume shelf, or value-area edge within reach. An entry and a stop would have to be invented, so none are offered.`,
    );
  }
  return parts.join(' ');
}

/**
 * Grounded evidence summary, assembled from factor outputs rather than generated.
 *
 * Deliberately deterministic: this panel reads as the model's justification, and a
 * language model asked to justify a verdict will reliably sound more certain than the
 * evidence warrants. Every number here is a direct readout of what the factors returned.
 */
function summariseEvidence(
  symbol: string,
  currentPrice: number,
  modelConviction: number,
  agreementLevel: string,
  factors: FactorResult[],
): string {
  const directional = factors.filter(f => f.bias !== 'neutral');
  const bulls = directional.filter(f => f.bias === 'bullish').sort((a, b) => b.weight - a.weight);
  const bears = directional.filter(f => f.bias === 'bearish').sort((a, b) => b.weight - a.weight);
  const neutralCount = factors.length - directional.length;
  const label = (f: FactorResult) => `${f.factorName.replace(/\s*\(.*?\)\s*$/, '')} (${Math.round(f.weight * 100)}%)`;

  const sides: string[] = [];
  if (bulls.length) sides.push(`Bullish: ${bulls.slice(0, 3).map(label).join(', ')}${bulls.length > 3 ? `, +${bulls.length - 3} more` : ''}.`);
  if (bears.length) sides.push(`Bearish: ${bears.slice(0, 3).map(label).join(', ')}${bears.length > 3 ? `, +${bears.length - 3} more` : ''}.`);
  if (!sides.length) sides.push('No factor returned a directional read.');

  const agreement = agreementLevel === 'LOW'
    ? 'The active evidence buckets disagree, so the net bias carries little weight on its own.'
    : agreementLevel === 'HIGH'
      ? 'The active evidence buckets broadly agree.'
      : 'The active evidence buckets are only moderately aligned.';

  return `${symbol} at $${currentPrice.toFixed(2)}: ${factors.length} factors ran — ${directional.length} directional, ${neutralCount} neutral. ${sides.join(' ')} ${agreement} Composite conviction ${Math.round(modelConviction * 100)}/100, which is an evidence-strength score and not a win probability.`;
}

export async function getPredictiveZones(
  symbol: string,
  activeExpiry?: string,
  livePriceOverride?: number,
): Promise<PredictiveEngineResult> {
  const sym = symbol.toUpperCase();

  // Fetch daily bars, intraday bars, options chain, sentiment, and news concurrently —
  // none of these depend on each other's output, only on `sym`. They used to run as five
  // sequential round trips, which stacked their full latencies on the critical path of
  // every single trade-plan generation. Each optional fetch keeps its own try/catch so one
  // slow/failing source doesn't take down the others; only the daily-bar fetch is required.
  const [dailyResult, intradayResult, optionsChain, sentiment, news, benchmarkResult] = await Promise.all([
    // 1. OHLCV — Yahoo primary here since the screener fans this out across ~20
    // candidates per run and Schwab-first was the main latency source; Schwab
    // remains the default for other callers.
    //
    // Raised from 126 bars to 300. Relative Momentum needs a twelve-month
    // lookback plus a skip month, 273 bars, and at 126 it could never have
    // fired — a factor that silently never speaks is the worst failure mode
    // available, because nothing in the output distinguishes it from one that
    // looked and had no opinion. Still a single request per symbol.
    fetchBarsWithFallback(sym, '1day', DAILY_BAR_COUNT, { preferredProvider: 'yahoo' }),

    // 1b. 1-min extended-hours bars for the current session, best-effort. Powers
    // session-anchored VWAP factors (Day/London/US); anything relying on daily bars
    // is unaffected if this fails, and session-VWAP factors return null rather than
    // degrading silently. Also used below to refresh `currentPrice`: the daily-bar
    // fetch has no "synthesize today's live candle" step, so its last close can be a
    // stale prior-session settlement during premarket/postmarket. Every downstream
    // trigger/chase-price/overextension check in compositeScore.ts assumes
    // `currentPrice` is live — on a gap day, a stale close made those checks blind to
    // the gap (see PR notes). 1-min bars reflect real ticks including pre/post
    // market, so they're a much better source of truth when available.
    fetchBarsWithFallback(sym, '1min', 960, { extendedHours: true }).catch(err => {
      console.warn(`[PredictiveEngine] Intraday bars unavailable for ${sym}, session VWAP factors will be skipped:`, err);
      return undefined;
    }),

    // 2. Options Chain, safely (graceful fallback if unsupported/empty)
    fetchOptionsChainWithFallback(sym).catch(err => {
      console.warn(`[PredictiveEngine] Options chain unavailable for ${sym}, proceeding with price action factors:`, err);
      return undefined;
    }),

    // 2b. Aggregated sentiment, best-effort. Cached for 30 minutes inside the
    // aggregator, so the screener fanning this across ~20 candidates costs one
    // provider round trip per symbol per half hour rather than five per call.
    getAggregatedSentiment(sym).catch(err => {
      console.warn(`[PredictiveEngine] Sentiment unavailable for ${sym}:`, err);
      return undefined;
    }),

    // 3. News, safely. The random delay staggers Polygon requests when the screener
    // fans this out across many symbols at once; it no longer blocks the other fetches.
    (async () => {
      await new Promise(resolve => setTimeout(resolve, Math.random() * 750));
      return getTickerNews(sym, 15);
    })().catch(err => {
      console.warn(`[PredictiveEngine] News unavailable for ${sym}, proceeding without news sentiment: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }),

    // 5. Benchmark daily bars, best-effort. Powers relative-strength factors,
    // which are the only kind that measured out of sample. Cached, so a screener
    // pass over twenty candidates costs one benchmark fetch rather than twenty.
    fetchBarsWithFallback(BENCHMARK_SYMBOL, '1day', DAILY_BAR_COUNT, {
      preferredProvider: 'yahoo', useCache: true,
    }).catch(err => {
      console.warn(`[PredictiveEngine] Benchmark bars unavailable, relative-strength factors will be skipped:`, err);
      return undefined;
    }),
  ]);

  const { bars } = dailyResult;
  if (!bars || bars.length === 0) {
    throw new Error(`Insufficient historical price data found for ticker ${sym}`);
  }

  const intradayBars: OHLCVDataPoint[] | undefined = intradayResult?.bars;

  // Prefer an explicit live quote from the caller (e.g. screenerService.ts
  // already has one — using it keeps compositeScore's trade-plan geometry and
  // the screener's own trigger evaluation looking at the exact same price)
  // over the latest 1-min bar, over the daily bar's close as a last resort.
  const latestIntradayClose = intradayBars?.[intradayBars.length - 1]?.close;
  const currentPrice = livePriceOverride ?? latestIntradayClose ?? bars[bars.length - 1].close;

  const factorInput: FactorInput = {
    symbol: sym,
    currentPrice,
    bars,
    optionsChain,
    activeExpiry,
    news,
    intradayBars,
    benchmarkBars: benchmarkResult?.bars,
    sentiment,
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
  /**
   * Realised expectancy per direction, from the same SETUP_STATS the calibrator
   * reads. Feeds the explicit direction tilt in position sizing — a tilt the
   * old accuracy term was applying by accident, at +0.167x on LONG over SHORT,
   * because raw accuracy tracked each factor's long-share. Stated here instead,
   * where it can be inspected and switched off.
   */
  const directionRecord = (bias: 'LONG' | 'SHORT') => {
    const row = setupStats?.[learningKey(bias, TRADE_PLAN_SOURCE)];
    // `tries` counts ambiguous grades too; expectancy must divide by the
    // resolved ones that actually contributed to sumActualR.
    const resolved = row ? row.wins + row.losses : 0;
    return row && resolved > 0 ? { n: resolved, sumR: row.sumActualR } : undefined;
  };
  const directionStats = setupStats
    ? { LONG: directionRecord('LONG'), SHORT: directionRecord('SHORT') }
    : undefined;

  const synthesis = await aiAgent.synthesize(
    sym, currentPrice, activeFactors, bars, factorStats, news, directionStats,
  );

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
    // Namespaced by engine. The un-prefixed key this used to read is never
    // written by evaluateQuant, so calibration always missed.
    plan ? setupStats?.[learningKey(plan.bias, TRADE_PLAN_SOURCE)] : undefined,
  );
  // Always use majorResistance (T1) as the primary target for the AI narrative.
  // For SHORT, majorResistance = demandZone.top = nearest structural support below entry.
  // Previously SHORT used stretchTarget (T2), causing the AI to compute R:R from T2
  // (~22R) instead of T1 (~6R) — a mismatch vs tradePlan.rewardRisk which uses T1.
  const targetPrice = !plan || plan.bias === 'NO TRADE'
    ? currentPrice
    : plan.majorResistance;
  const targetSources = !plan || plan.bias === 'NO TRADE'
    ? []
    : plan.bias === 'LONG' ? synthesis.supplyZone.confluence : synthesis.demandZone.confluence;
  const priceRationale = {
    targetPrice,
    targetType: (!plan || plan.bias === 'NO TRADE' ? 'none' : plan.bias === 'LONG' ? 'resistance' : 'support') as 'support' | 'resistance' | 'none',
    targetSources,
    invalidationPrice: plan?.stop ?? currentPrice,
    explanation: !plan || plan.bias === 'NO TRADE'
      ? explainNoTrade(plan, currentPrice, synthesis.demandZone, synthesis.supplyZone)
      // TODO(PR2): switch to "15m close" once multi-TF fetch is live. Today the engine only has daily bars.
      : `T1 ($${plan.majorResistance}) is the primary structural ${plan.bias === 'LONG' ? 'resistance' : 'demand'} zone (${targetSources.join(', ') || 'price structure'}). T2 ($${plan.stretchTarget}) serves as the extended statistical/VWAP target. Invalidation is $${plan.stop}; a daily close ${plan.bias === 'LONG' ? 'below' : 'above'} $${plan.stop} invalidates the setup.`,
  };
  let aiNarrative = summariseEvidence(sym, currentPrice, synthesis.modelConviction, synthesis.agreementLevel, activeFactors);
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
