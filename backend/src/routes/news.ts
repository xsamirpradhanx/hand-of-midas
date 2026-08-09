import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from '../types.js';
import { jsonResponse } from '../utils/response.js';
import { queryItems } from '../services/dynamodb.js';
import { yf } from '../services/yahoo.js';
import type { WatchlistItem } from '../types.js';

function getUserId(event: APIGatewayProxyEventV2): string | null {
  return event.requestContext?.authorizer?.jwt?.claims['sub'] ?? null;
}

export async function getWatchlistNews(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  try {
    const userId = getUserId(event);
    if (!userId) {
      return jsonResponse(401, { error: 'Unauthorized' });
    }

    // 1. Fetch user's watchlist
    const watchlist = await queryItems<WatchlistItem>(`USER#${userId}`, 'WATCHLIST#');
    
    if (!watchlist || watchlist.length === 0) {
      return jsonResponse(200, []);
    }

    // 2. Fetch news for each symbol
    const newsPromises = watchlist.map(async (item) => {
      try {
        const searchResult = await yf.search(item.symbol, { newsCount: 5 });
        return (searchResult.news || []).map(article => ({
          ...article,
          relatedSymbol: item.symbol,
        }));
      } catch (err) {
        console.error(`Failed to fetch news for ${item.symbol}:`, err);
        return [];
      }
    });

    const newsArrays = await Promise.all(newsPromises);
    
    // 3. Flatten, deduplicate by UUID, and sort
    const uniqueNews = new Map<string, any>();
    
    for (const arr of newsArrays) {
      for (const article of arr) {
        // If an article talks about multiple symbols in our watchlist, 
        // we keep the first one we find or aggregate symbols. For simplicity, keep first.
        if (!uniqueNews.has(article.uuid)) {
          uniqueNews.set(article.uuid, article);
        }
      }
    }

    const mergedNews = Array.from(uniqueNews.values());
    mergedNews.sort((a, b) => {
      // providerPublishTime is usually a Date or Unix timestamp.
      // yahoo-finance2 search returns providerPublishTime as a Date object or Unix epoch.
      const timeA = new Date(a.providerPublishTime).getTime();
      const timeB = new Date(b.providerPublishTime).getTime();
      return timeB - timeA;
    });

    // Return top 50 recent news items
    return jsonResponse(200, mergedNews.slice(0, 50));

  } catch (err: any) {
    console.error('Failed to get watchlist news:', err);
    return jsonResponse(500, { error: 'Failed to get watchlist news' });
  }
}
