import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';

export class InsiderCatalystFactor implements PredictiveFactor {
  name = 'Catalyst Drift & News NLP';
  bucket = 'CATALYST' as const;
  correlationGroup = 'CATALYST';

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    const { news, currentPrice } = input;
    if (!news || news.length === 0) return null;

    const bullishWords = ['surge', 'jump', 'gain', 'profit', 'beat', 'growth', 'upgrade', 'rally', 'bull', 'soar', 'record', 'dividend', 'buyback'];
    const bearishWords = ['plunge', 'drop', 'loss', 'miss', 'decline', 'downgrade', 'crash', 'bear', 'fall', 'investigation', 'lawsuit', 'subpoena'];

    let bullCount = 0;
    let bearCount = 0;

    for (const article of news) {
      const text = ((article.title || '') + ' ' + (article.description || '')).toLowerCase();
      for (const w of bullishWords) if (text.includes(w)) bullCount++;
      for (const w of bearishWords) if (text.includes(w)) bearCount++;
    }

    const netScore = bullCount - bearCount;
    const totalCount = bullCount + bearCount;
    if (totalCount === 0) return null;

    const sentimentRatio = Math.max(-1, Math.min(1, netScore / totalCount));
    const bias = sentimentRatio > 0.2 ? 'bullish' : sentimentRatio < -0.2 ? 'bearish' : 'neutral';

    const buyTarget = bias === 'bullish' ? currentPrice * 0.99 : currentPrice * 0.98;
    const sellTarget = bias === 'bearish' ? currentPrice * 1.01 : currentPrice * 1.02;

    return {
      factorName: this.name,
      buyTarget,
      sellTarget,
      bias,
      weight: 0.15,
      bucket: 'CATALYST',
      correlationGroup: 'CATALYST',
      reasoning: `Scanned ${news.length} news articles. Keyword Sentiment Ratio: ${sentimentRatio >= 0 ? '+' : ''}${(sentimentRatio * 100).toFixed(0)}% (${bullCount} bullish / ${bearCount} bearish headlines).`,
    };
  }
}
