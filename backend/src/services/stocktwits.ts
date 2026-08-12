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

/**
 * Fetches the most recent messages for a ticker from Stocktwits
 * and calculates the immediate retail sentiment ratio.
 */
export async function getStocktwitsSentiment(symbol: string): Promise<StocktwitsSentiment> {
  const sym = symbol.toUpperCase();
  const url = `https://api.stocktwits.com/api/2/streams/symbol/${sym}.json`;
  
  const defaultRes: StocktwitsSentiment = { bullish: 0, bearish: 0, ratio: 1, watchlistCount: 0, volumeChange: 0, sentimentChange: 0, messages: [] };

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      }
    });

    if (!response.ok) {
      if (response.status === 429) {
        console.warn(`[Stocktwits] Rate limit exceeded for ${sym}`);
      } else {
        console.warn(`[Stocktwits] Failed to fetch data for ${sym}: ${response.status} ${response.statusText}`);
      }
      return defaultRes;
    }

    const data = await response.json();
    const messages: StocktwitsMessage[] = data.messages || [];
    
    // Extract metadata from the first symbol object returned
    const symbolMeta = data.symbol || {};
    const watchlistCount = symbolMeta.watchlist_count || 0;
    const volumeChange = symbolMeta.volume_change || 0;
    const sentimentChange = symbolMeta.sentiment_change || 0;

    let bullish = 0;
    let bearish = 0;

    for (const msg of messages) {
      const sentiment = msg.entities?.sentiment?.basic;
      if (sentiment === 'Bullish') {
        bullish++;
      } else if (sentiment === 'Bearish') {
        bearish++;
      }
    }

    const ratio = bearish > 0 ? (bullish / bearish) : (bullish > 0 ? bullish : 1);

    return {
      bullish,
      bearish,
      ratio,
      watchlistCount,
      volumeChange,
      sentimentChange,
      messages: messages.slice(0, 15), // Return top 15 messages for the feed
    };
  } catch (error) {
    console.error(`[Stocktwits] Error fetching stream for ${sym}:`, error);
    return defaultRes;
  }
}
