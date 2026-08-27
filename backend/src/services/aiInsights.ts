import type { PolygonNewsArticle } from './polygon.js';
import type { FactorResult } from './factors/types.js';
import { AI_AVAILABLE, generateText } from './aiProvider.js';
import { aiCacheKey, withAiCache } from './aiCache.js';

// The screener re-evaluates the same symbols on every refresh, so identical
// inputs must be served from cache rather than re-billed against a free tier
// that allows five requests per minute. Shared across processes (see
// aiCache.ts) — the API Lambda and ScreenerRefreshFunction evaluate the same
// symbols and used to warm separate in-process copies.
const CACHE_TTL_SECONDS = 4 * 60 * 60;

export interface MarketMetrics {
  symbol: string;
  expiry: string;
  spotPrice: number;
  maxPainStrike: number;
  volumeSkew: number;
  oiSkew: number;
  gexProfile: { strike: number; callGex: number; putGex: number; totalGex: number }[];
}

export async function generateInsight(metrics: MarketMetrics): Promise<string> {
  const { symbol, expiry, spotPrice, maxPainStrike, volumeSkew, oiSkew, gexProfile } = metrics;

  if (AI_AVAILABLE) {
    const prompt = `You are an expert options trader. Analyze the following live options chain data for ${symbol} expiring on ${expiry}:
- Current Spot Price: $${spotPrice}
- Max Pain Strike: $${maxPainStrike}
- Put/Call Volume Skew: ${volumeSkew.toFixed(2)}x (Puts over Calls)
- Put/Call Open Interest Skew: ${oiSkew.toFixed(2)}x
- Key GEX (Gamma Exposure) levels: ${JSON.stringify(gexProfile.filter(g => Math.abs(g.totalGex) > 1000000).slice(0, 5))}

Write a 2-3 sentence actionable trading insight. Keep it extremely concise, professional, and focus on support/resistance implied by GEX and sentiment implied by skew.`;

    // Only a real AI answer is cached; a quota-exhaustion fallback must not be
    // pinned in place for four hours (see withAiCache).
    const cached = await withAiCache(aiCacheKey('insight', metrics), CACHE_TTL_SECONDS, () => generateText(prompt));
    return cached || generateHeuristicInsight(metrics);
  }

  return generateHeuristicInsight(metrics);
}

function generateHeuristicInsight(metrics: MarketMetrics): string {
  const { symbol, spotPrice, maxPainStrike, volumeSkew, gexProfile } = metrics;

  let insight = `The market for ${symbol} shows `;

  if (volumeSkew > 1.5) {
    insight += `strong bearish sentiment with heavy put buying (${volumeSkew.toFixed(2)}x skew). `;
  } else if (volumeSkew < 0.6) {
    insight += `strong bullish sentiment with dominant call activity (${volumeSkew.toFixed(2)}x skew). `;
  } else {
    insight += `mixed positioning with balanced put/call flow. `;
  }

  if (spotPrice > maxPainStrike * 1.05) {
    insight += `Price is extended above Max Pain ($${maxPainStrike}), suggesting potential downward drag toward expiry. `;
  } else if (spotPrice < maxPainStrike * 0.95) {
    insight += `Price is well below Max Pain ($${maxPainStrike}), indicating potential upward pull toward expiry. `;
  }

  const maxPositiveGex = [...gexProfile].sort((a, b) => b.totalGex - a.totalGex)[0];
  const maxNegativeGex = [...gexProfile].sort((a, b) => a.totalGex - b.totalGex)[0];

  if (maxPositiveGex && maxPositiveGex.totalGex > 0) {
    insight += `Major resistance/magnet at $${maxPositiveGex.strike} (High +GEX). `;
  }
  if (maxNegativeGex && maxNegativeGex.totalGex < 0) {
    insight += `Potential volatility acceleration zone below $${maxNegativeGex.strike} (High -GEX).`;
  }

  return insight;
}

export interface TradePlanNarrativeInput {
  bias: 'LONG' | 'SHORT';
  target: number;
  stop: number;
  trigger: number;
}

export interface CommitteeSynthesisResult {
  /** 3-4 sentence qualitative synthesis of the quant report against the news. */
  synthesis: string;
  /** 2 sentences explaining the trade plan's trigger/target/stop. */
  narrative: string;
}

/**
 * One AI call producing both the qualitative committee synthesis and the
 * trade-plan narrative. These used to be two fully independent calls
 * (generateCommitteeSynthesis + tradeNarrative.ts's
 * generateGroundedTradeNarrative) through the same globally-throttled AI
 * queue for what is really the same "explain the deterministic numbers in
 * words" job over overlapping evidence — merged to cut a call off every
 * Trade Plan generation.
 */
export async function generateCommitteeSynthesis(
  symbol: string,
  deterministicSummary: string,
  news: PolygonNewsArticle[] | undefined,
  factors: FactorResult[],
  tradePlan: TradePlanNarrativeInput,
): Promise<CommitteeSynthesisResult> {
  const narrativeFallback = `The ${tradePlan.bias} plan is anchored to the $${tradePlan.trigger} trigger, $${tradePlan.target} target, and $${tradePlan.stop} invalidation. The target is the nearest independently supported structural level; it is a scenario, not a forecast.`;
  const fallback: CommitteeSynthesisResult = { synthesis: deterministicSummary, narrative: narrativeFallback };
  if (!AI_AVAILABLE) return fallback;

  const headlines = (news || []).slice(0, 10).map(n => `- ${n.title}`).join('\n');
  const evidence = factors.slice(0, 8).map(f => ({ name: f.factorName, bias: f.bias, reasoning: f.reasoning }));

  const cacheKey = aiCacheKey('committee', { symbol, deterministicSummary, headlines, tradePlan, evidence });

  const prompt = `You are the Head of an AI Investment Committee analyzing ${symbol}.
Here is the quantitative model's deterministic report:

${deterministicSummary}

Recent news headlines for context:
${headlines || 'No recent news.'}

The deterministic trade plan is: ${tradePlan.bias}, trigger $${tradePlan.trigger}, target $${tradePlan.target}, stop $${tradePlan.stop}.

Respond with a JSON object with exactly two string keys:
"synthesis" — a 3-4 sentence qualitative synthesis report. Do NOT just list the factors again. Synthesize them. Identify if the fundamental news aligns with or diverges from the quantitative indicators (volume, options, price structure). Provide a definitive, professional macro view.
"narrative" — 2 concise sentences for a trader explaining the ${tradePlan.bias} plan's trigger/target/stop above. Explicitly say the target is a scenario, not a prediction.

STRICT RULES for both fields: do NOT invent, round, or modify any price level, strike price, percentage, or numerical value — every number referenced MUST appear verbatim above. Do not compute R:R or probability. Do not give financial advice or claim certainty.`;

  const cached = await withAiCache<CommitteeSynthesisResult>(cacheKey, CACHE_TTL_SECONDS, async () => {
    const text = await generateText(prompt, { json: true });
    if (!text) return null;
    try {
      const parsed = JSON.parse(text);
      return {
        synthesis: typeof parsed.synthesis === 'string' && parsed.synthesis.trim() ? parsed.synthesis.trim() : fallback.synthesis,
        narrative: typeof parsed.narrative === 'string' && parsed.narrative.trim() ? parsed.narrative.trim() : fallback.narrative,
      };
    } catch (err) {
      console.warn(`[AIInsights] Committee synthesis returned non-JSON for ${symbol}, using deterministic fallback:`, err instanceof Error ? err.message : err);
      return null;
    }
  });

  return cached ?? fallback;
}
