import { getOptionsChainYahoo } from './yahoo.js';
import { getOptionsChain as getOptionsChainPolygon, PolygonOptionsContract } from './polygon.js';

export async function fetchOptionsChainWithFallback(
  symbol: string,
  expiryStr?: string
): Promise<{ expirations: string[]; contracts: PolygonOptionsContract[]; quote?: any }> {
  try {
    // Polygon is the licensed source of record. Yahoo is a degraded fallback only.
    return await getOptionsChainPolygon(symbol, expiryStr);
  } catch (polygonErr: any) {
    console.warn(`Polygon options fetch failed for ${symbol}: ${polygonErr.message}. Falling back to Yahoo Finance...`);
    
    try {
      return await getOptionsChainYahoo(symbol, expiryStr);
    } catch (yahooErr: any) {
      console.error(`Yahoo Finance fallback also failed for ${symbol}:`, yahooErr);
      throw new Error(`Failed to fetch options chain for ${symbol} from all providers.`);
    }
  }
}
