import { yf } from '../services/yahoo.js';
import type { APIGatewayProxyResultV2 } from '../types.js';
import { jsonResponse } from '../index.js';

export interface SymbolSearchResult {
  symbol: string;
  name: string;
  exchange: string;
  quoteType: string;
}

/**
 * GET /api/search/symbols?q=...
 *
 * Returns ticker symbol matches from Yahoo Finance search.
 */
export async function searchSymbols(
  event: any,
): Promise<APIGatewayProxyResultV2> {
  const query = event.queryStringParameters?.['q']?.trim();
  if (!query || query.length < 1) {
    return jsonResponse(400, { error: '"q" query parameter is required' });
  }

  try {
    const provider = event?.headers?.['x-data-provider']?.toLowerCase();
    const { searchSymbolsProviderAware } = await import('../services/providerService.js');
    const results = await searchSymbolsProviderAware(query, provider);
    
    return jsonResponse(200, { results });
  } catch (err) {
    console.error('Symbol search error:', err);
    return jsonResponse(500, { error: 'Failed to search symbols' });
  }
}
