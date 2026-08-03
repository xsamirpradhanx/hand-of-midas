import { getOptionsChainYahoo } from './yahoo.js';
import { getOptionsChain as getOptionsChainPolygon, PolygonOptionsContract } from './polygon.js';

let polygonOptionsDisabled = false;

export async function fetchOptionsChainWithFallback(
  symbol: string,
  expiryStr?: string
): Promise<{ expirations: string[]; contracts: PolygonOptionsContract[]; quote?: any }> {
  if (!polygonOptionsDisabled) {
    try {
      // Polygon is the licensed source of record. Yahoo is a degraded fallback only.
      return await getOptionsChainPolygon(symbol, expiryStr);
    } catch (polygonErr: any) {
      if (polygonErr.message.includes('403')) {
        console.warn(`Polygon options 403 for ${symbol} — disabling for this session.`);
        polygonOptionsDisabled = true;
      } else {
        console.warn(`Polygon options fetch failed for ${symbol}: ${polygonErr.message}. Falling back to Yahoo Finance...`);
      }
    }
  }
    
  try {
    return await getOptionsChainYahoo(symbol, expiryStr);
  } catch (yahooErr: any) {
    console.error(`Yahoo Finance fallback also failed for ${symbol}:`, yahooErr);
    throw new Error(`Failed to fetch options chain for ${symbol} from all providers.`);
  }
}
