import type { FactorResult } from './factors/types.js';
import { AI_AVAILABLE, generateText } from './aiProvider.js';

// Gemini free tier caps at 20 requests/day; the screener re-evaluates the same
// plan on every refresh, so an unchanged plan must be served from cache.
const CACHE_TTL_MS = 4 * 60 * 60 * 1000;
const narrativeCache = new Map<string, { expiresAt: number; value: string }>();

interface NarrativeInput {
  symbol: string;
  currentPrice: number;
  bias: 'LONG' | 'SHORT' | 'NO TRADE';
  target: number;
  stop: number;
  trigger: number;
  factors: FactorResult[];
}

/** AI explains the deterministic plan; it is never allowed to invent prices or override it. */
export async function generateGroundedTradeNarrative(input: NarrativeInput): Promise<string> {
  const fallback = `The ${input.bias} plan is anchored to the $${input.trigger} trigger, $${input.target} target, and $${input.stop} invalidation. The target is the nearest independently supported structural level; it is a scenario, not a forecast.`;
  if (!AI_AVAILABLE || input.bias === 'NO TRADE') return fallback;

  const evidence = input.factors.slice(0, 8).map(f => ({
    name: f.factorName, bias: f.bias, reasoning: f.reasoning,
  }));
  const cacheKey = JSON.stringify({ ...input, factors: evidence });
  const cached = narrativeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const prompt = `Explain this trade plan in 2 concise sentences for a trader. Use ONLY the supplied data. Do not give financial advice, do not claim certainty, and do not invent, round, or modify any price level or numerical value — all numbers must appear verbatim in the supplied JSON. Do not compute R:R or probability from these numbers. Explicitly say the target is a scenario, not a prediction.\n${cacheKey}`;

  const text = await generateText(prompt);
  const result = text?.trim() || fallback;
  narrativeCache.set(cacheKey, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}
