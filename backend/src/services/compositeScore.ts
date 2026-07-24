import type { FactorResult } from './factors/types.js';

export interface AISynthesisResult {
  summary: string;
  bias: 'bullish' | 'bearish' | 'neutral';
  overallConviction: number;
  buyZone: { top: number; bottom: number };
  sellZone: { top: number; bottom: number };
  keyFactors: FactorResult[];
}

export class CompositeScoreAgent {
  synthesize(symbol: string, currentPrice: number, factors: FactorResult[]): AISynthesisResult {
    if (!factors || factors.length === 0) {
      return {
        summary: `Insufficient factor inputs to run AI synthesis for ${symbol}.`,
        bias: 'neutral',
        overallConviction: 0.5,
        buyZone: { top: Number((currentPrice * 0.99).toFixed(2)), bottom: Number((currentPrice * 0.97).toFixed(2)) },
        sellZone: { top: Number((currentPrice * 1.03).toFixed(2)), bottom: Number((currentPrice * 1.01).toFixed(2)) },
        keyFactors: [],
      };
    }

    let weightedBuySum = 0;
    let buyWeightTotal = 0;
    let weightedSellSum = 0;
    let sellWeightTotal = 0;
    let bullishWeight = 0;
    let bearishWeight = 0;
    let totalWeight = 0;

    for (const f of factors) {
      totalWeight += f.weight;
      if (f.bias === 'bullish') bullishWeight += f.weight;
      if (f.bias === 'bearish') bearishWeight += f.weight;

      if (f.buyTarget !== undefined && f.buyTarget > 0) {
        weightedBuySum += f.buyTarget * f.weight;
        buyWeightTotal += f.weight;
      }
      if (f.sellTarget !== undefined && f.sellTarget > 0) {
        weightedSellSum += f.sellTarget * f.weight;
        sellWeightTotal += f.weight;
      }
    }

    const rawBuyCenter = buyWeightTotal > 0 ? (weightedBuySum / buyWeightTotal) : (currentPrice * 0.98);
    const rawSellCenter = sellWeightTotal > 0 ? (weightedSellSum / sellWeightTotal) : (currentPrice * 1.02);

    // Clamping to guarantee Buy is below current price and Sell is above
    const buyCenter = Math.min(currentPrice * 0.985, rawBuyCenter);
    const sellCenter = Math.max(currentPrice * 1.015, rawSellCenter);

    const spread = currentPrice * 0.012;

    const buyZone = {
      top: Number((buyCenter + (spread / 2)).toFixed(2)),
      bottom: Number(Math.max(0, buyCenter - (spread / 2)).toFixed(2)),
    };

    const sellZone = {
      top: Number((sellCenter + (spread / 2)).toFixed(2)),
      bottom: Number(Math.max(0, sellCenter - (spread / 2)).toFixed(2)),
    };

    const bias: 'bullish' | 'bearish' | 'neutral' = 
      bullishWeight > bearishWeight ? 'bullish' : bearishWeight > bullishWeight ? 'bearish' : 'neutral';

    const netRatio = totalWeight > 0 ? Math.abs(bullishWeight - bearishWeight) / totalWeight : 0;
    const overallConviction = Number(Math.min(0.98, Math.max(0.45, 0.5 + (netRatio * 0.45))).toFixed(2));

    const topFactorDetails = factors.map(f => `• [${f.factorName}] (${f.bias.toUpperCase()}): ${f.reasoning}`).join('\n');
    const summary = `[AI INVESTMENT COMMITTEE REPORT for ${symbol}]\nConsensus Rating: ${bias.toUpperCase()} (${(overallConviction * 100).toFixed(0)}% Conviction).\nEvaluated ${factors.length} quantitative factor vectors:\n${topFactorDetails}`;

    return {
      summary,
      bias,
      overallConviction,
      buyZone,
      sellZone,
      keyFactors: factors,
    };
  }
}
