import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';
import { scoreNewsSentiment } from '../newsSentimentScorer.js';

export class InsiderCatalystFactor implements PredictiveFactor {
  name = 'Catalyst Drift & News NLP';
  bucket = 'CATALYST' as const;
  correlationGroup = 'CATALYST';

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    const { news, currentPrice, symbol, sentiment } = input;
    if (!news || news.length === 0) return null;

    // getAggregatedSentiment (fetched once per symbol upstream) already scored
    // this exact headline set via the same AI call this factor used to make a
    // second time. Reuse it, and only re-score if that fetch failed.
    const { score: sentimentRatio, bias, bullCount, bearCount } =
      sentiment?.news ?? (await scoreNewsSentiment(symbol, news));
    if (bullCount === 0 && bearCount === 0) return null;

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
      reasoning: `Scanned ${news.length} news articles. Headline Sentiment: ${sentimentRatio >= 0 ? '+' : ''}${(sentimentRatio * 100).toFixed(0)}% (${bullCount} bullish / ${bearCount} bearish headlines).`,
    };
  }
}
