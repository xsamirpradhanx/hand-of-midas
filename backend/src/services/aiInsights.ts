import { GoogleGenAI } from '@google/genai';
import type { PolygonNewsArticle } from './polygon.js';

let aiClient: GoogleGenAI | null = null;
const API_KEY = process.env.GEMINI_API_KEY;

if (API_KEY) {
  aiClient = new GoogleGenAI({ apiKey: API_KEY });
}

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
  
  if (aiClient) {
    try {
      const prompt = `You are an expert options trader. Analyze the following live options chain data for ${symbol} expiring on ${expiry}:
- Current Spot Price: $${spotPrice}
- Max Pain Strike: $${maxPainStrike}
- Put/Call Volume Skew: ${volumeSkew.toFixed(2)}x (Puts over Calls)
- Put/Call Open Interest Skew: ${oiSkew.toFixed(2)}x
- Key GEX (Gamma Exposure) levels: ${JSON.stringify(gexProfile.filter(g => Math.abs(g.totalGex) > 1000000).slice(0, 5))}

Write a 2-3 sentence actionable trading insight. Keep it extremely concise, professional, and focus on support/resistance implied by GEX and sentiment implied by skew.`;

      const response = await aiClient.models.generateContent({
        model: 'gemini-3.5-flash',
        contents: prompt,
      });

      return response.text || generateHeuristicInsight(metrics);
    } catch (err) {
      console.error('AI Generation Failed:', err);
      return generateHeuristicInsight(metrics);
    }
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

export async function generateCommitteeSynthesis(
  symbol: string,
  deterministicSummary: string,
  news: PolygonNewsArticle[] | undefined
): Promise<string> {
  const fallback = deterministicSummary;
  if (!aiClient) return fallback;

  const headlines = (news || []).slice(0, 10).map(n => `- ${n.title}`).join('\n');

  try {
    const prompt = `You are the Head of an AI Investment Committee analyzing ${symbol}. 
Here is the quantitative model's deterministic report:

${deterministicSummary}

Recent news headlines for context:
${headlines || 'No recent news.'}

Write a 3-4 sentence qualitative synthesis report. Do NOT just list the factors again. Synthesize them. Identify if the fundamental news aligns with or diverges from the quantitative indicators (volume, options, price structure). Provide a definitive, professional macro view. Do not invent price targets.`;

    const response = await aiClient.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: prompt,
    });

    return response.text?.trim() || fallback;
  } catch (err) {
    console.warn('[AI Committee] Synthesis generation failed:', err);
    return fallback;
  }
}
