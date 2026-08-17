import { getTickerNews } from './polygon.js';
import { getStocktwitsSentiment, StocktwitsSentiment } from './stocktwits.js';
import { getRedditSentiment, RedditSentiment } from './reddit.js';
import { getFinnhubInsiderSentiment, getFinnhubAnalystRecommendation } from './finnhub.js';
import { scoreNewsSentiment } from './newsSentimentScorer.js';
import { getCachedData, setCachedData } from './cache.js';

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
  insiderSentiment: number | null; // 0 to 100, from Finnhub's free insider-sentiment endpoint
  /** How many filed months had actual share activity behind the score. */
  insiderMonthsSampled: number;
  /** "YYYY-MM" of the latest month Finnhub has any filing for, so a stale score is visible as such. */
  insiderMostRecentMonth: string | null;
  /** 0 to 100 analyst consensus (Buy vs Sell weighted), from Finnhub's free recommendation-trends endpoint. */
  analystScore: number | null;
  analystStrongBuy: number;
  analystBuy: number;
  analystHold: number;
  analystSell: number;
  analystStrongSell: number;
  /** "YYYY-MM-DD" of the consensus period. */
  analystPeriod: string | null;
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
 * Scores institutional/news sentiment from recent headlines via the shared
 * AI-first scorer (see newsSentimentScorer.ts), then attaches the display
 * article list.
 */
async function analyzeNewsSentiment(symbol: string, articles: any[]): Promise<NewsSentiment> {
  const { score, bias, bullCount, bearCount } = await scoreNewsSentiment(symbol, articles ?? []);

  return {
    score,
    bias,
    bullCount,
    bearCount,
    articles: (articles ?? []).slice(0, 10).map(a => ({
      title: a.title,
      url: a.article_url,
      published_utc: a.published_utc,
      source: a.author || 'News',
    })),
  };
}

/**
 * Cache TTL for the aggregate.
 *
 * This function fans out to five separate providers and was previously uncached, so
 * every /sentiment page load paid the full round trip. That cost is also what kept
 * sentiment out of the predictive engine: the screener fans getPredictiveZones across
 * ~20 candidates, and five uncached third-party calls per symbol on top of that is not
 * viable. Insider filings, analyst ratings and social mood all move on a scale of hours
 * at best, so a 30-minute TTL loses nothing and makes the data cheap enough to use as
 * a factor input.
 */
const SENTIMENT_TTL_SECONDS = 30 * 60;

/**
 * Aggregates both Retail (Stocktwits) and Institutional/News sentiment into a single payload.
 */
export async function getAggregatedSentiment(symbol: string): Promise<AggregatedSentiment> {
  const cacheKey = `AGGREGATED_SENTIMENT#${symbol.toUpperCase()}`;
  const cached = await getCachedData<AggregatedSentiment>(cacheKey).catch(() => null);
  if (cached) return cached;

  const [stocktwits, reddit, newsArticles, insiderSentiment, analystRecommendation] = await Promise.all([
    getStocktwitsSentiment(symbol),
    getRedditSentiment(symbol),
    getTickerNews(symbol, 15).catch(() => []),
    getFinnhubInsiderSentiment(symbol),
    getFinnhubAnalystRecommendation(symbol),
  ]);

  const news = await analyzeNewsSentiment(symbol, newsArticles);

  const finnhub: FinnhubSentiment = {
    insiderSentiment: insiderSentiment.insiderSentiment,
    insiderMonthsSampled: insiderSentiment.monthsSampled,
    insiderMostRecentMonth: insiderSentiment.mostRecentMonth,
    analystScore: analystRecommendation.score,
    analystStrongBuy: analystRecommendation.strongBuy,
    analystBuy: analystRecommendation.buy,
    analystHold: analystRecommendation.hold,
    analystSell: analystRecommendation.sell,
    analystStrongSell: analystRecommendation.strongSell,
    analystPeriod: analystRecommendation.period,
  };

  const aggregate: AggregatedSentiment = {
    symbol: symbol.toUpperCase(),
    retail: stocktwits,
    reddit,
    finnhub,
    news,
    timestamp: new Date().toISOString(),
  };

  // Never fail the request over a cache write.
  void setCachedData(cacheKey, aggregate, SENTIMENT_TTL_SECONDS).catch(err =>
    console.warn(`[Sentiment] cache write failed for ${symbol}:`, err),
  );

  return aggregate;
}
