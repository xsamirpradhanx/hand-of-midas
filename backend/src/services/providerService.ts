import { fetchOptionsChainWithFallback } from './optionsFallback.js';
import { fetchOptionsChainSchwab, getQuoteSchwab, getPriceHistorySchwab } from './schwabService.js';
import { getQuote as getQuotePolygon } from './polygon.js';
import { yf } from './yahoo.js';
import type { PolygonOptionsContract } from './polygon.js';

// ---------------------------------------------------------------------------
// Normalized quote shape — all providers converge to this so quote.ts works.
// ---------------------------------------------------------------------------
export interface NormalizedQuote {
  symbol: string;
  name: string;
  /** Used by quote.ts — must be present */
  regularMarketPrice: number;
  regularMarketChange: number;
  regularMarketChangePercent: number;
  price: number;
  change: number;
  changePercent: number;
  volume?: number;
  bid?: number;
  ask?: number;
  marketState?: string;
  postMarketPrice?: number;
  postMarketChange?: number;
  postMarketChangePercent?: number;
  preMarketPrice?: number;
  preMarketChange?: number;
  preMarketChangePercent?: number;
  longName?: string;
  shortName?: string;
}

function normalizePolygonQuote(data: any, upperSymbol: string): NormalizedQuote {
  return {
    symbol: data.symbol ?? upperSymbol,
    name: data.name ?? upperSymbol,
    regularMarketPrice: data.price ?? 0,
    regularMarketChange: data.change ?? 0,
    regularMarketChangePercent: data.changePercent ?? 0,
    price: data.price ?? 0,
    change: data.change ?? 0,
    changePercent: data.changePercent ?? 0,
    volume: data.volume,
    bid: data.bid,
    ask: data.ask,
  };
}

function normalizeSchwabQuote(data: any, upperSymbol: string): NormalizedQuote {
  return {
    symbol: data.symbol ?? upperSymbol,
    name: data.name ?? upperSymbol,
    regularMarketPrice: data.regularMarketPrice ?? data.price ?? 0,
    regularMarketChange: data.change ?? 0,
    regularMarketChangePercent: data.changePercent ?? 0,
    price: data.regularMarketPrice ?? data.price ?? 0,
    change: data.change ?? 0,
    changePercent: data.changePercent ?? 0,
    volume: data.volume,
  };
}

function normalizeYahooQuote(raw: any, upperSymbol: string): NormalizedQuote {
  return {
    symbol: raw.symbol ?? upperSymbol,
    name: raw.longName ?? raw.shortName ?? upperSymbol,
    longName: raw.longName,
    shortName: raw.shortName,
    regularMarketPrice: raw.regularMarketPrice ?? 0,
    regularMarketChange: raw.regularMarketChange ?? 0,
    regularMarketChangePercent: raw.regularMarketChangePercent ?? 0,
    price: raw.regularMarketPrice ?? 0,
    change: raw.regularMarketChange ?? 0,
    changePercent: raw.regularMarketChangePercent ?? 0,
    volume: raw.regularMarketVolume,
    bid: raw.bid,
    ask: raw.ask,
    marketState: raw.marketState,
    postMarketPrice: raw.postMarketPrice,
    postMarketChange: raw.postMarketChange,
    postMarketChangePercent: raw.postMarketChangePercent,
    preMarketPrice: raw.preMarketPrice,
    preMarketChange: raw.preMarketChange,
    preMarketChangePercent: raw.preMarketChangePercent,
  };
}

// ---------------------------------------------------------------------------
// Provider-aware options chain
// ---------------------------------------------------------------------------
export async function fetchOptionsChainProviderAware(
  symbol: string,
  expiryStr?: string,
  provider?: string
): Promise<{ expirations: string[]; contracts: PolygonOptionsContract[]; quote?: any; source: string }> {
  const isSchwab = provider === 'schwab';
  
  if (isSchwab) {
    try {
      const res = await fetchOptionsChainSchwab(symbol, expiryStr);
      return { ...res, source: 'schwab' };
    } catch (err) {
      console.warn(`Schwab options fetch failed for ${symbol}: ${err instanceof Error ? err.message : String(err)}. Falling back to default pipeline...`);
    }
  }

  // Default pipeline handles Polygon -> Yahoo fallback
  return fetchOptionsChainWithFallback(symbol, expiryStr);
}

// ---------------------------------------------------------------------------
// Provider-aware quote — always returns a NormalizedQuote
// ---------------------------------------------------------------------------
export async function getQuoteProviderAware(
  symbol: string,
  provider?: string
): Promise<{ data: NormalizedQuote; source: string }> {
  const upperSymbol = symbol.toUpperCase();
  const isSchwab = provider === 'schwab';
  const isYahoo = provider === 'yahoo';
  const isPolygon = provider === 'polygon';

  // --- Schwab ---
  if (isSchwab) {
    try {
      const raw = await getQuoteSchwab(upperSymbol);
      const normalized = normalizeSchwabQuote(raw, upperSymbol);
      // Schwab quotes don't include company name — enrich with Yahoo Finance
      try {
        const yfRaw = await yf.quote(upperSymbol, { fields: ['longName', 'shortName'] });
        if (yfRaw?.longName || yfRaw?.shortName) {
          normalized.name = yfRaw.longName ?? yfRaw.shortName ?? upperSymbol;
          normalized.longName = yfRaw.longName;
          normalized.shortName = yfRaw.shortName;
        }
      } catch {
        // Non-fatal — name stays as ticker symbol
      }
      return { data: normalized, source: 'schwab' };
    } catch (err) {
      console.warn(`Schwab quote failed for ${upperSymbol}: ${err instanceof Error ? err.message : String(err)}. Falling back...`);
    }
  }

  // --- Polygon (explicit selection or default non-yahoo/schwab) ---
  if (isPolygon || (!isYahoo && !isSchwab)) {
    try {
      const raw = await getQuotePolygon(upperSymbol);
      return { data: normalizePolygonQuote(raw, upperSymbol), source: 'polygon' };
    } catch (err) {
      console.warn(`Polygon quote failed for ${upperSymbol}: ${err instanceof Error ? err.message : String(err)}. Falling back to Yahoo...`);
    }
  }

  // --- Yahoo (explicit selection or final fallback) ---
  try {
    const raw = await yf.quote(upperSymbol);
    if (!raw) throw new Error('No data returned from Yahoo Finance');
    return { data: normalizeYahooQuote(raw, upperSymbol), source: 'yahoo' };
  } catch (err) {
    console.error(`Yahoo quote also failed for ${upperSymbol}:`, err instanceof Error ? err.message : String(err));
    throw new Error(`Failed to fetch quote for ${upperSymbol} from all providers.`);
  }
}

// ---------------------------------------------------------------------------
// Provider-aware market data (OHLCV)
// ---------------------------------------------------------------------------
export async function getMarketDataProviderAware(
  symbol: string,
  interval: string = '1day',
  extendedHours: boolean = false,
  provider?: string
): Promise<{ data: any[]; source: string }> {
  const isSchwab = provider === 'schwab';
  const isPolygon = provider === 'polygon';

  // --- Schwab ---
  if (isSchwab) {
    try {
      const data = await getPriceHistorySchwab(symbol, interval, extendedHours);
      return { data, source: 'schwab' };
    } catch (err) {
      console.warn(`Schwab market data failed for ${symbol}: ${err instanceof Error ? err.message : String(err)}. Falling back...`);
    }
  }

  // --- Polygon market data placeholder (not yet implemented) ---
  if (isPolygon) {
    // Polygon OHLCV could be implemented here; for now fall through to Yahoo.
    console.warn(`Polygon market data not yet implemented, falling back to Yahoo Finance for ${symbol}.`);
  }

  // --- Yahoo Finance (default + fallback) ---
  const intervalMap: Record<string, string> = {
    '1min': '1m', '5min': '5m', '15min': '15m', '30min': '30m',
    '1h': '60m', '1day': '1d', '1week': '1wk', '1month': '1mo'
  };
  const yfInterval = intervalMap[interval] || '1d';

  let period1Time = Date.now() - 2 * 365 * 24 * 60 * 60 * 1000;
  if (yfInterval === '1m') {
    period1Time = Date.now() - 7 * 24 * 60 * 60 * 1000;
  } else if (yfInterval.endsWith('m') || yfInterval === '60m') {
    period1Time = Date.now() - 59 * 24 * 60 * 60 * 1000;
  }

  try {
    const yfData = await yf.chart(symbol, {
      interval: yfInterval as any,
      period1: new Date(period1Time),
      includePrePost: extendedHours
    });
    if (yfData && yfData.quotes) {
      const data = yfData.quotes.slice(-200).map(q => {
        let dtStr = '';
        if (yfInterval === '1m' || (yfInterval.endsWith('m') && yfInterval !== '1mo')) {
          dtStr = q.date.toISOString().replace('T', ' ').substring(0, 19);
        } else {
          dtStr = q.date.toISOString().split('T')[0];
        }
        return {
          datetime: dtStr,
          open: q.open?.toString() || '0',
          high: q.high?.toString() || '0',
          low: q.low?.toString() || '0',
          close: q.close?.toString() || '0',
          volume: q.volume?.toString() || '0',
        };
      }).filter(q => parseFloat(q.open) > 0);
      return { data, source: 'yahoo' };
    }
  } catch (yfErr) {
    console.error(`Yahoo Finance market data failed for ${symbol}:`, yfErr instanceof Error ? yfErr.message : yfErr);
  }

  return { data: [], source: 'yahoo' };
}
