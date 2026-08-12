import {
  getCachedData,
  setCachedData,
} from '../services/cache.js';
import { yf } from '../services/yahoo.js';
import type { APIGatewayProxyResultV2 } from '../types.js';
import { jsonResponse } from '../index.js';
import { withCoalescing } from '../utils/inflight.js';

const CACHE_KEY = 'CACHE#MARKET_INTERNALS';
const TTL_SECONDS = 15;

export async function getMarketInternals(): Promise<APIGatewayProxyResultV2> {
  const cached = await getCachedData(CACHE_KEY);
  if (cached) {
    return jsonResponse(200, cached);
  }

  const symbols = [
    '^VIX',
    'SPY', 'QQQ', 'DIA', 'IWM',
    'NVDA', 'AAPL', 'MSFT',
    'BTC-USD', 'ETH-USD',
    'GC=F', 'SI=F', 'CL=F', 'NG=F',
    'DX-Y.NYB', 'EURUSD=X', 'USDJPY=X', 'GBPUSD=X', 'AUDUSD=X', 'USDNPR=X', 'USDRUB=X',
    '^IRX', '^FVX', '^TNX', '^TYX',
  ];

  let results;
  try {
    results = await withCoalescing(CACHE_KEY, async () => {
      const fetchPromises = symbols.map(async (symbol) => {
        try {
          return await yf.quote(symbol);
        } catch (e) {
          console.error(`Error fetching quote for ${symbol}`, e);
          return null;
        }
      });
      return await Promise.all(fetchPromises);
    });
  } catch (err) {
    console.error('Yahoo quote fetch error for market internals:', err);
    return jsonResponse(500, { error: 'Failed to fetch market internals' });
  }

  const validResults = results.filter((r): r is NonNullable<typeof r> => r !== null && r.regularMarketPrice !== undefined);

  const vixRaw = validResults.find(r => r.symbol === '^VIX');

  const indicesSymbols = ['SPY', 'QQQ', 'DIA', 'IWM'];
  const leadersSymbols = ['NVDA', 'AAPL', 'MSFT'];
  const cryptoSymbols = ['BTC-USD', 'ETH-USD'];
  const commoditySymbols = ['GC=F', 'SI=F', 'CL=F', 'NG=F'];
  const forexSymbols = ['DX-Y.NYB', 'EURUSD=X', 'USDJPY=X', 'GBPUSD=X', 'AUDUSD=X', 'USDNPR=X', 'USDRUB=X'];
  const bondSymbols = ['^IRX', '^FVX', '^TNX', '^TYX'];

  const mapData = (syms: string[]) => syms.map(sym => {
    const raw = validResults.find(r => r.symbol === sym);
    if (!raw) return null;
    return {
      symbol: raw.symbol ?? sym,
      name: raw.longName ?? raw.shortName ?? sym,
      price: raw.regularMarketPrice ?? 0,
      change: raw.regularMarketChange ?? 0,
      changePercent: raw.regularMarketChangePercent ?? 0,
    };
  }).filter((x): x is NonNullable<typeof x> => x !== null);

  const responseData = {
    vix: vixRaw ? {
      price: vixRaw.regularMarketPrice ?? 0,
      change: vixRaw.regularMarketChange ?? 0,
      changePercent: vixRaw.regularMarketChangePercent ?? 0,
    } : null,
    indices: mapData(indicesSymbols),
    leaders: mapData(leadersSymbols),
    crypto: mapData(cryptoSymbols),
    commodities: mapData(commoditySymbols),
    forex: mapData(forexSymbols),
    bonds: mapData(bondSymbols),
  };

  void setCachedData(CACHE_KEY, responseData, TTL_SECONDS).catch(
    (err: unknown) => {
      console.error('Failed to write market internals to cache', err);
    },
  );

  return jsonResponse(200, responseData);
}
