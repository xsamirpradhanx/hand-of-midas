export interface StocktwitsMessage {
  id: number;
  body: string;
  created_at: string;
  user: {
    id: number;
    username: string;
    name: string;
    avatar_url: string;
    avatar_url_ssl: string;
    followers: number;
    ideas: number;
  };
  entities?: {
    sentiment?: {
      basic: 'Bullish' | 'Bearish';
    };
  };
}

export interface StocktwitsSentiment {
  bullish: number;
  bearish: number;
  ratio: number; // Bullish to Bearish ratio
  watchlistCount: number;
  volumeChange: number;
  sentimentChange: number;
  messages: StocktwitsMessage[];
}

// Stocktwits' free public stream endpoint returns ~30 messages per page, but
// only a fraction of posters actually tag Bullish/Bearish — a single page can
// leave the ratio computed from a dozen or so tagged messages. There's no
// self-service aggregate-sentiment API (that lives behind Stocktwits'
// enterprise product, gated on contacting enterprise-support@stocktwits.com),
// so instead we paginate this endpoint via its `max` cursor to widen the
// tagged-message sample.
const SENTIMENT_PAGES = 4;

/**
 * Fetches several pages of recent messages for a ticker from Stocktwits
 * and calculates the retail sentiment ratio over the combined sample.
 */
export async function getStocktwitsSentiment(symbol: string): Promise<StocktwitsSentiment> {
  const sym = symbol.toUpperCase();
  const baseUrl = `https://api.stocktwits.com/api/2/streams/symbol/${sym}.json`;

  const defaultRes: StocktwitsSentiment = { bullish: 0, bearish: 0, ratio: 1, watchlistCount: 0, volumeChange: 0, sentimentChange: 0, messages: [] };

  let bullish = 0;
  let bearish = 0;
  let watchlistCount = 0;
  let volumeChange = 0;
  let sentimentChange = 0;
  let feedMessages: StocktwitsMessage[] = [];
  let sawAnyPage = false;
  let maxId: number | undefined;

  for (let page = 0; page < SENTIMENT_PAGES; page++) {
    const url = maxId ? `${baseUrl}?max=${maxId}` : baseUrl;
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        }
      });

      if (!response.ok) {
        if (response.status === 429) {
          console.warn(`[Stocktwits] Rate limit exceeded for ${sym} (page ${page + 1})`);
        } else {
          console.warn(`[Stocktwits] Failed to fetch data for ${sym}: ${response.status} ${response.statusText}`);
        }
        break; // Keep whatever sample we've accumulated so far.
      }

      const data = await response.json() as {
        messages?: StocktwitsMessage[];
        symbol?: { watchlist_count?: number; volume_change?: number; sentiment_change?: number };
        cursor?: { max?: number; more?: boolean };
      };
      const messages: StocktwitsMessage[] = data.messages || [];
      if (messages.length === 0) break;
      sawAnyPage = true;

      if (page === 0) {
        // Metadata and the feed preview only need the first (most recent) page.
        const symbolMeta = data.symbol || {};
        watchlistCount = symbolMeta.watchlist_count || 0;
        volumeChange = symbolMeta.volume_change || 0;
        sentimentChange = symbolMeta.sentiment_change || 0;
        feedMessages = messages.slice(0, 15);
      }

      for (const msg of messages) {
        const sentiment = msg.entities?.sentiment?.basic;
        if (sentiment === 'Bullish') {
          bullish++;
        } else if (sentiment === 'Bearish') {
          bearish++;
        }
      }

      maxId = data.cursor?.max;
      if (!data.cursor?.more || maxId == null) break;
    } catch (error) {
      console.error(`[Stocktwits] Error fetching stream for ${sym} (page ${page + 1}):`, error);
      break;
    }
  }

  if (!sawAnyPage) return defaultRes;

  const ratio = bearish > 0 ? (bullish / bearish) : (bullish > 0 ? bullish : 1);

  return {
    bullish,
    bearish,
    ratio,
    watchlistCount,
    volumeChange,
    sentimentChange,
    messages: feedMessages,
  };
}
