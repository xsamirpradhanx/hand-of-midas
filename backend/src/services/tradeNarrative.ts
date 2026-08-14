import { GoogleGenAI } from '@google/genai';
import type { FactorResult } from './factors/types.js';

let client: GoogleGenAI | null = null;
if (process.env.GEMINI_API_KEY) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

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
  if (!client || input.bias === 'NO TRADE') return fallback;

  const evidence = input.factors.slice(0, 8).map(f => ({
    name: f.factorName, bias: f.bias, reasoning: f.reasoning,
  }));
  try {
    const response = await client.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: `Explain this trade plan in 2 concise sentences for a trader. Use ONLY the supplied data. Do not give financial advice, do not claim certainty, and do not invent or change any price level. Explicitly say the target is a scenario, not a prediction.\n${JSON.stringify({ ...input, factors: evidence })}`,
    });
    return response.text?.trim() || fallback;
  } catch (error) {
    console.warn('[TradeNarrative] Grounded explanation unavailable:', error);
    return fallback;
  }
}
