import { getTickerNews } from './polygon.js';
import { getStocktwitsSentiment, StocktwitsSentiment } from './stocktwits.js';
import { getRedditSentiment, RedditSentiment } from './reddit.js';

export interface NewsSentiment {
  score: number; // -1 to 1
  bias: 'bullish' | 'bearish' | 'neutral';
  bullCount: number;
  bearCount: number;
  articles: Array<{
    title: string;
    url: string;
    published_utc: string;
    source: string;
  }>;
}

export interface FinnhubSentiment {
  insiderSentiment: number; // 0 to 100
  newsSentiment: number; // 0 to 100
  buzz: number; // 0 to 1
}

export interface AggregatedSentiment {
  symbol: string;
  retail: StocktwitsSentiment;
  reddit: RedditSentiment;
  finnhub: FinnhubSentiment;
  news: NewsSentiment;
  timestamp: string;
}

/**
 * Basic NLP keyword scoring for news headlines.
 */
function analyzeNewsSentiment(articles: any[]): NewsSentiment {
  if (!articles || articles.length === 0) {
    return { score: 0, bias: 'neutral', bullCount: 0, bearCount: 0, articles: [] };
  }

  const bullishWords = ['surge', 'jump', 'gain', 'profit', 'beat', 'growth', 'upgrade', 'rally', 'bull', 'soar', 'record', 'dividend', 'buyback', 'higher'];
  const bearishWords = ['plunge', 'drop', 'loss', 'miss', 'decline', 'downgrade', 'crash', 'bear', 'fall', 'investigation', 'lawsuit', 'subpoena', 'lower'];

  let bullCount = 0;
  let bearCount = 0;

  for (const article of articles) {
    const text = ((article.title || '') + ' ' + (article.description || '')).toLowerCase();
    for (const w of bullishWords) if (text.includes(w)) bullCount++;
    for (const w of bearishWords) if (text.includes(w)) bearCount++;
  }

  const netScore = bullCount - bearCount;
  const totalCount = bullCount + bearCount;
  const score = totalCount > 0 ? (netScore / totalCount) : 0;
  
  const bias = score > 0.2 ? 'bullish' : score < -0.2 ? 'bearish' : 'neutral';

  return {
    score,
    bias,
    bullCount,
    bearCount,
    articles: articles.slice(0, 10).map(a => ({
      title: a.title,
      url: a.article_url,
      published_utc: a.published_utc,
      source: a.author || 'News',
    })),
  };
}

/**
 * Aggregates both Retail (Stocktwits) and Institutional/News sentiment into a single payload.
 */
export async function getAggregatedSentiment(symbol: string): Promise<AggregatedSentiment> {
  const [stocktwits, reddit, newsArticles] = await Promise.all([
    getStocktwitsSentiment(symbol),
    getRedditSentiment(symbol),
    getTickerNews(symbol, 15).catch(() => [])
  ]);

  const news = analyzeNewsSentiment(newsArticles);

  // MOCK Finnhub Data (Requires API Key)
  const finnhub: FinnhubSentiment = {
    insiderSentiment: Math.floor(Math.random() * 100),
    newsSentiment: Math.floor(Math.random() * 100),
    buzz: Math.random()
  };

  return {
    symbol: symbol.toUpperCase(),
    retail: stocktwits,
    reddit,
    finnhub,
    news,
    timestamp: new Date().toISOString(),
  };
}
