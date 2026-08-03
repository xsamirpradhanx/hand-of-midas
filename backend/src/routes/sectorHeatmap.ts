import {
  getCachedData,
  setCachedData,
} from '../services/cache.js';
import { yf } from '../services/yahoo.js';
import type { APIGatewayProxyResultV2 } from '../types.js';
import { jsonResponse } from '../index.js';
import { withCoalescing } from '../utils/inflight.js';

const CACHE_KEY = 'CACHE#SECTORS';
const TTL_SECONDS = 15;

const SECTORS_INFO = [
  { symbol: 'XLK', name: 'Technology' },
  { symbol: 'XLF', name: 'Financials' },
  { symbol: 'XLE', name: 'Energy' },
  { symbol: 'XLV', name: 'Healthcare' },
  { symbol: 'XLI', name: 'Industrials' },
  { symbol: 'XLP', name: 'Consumer Staples' },
  { symbol: 'XLU', name: 'Utilities' },
  { symbol: 'XLRE', name: 'Real Estate' },
  { symbol: 'XLC', name: 'Communication Services' },
  { symbol: 'XLB', name: 'Materials' },
  { symbol: 'XLY', name: 'Consumer Discretionary' },
  { symbol: 'SMH', name: 'Semiconductors' },
  { symbol: 'XBI', name: 'Biotech' },
  { symbol: 'KRE', name: 'Regional Banks' },
  { symbol: 'XRT', name: 'Retail' },
  { symbol: 'XHB', name: 'Homebuilders' },
  { symbol: 'ITA', name: 'Aerospace & Defense' },
  { symbol: 'ICLN', name: 'Clean Energy' }
];

export async function getSectors(): Promise<APIGatewayProxyResultV2> {
  const cached = await getCachedData(CACHE_KEY);
  if (cached) {
    return jsonResponse(200, cached);
  }

  let results;
  try {
    results = await withCoalescing(CACHE_KEY, async () => {
      const fetchPromises = SECTORS_INFO.map(async (info) => {
        try {
          return await yf.quote(info.symbol);
        } catch (e) {
          console.error(`Error fetching quote for ${info.symbol}`, e);
          return null;
        }
      });
      return await Promise.all(fetchPromises);
    });
  } catch (err) {
    console.error('Yahoo quote fetch error for sector heatmap:', err);
    return jsonResponse(500, { error: 'Failed to fetch sector heatmap' });
  }

  const validResults = results.filter((r): r is NonNullable<typeof r> => r !== null && r.regularMarketPrice !== undefined);

  let sectors = SECTORS_INFO.map(info => {
    const raw = validResults.find(r => r.symbol === info.symbol);
    if (!raw) return null;
    return {
      symbol: info.symbol,
      name: info.name,
      price: raw.regularMarketPrice ?? 0,
      change: raw.regularMarketChange ?? 0,
      changePercent: raw.regularMarketChangePercent ?? 0,
    };
  }).filter((x): x is NonNullable<typeof x> => x !== null);

  // Sort by changePercent descending (best performing first)
  sectors.sort((a, b) => b.changePercent - a.changePercent);

  const responseData = { sectors };

  void setCachedData(CACHE_KEY, responseData, TTL_SECONDS).catch(
    (err: unknown) => {
      console.error('Failed to write sector heatmap to cache', err);
    },
  );

  return jsonResponse(200, responseData);
}
