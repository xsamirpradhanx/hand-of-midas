export interface FinnhubInsiderSentiment {
  /** 0-100, share-magnitude and recency weighted from Finnhub's mspr (-100..100). 50 = neutral. */
  insiderSentiment: number | null;
  /** How many filed months actually contributed (had non-zero shares traded). */
  monthsSampled: number;
  /** "YYYY-MM" of the latest month Finnhub has any filing for (even a zero-activity one). */
  mostRecentMonth: string | null;
}

interface InsiderSentimentPoint {
  symbol: string;
  year: number;
  month: number;
  change: number;
  mspr: number;
}

export interface FinnhubAnalystRecommendation {
  /** 0-100, share of analyst-weighted consensus toward Buy (100) vs Sell (0). 50 = split down the middle. */
  score: number | null;
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
  /** "YYYY-MM-DD" of the period this consensus snapshot covers. */
  period: string | null;
}

const LOOKBACK_MONTHS = 6;
// Insider filings are sparse, discrete events — a large buy stays meaningful for a
// while, but its weight should still fade if nothing has happened since. ~3 months
// halves the influence of an otherwise-uncorroborated filing.
const HALF_LIFE_MONTHS = 3;

/**
 * Fetches insider trading sentiment from Finnhub's /stock/insider-sentiment endpoint
 * (free tier) and reduces it to a single 0-100 score, weighting each reported month
 * by both the actual share volume traded (so a 0-share month can't dilute a real
 * filing) and recency (so an old filing gradually fades if nothing corroborates it).
 * Finnhub's /news-sentiment endpoint (news score + buzz) is premium-only and not
 * available on a free API key — callers should treat that data as unavailable.
 */
export async function getFinnhubInsiderSentiment(symbol: string): Promise<FinnhubInsiderSentiment> {
  const apiKey = process.env.FINNHUB_API_KEY;
  const defaultRes: FinnhubInsiderSentiment = { insiderSentiment: null, monthsSampled: 0, mostRecentMonth: null };
  if (!apiKey) return defaultRes;

  const to = new Date();
  const from = new Date(to);
  from.setMonth(from.getMonth() - LOOKBACK_MONTHS);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  try {
    const url = `https://finnhub.io/api/v1/stock/insider-sentiment?symbol=${encodeURIComponent(symbol.toUpperCase())}&from=${fmt(from)}&to=${fmt(to)}&token=${apiKey}`;
    const response = await fetch(url);
    if (!response.ok) {
      console.warn(`[Finnhub] insider-sentiment failed for ${symbol}: ${response.status} ${response.statusText}`);
      return defaultRes;
    }

    const body = await response.json() as { data?: InsiderSentimentPoint[] };
    const points = body.data ?? [];
    if (points.length === 0) return defaultRes;

    const nowYear = to.getUTCFullYear();
    const nowMonth = to.getUTCMonth() + 1;

    let weightedSum = 0;
    let totalWeight = 0;
    let monthsSampled = 0;
    let mostRecent: { year: number; month: number } | null = null;

    for (const p of points) {
      const monthsAgo = (nowYear - p.year) * 12 + (nowMonth - p.month);
      if (monthsAgo < 0) continue; // defensive: ignore any future-dated rows

      if (!mostRecent || p.year > mostRecent.year || (p.year === mostRecent.year && p.month > mostRecent.month)) {
        mostRecent = { year: p.year, month: p.month };
      }

      const recencyWeight = Math.pow(0.5, monthsAgo / HALF_LIFE_MONTHS);
      const magnitudeWeight = Math.abs(p.change);
      const weight = magnitudeWeight * recencyWeight;
      if (weight > 0) {
        weightedSum += p.mspr * weight;
        totalWeight += weight;
        monthsSampled++;
      }
    }

    const mostRecentMonth = mostRecent ? `${mostRecent.year}-${String(mostRecent.month).padStart(2, '0')}` : null;

    if (totalWeight === 0) {
      // Filings exist but none moved any shares — there's no real signal to score.
      return { insiderSentiment: null, monthsSampled: 0, mostRecentMonth };
    }

    const weightedMspr = weightedSum / totalWeight;
    // mspr is roughly -100 (heavy selling) to +100 (heavy buying); 0 = neutral.
    const insiderSentiment = Math.round(Math.min(100, Math.max(0, (weightedMspr + 100) / 2)));

    return { insiderSentiment, monthsSampled, mostRecentMonth };
  } catch (error) {
    console.error(`[Finnhub] Error fetching insider sentiment for ${symbol}:`, error);
    return defaultRes;
  }
}

interface RecommendationTrendPoint {
  symbol: string;
  period: string;
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
}

/**
 * Fetches analyst recommendation trends from Finnhub's /stock/recommendation
 * endpoint (free tier) and reduces the most recent period to a single 0-100
 * consensus score. Unlike /stock/social-sentiment, /upgrade-downgrade, and
 * /price-target (all premium-only on a free key), this one is accessible.
 */
export async function getFinnhubAnalystRecommendation(symbol: string): Promise<FinnhubAnalystRecommendation> {
  const apiKey = process.env.FINNHUB_API_KEY;
  const defaultRes: FinnhubAnalystRecommendation = { score: null, strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0, period: null };
  if (!apiKey) return defaultRes;

  try {
    const url = `https://finnhub.io/api/v1/stock/recommendation?symbol=${encodeURIComponent(symbol.toUpperCase())}&token=${apiKey}`;
    const response = await fetch(url);
    if (!response.ok) {
      console.warn(`[Finnhub] recommendation failed for ${symbol}: ${response.status} ${response.statusText}`);
      return defaultRes;
    }

    const points = await response.json() as RecommendationTrendPoint[];
    if (!Array.isArray(points) || points.length === 0) return defaultRes;

    // Finnhub returns periods newest-first.
    const latest = points[0]!;
    const total = latest.strongBuy + latest.buy + latest.hold + latest.sell + latest.strongSell;
    if (total === 0) {
      return { score: null, strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0, period: latest.period };
    }

    const net = latest.strongBuy * 2 + latest.buy - latest.sell - latest.strongSell * 2;
    const score = Math.round(50 + 25 * (net / total));

    return {
      score: Math.min(100, Math.max(0, score)),
      strongBuy: latest.strongBuy,
      buy: latest.buy,
      hold: latest.hold,
      sell: latest.sell,
      strongSell: latest.strongSell,
      period: latest.period,
    };
  } catch (error) {
    console.error(`[Finnhub] Error fetching analyst recommendation for ${symbol}:`, error);
    return defaultRes;
  }
}
