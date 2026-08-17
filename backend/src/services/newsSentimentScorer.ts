import { AI_AVAILABLE, generateText } from './aiProvider.js';

export interface NewsHeadline {
  title?: string;
  description?: string;
}

export interface NewsSentimentCounts {
  bullCount: number;
  bearCount: number;
}

// Fallback only — used when no AI provider is configured or the AI call fails.
// A plain substring scan over short headlines is inherently sparse (most real
// headlines never use these exact words), so this is a floor, not the primary
// signal. See classifyHeadlinesWithAI below for the primary path.
const BULLISH_KEYWORDS = [
  'surge', 'jump', 'gain', 'gains', 'profit', 'beat', 'beats', 'growth', 'upgrade',
  'upgraded', 'rally', 'bull', 'bullish', 'soar', 'soars', 'record', 'dividend',
  'buyback', 'higher', 'outperform', 'raises guidance', 'raised guidance', 'strong demand',
  'expansion', 'expands', 'partnership', 'wins contract', 'exceeds expectations',
];
const BEARISH_KEYWORDS = [
  'plunge', 'drop', 'drops', 'loss', 'losses', 'miss', 'misses', 'decline', 'downgrade',
  'downgraded', 'crash', 'bear', 'bearish', 'fall', 'falls', 'investigation', 'lawsuit',
  'subpoena', 'lower', 'underperform', 'cuts guidance', 'cut guidance', 'weak demand',
  'layoffs', 'bankruptcy', 'recall', 'delisting', 'probe', 'fraud', 'warns', 'warning',
];

export function countKeywordHits(articles: NewsHeadline[]): NewsSentimentCounts {
  let bullCount = 0;
  let bearCount = 0;
  for (const article of articles) {
    const text = ((article.title || '') + ' ' + (article.description || '')).toLowerCase();
    for (const w of BULLISH_KEYWORDS) if (text.includes(w)) bullCount++;
    for (const w of BEARISH_KEYWORDS) if (text.includes(w)) bearCount++;
  }
  return { bullCount, bearCount };
}

/**
 * Classifies each headline's likely stock-price impact via LLM. Returns null
 * (caller falls back to keyword scan) if AI is unavailable, the response
 * doesn't parse, or the classification count doesn't match the input count.
 */
export async function classifyHeadlinesWithAI(
  symbol: string,
  articles: NewsHeadline[],
): Promise<NewsSentimentCounts | null> {
  if (!AI_AVAILABLE) return null;

  const headlines = articles.slice(0, 15).map(a => a.title).filter((t): t is string => Boolean(t));
  if (headlines.length === 0) return null;

  try {
    const text = await generateText(
      `Classify each of these news headlines about ${symbol} stock by their likely short-term impact on the stock price: "bullish", "bearish", or "neutral". Judge price impact only, not general news tone (e.g. a headline about a competitor's problems is bullish for ${symbol}; routine/non-price-moving news is neutral). Return strict JSON: {"classifications": ["bullish"|"bearish"|"neutral", ...]} with exactly ${headlines.length} entries, in the same order as the input, no other text.\n\nHeadlines: ${JSON.stringify(headlines)}`,
      { json: true },
    );
    if (!text) return null;

    // Providers asked for json-only output can still wrap it in markdown
    // fences or append stray trailing text — extract the outermost {...}
    // block rather than failing the whole classification on a strict parse.
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    const jsonSlice = jsonStart >= 0 && jsonEnd > jsonStart ? text.slice(jsonStart, jsonEnd + 1) : text;

    const parsed = JSON.parse(jsonSlice) as { classifications?: unknown };
    if (!Array.isArray(parsed.classifications) || parsed.classifications.length !== headlines.length) {
      return null;
    }

    let bullCount = 0;
    let bearCount = 0;
    for (const c of parsed.classifications) {
      if (c === 'bullish') bullCount++;
      else if (c === 'bearish') bearCount++;
    }
    return { bullCount, bearCount };
  } catch (err) {
    console.warn(`[NewsSentimentScorer] AI headline classification failed for ${symbol}, falling back to keyword scan:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export interface NewsSentimentScore extends NewsSentimentCounts {
  /** -1 to 1 */
  score: number;
  bias: 'bullish' | 'bearish' | 'neutral';
}

/**
 * Scores news sentiment from headlines. Prefers an LLM classification of
 * actual price-impact meaning; falls back to a keyword scan when AI is
 * unavailable or fails to parse, since the keyword list alone is too sparse
 * to be a reliable primary signal.
 */
export async function scoreNewsSentiment(symbol: string, articles: NewsHeadline[]): Promise<NewsSentimentScore> {
  if (!articles || articles.length === 0) {
    return { score: 0, bias: 'neutral', bullCount: 0, bearCount: 0 };
  }

  const aiResult = await classifyHeadlinesWithAI(symbol, articles);
  const { bullCount, bearCount } = aiResult ?? countKeywordHits(articles);

  const netScore = bullCount - bearCount;
  const totalCount = bullCount + bearCount;
  const score = totalCount > 0 ? Math.max(-1, Math.min(1, netScore / totalCount)) : 0;
  const bias = score > 0.2 ? 'bullish' : score < -0.2 ? 'bearish' : 'neutral';

  return { score, bias, bullCount, bearCount };
}
