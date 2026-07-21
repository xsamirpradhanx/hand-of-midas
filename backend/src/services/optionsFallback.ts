import { getOptionsChainYahoo } from './yahoo.js';
import { getOptionsChain as getOptionsChainPolygon, PolygonOptionsContract } from './polygon.js';

export async function fetchOptionsChainWithFallback(
  symbol: string,
  expiryStr?: string
): Promise<{ expirations: string[]; contracts: PolygonOptionsContract[]; quote?: any }> {
  try {
    // Attempt 1: Yahoo Finance
    return await getOptionsChainYahoo(symbol, expiryStr);
  } catch (yahooErr: any) {
    console.warn(`Yahoo Finance options fetch failed for ${symbol}: ${yahooErr.message}. Falling back to Polygon...`);
    
    try {
      // Attempt 2: Polygon
      return await getOptionsChainPolygon(symbol, expiryStr);
    } catch (polygonErr: any) {
      console.error(`Polygon options fallback also failed for ${symbol}:`, polygonErr);
      throw new Error(`Failed to fetch options chain for ${symbol} from all providers.`);
    }
  }
}
