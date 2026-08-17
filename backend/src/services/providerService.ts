import { fetchOptionsChainWithFallback } from './optionsFallback.js';
import { fetchOptionsChainSchwab, getQuoteSchwab, getPriceHistorySchwab } from './schwabService.js';
import { getQuote as getQuotePolygon } from './polygon.js';
import { yf, getOptionsChainYahoo } from './yahoo.js';
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
  let currentPrice = raw.regularMarketPrice ?? 0;
  let currentChange = raw.regularMarketChange ?? 0;
  let currentChangePercent = raw.regularMarketChangePercent ?? 0;

  const isPreMarket = raw.marketState === 'PRE' || raw.marketState === 'PREPRE';
  const isPostMarket = raw.marketState === 'POST' || raw.marketState === 'POSTPOST' || raw.marketState === 'CLOSED';

  if (isPreMarket && raw.preMarketPrice !== undefined) {
    currentPrice = raw.preMarketPrice;
    currentChange = raw.preMarketChange ?? 0;
    currentChangePercent = raw.preMarketChangePercent ?? 0;
  } else if (isPostMarket && raw.postMarketPrice !== undefined) {
    currentPrice = raw.postMarketPrice;
    currentChange = raw.postMarketChange ?? 0;
    currentChangePercent = raw.postMarketChangePercent ?? 0;
  }

  return {
    symbol: raw.symbol ?? upperSymbol,
    name: raw.longName ?? raw.shortName ?? upperSymbol,
    longName: raw.longName,
    shortName: raw.shortName,
    regularMarketPrice: raw.regularMarketPrice ?? 0,
    regularMarketChange: raw.regularMarketChange ?? 0,
    regularMarketChangePercent: raw.regularMarketChangePercent ?? 0,
    price: currentPrice,
    change: currentChange,
    changePercent: currentChangePercent,
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
  const isYahoo = provider === 'yahoo';
  const isPolygon = provider === 'polygon';
  // Default (no explicit provider) = Schwab primary, Yahoo fallback.
  // Polygon is opt-in only per data-source policy — matches getQuoteProviderAware
  // / getMarketDataProviderAware. Previously only explicit ?provider=schwab hit
  // Schwab; every unparameterized call (options chain by symbol, GEX/gamma-flip
  // routes) silently fell to fetchOptionsChainWithFallback's Polygon-first pipeline.
  const preferSchwab = !isYahoo && !isPolygon;

  if (preferSchwab) {
    try {
      const res = await fetchOptionsChainSchwab(symbol, expiryStr);
      return { ...res, source: 'schwab' };
    } catch (err) {
      console.warn(`Schwab options fetch failed for ${symbol}: ${err instanceof Error ? err.message : String(err)}. Falling back to Yahoo...`);
    }
  }

  // --- Polygon (explicit selection only, via its own Polygon->Yahoo pipeline) ---
  if (isPolygon) {
    return fetchOptionsChainWithFallback(symbol, expiryStr);
  }

  // --- Yahoo (explicit selection, or final fallback when Schwab failed above).
  // Deliberately NOT fetchOptionsChainWithFallback here — that pipeline tries
  // Polygon first, which would reintroduce the silent-Polygon-default bug for
  // callers who never opted into Polygon. ---
  const data = await getOptionsChainYahoo(symbol, expiryStr);
  return { ...data, source: 'yahoo' };
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
  // Default (no explicit provider) = Schwab primary, Yahoo fallback.
  // Polygon is opt-in only per data-source policy.
  const preferSchwab = isSchwab || (!isYahoo && !isPolygon);

  // --- Schwab (default or explicit) ---
  if (preferSchwab) {
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

  // --- Polygon (explicit selection only) ---
  if (isPolygon) {
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

/**
 * Default for the `extendedHours` flag when a caller doesn't specify one.
 * Schwab's quote already reflects the latest price regardless of session
 * (pre/post-market), so its price-history calls don't need extended-hours
 * data by default. Yahoo's "synthesize today's candle" logic relies on
 * pre/post-market data to stay current, so it defaults to on.
 */
export function resolveExtendedHoursDefault(provider?: string): boolean {
  const isYahoo = provider === 'yahoo';
  const isPolygon = provider === 'polygon';
  const preferSchwab = !isYahoo && !isPolygon;
  return !preferSchwab;
}

// ---------------------------------------------------------------------------
// Provider-aware market data (OHLCV)
// ---------------------------------------------------------------------------
export async function getMarketDataProviderAware(
  symbol: string,
  interval: string = '1day',
  extendedHours?: boolean,
  provider?: string
): Promise<{ data: any[]; source: string }> {
  const isSchwab = provider === 'schwab';
  const isYahoo = provider === 'yahoo';
  const isPolygon = provider === 'polygon';
  // Default (no explicit provider) = Schwab primary, Yahoo fallback.
  const preferSchwab = isSchwab || (!isYahoo && !isPolygon);
  const resolvedExtendedHours = extendedHours ?? resolveExtendedHoursDefault(provider);

  // --- Schwab (default or explicit) ---
  if (preferSchwab) {
    try {
      const data = await getPriceHistorySchwab(symbol, interval, resolvedExtendedHours);
      if (data.length > 0) return { data, source: 'schwab' };
      console.warn(`Schwab returned no bars for ${symbol} ${interval}; falling back to Yahoo.`);
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
      includePrePost: resolvedExtendedHours
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
      // Synthesize or update today's candle for 1d interval
      if (yfInterval === '1d' && data.length > 0) {
        try {
          const q = await yf.quote(symbol);
          if (q) {
            const lastCandle = data[data.length - 1];
            const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
            
            if (todayStr > lastCandle.datetime) {
              // Missing today's candle, synthesize it
              if ((q.marketState === 'PRE' || q.marketState === 'PREPRE') && !resolvedExtendedHours) {
                // If extended hours are off, do not synthesize today's candle until regular market opens
              } else {
                let o, h, l, c, v;
                if (q.marketState === 'PRE' || q.marketState === 'PREPRE') {
                  o = h = l = c = q.preMarketPrice || q.regularMarketPrice || 0;
                  v = 0;
                } else {
                  o = q.regularMarketOpen || q.regularMarketPrice || 0;
                  h = q.regularMarketDayHigh || q.regularMarketPrice || 0;
                  l = q.regularMarketDayLow || q.regularMarketPrice || 0;
                  c = q.regularMarketPrice || 0;
                  v = q.regularMarketVolume || 0;
                  if (resolvedExtendedHours && (q.marketState === 'POST' || q.marketState === 'CLOSED') && q.postMarketPrice) {
                    c = q.postMarketPrice;
                    h = Math.max(h, c);
                    l = Math.min(l, c);
                  }
                }
                if (c > 0) {
                  data.push({
                    datetime: todayStr,
                    open: o.toString(),
                    high: h.toString(),
                    low: l.toString(),
                    close: c.toString(),
                    volume: v.toString()
                  });
                }
              }
            } else if (todayStr === lastCandle.datetime) {
              // Update today's candle with live data
              if (q.marketState === 'REGULAR') {
                 if (q.regularMarketPrice) lastCandle.close = q.regularMarketPrice.toString();
                 if (q.regularMarketDayHigh) lastCandle.high = Math.max(parseFloat(lastCandle.high), q.regularMarketDayHigh).toString();
                 if (q.regularMarketDayLow) lastCandle.low = Math.min(parseFloat(lastCandle.low), q.regularMarketDayLow).toString();
                 if (q.regularMarketVolume) lastCandle.volume = q.regularMarketVolume.toString();
              } else if (resolvedExtendedHours && (q.marketState === 'POST' || q.marketState === 'CLOSED') && q.postMarketPrice) {
                 lastCandle.close = q.postMarketPrice.toString();
                 lastCandle.high = Math.max(parseFloat(lastCandle.high), q.postMarketPrice).toString();
                 lastCandle.low = Math.min(parseFloat(lastCandle.low), q.postMarketPrice).toString();
              }
            }
          }
        } catch (e) {
          console.warn(`Could not synthesize today's candle for ${symbol}:`, e);
        }
      }

      return { data, source: 'yahoo' };
    }
  } catch (yfErr) {
    console.error(`Yahoo Finance market data failed for ${symbol}:`, yfErr instanceof Error ? yfErr.message : yfErr);
  }

  return { data: [], source: 'yahoo' };
}

// ---------------------------------------------------------------------------
// Provider-aware Symbol Search
// ---------------------------------------------------------------------------
export async function searchSymbolsProviderAware(
  query: string,
  provider?: string
): Promise<any[]> {
  const isPolygon = provider === 'polygon';
  const isTwelveData = provider === 'twelvedata';

  if (isPolygon) {
    try {
      const { searchTickers } = await import('./polygon.js');
      return await searchTickers(query);
    } catch (e) {
      console.warn('Polygon search failed, falling back to Yahoo Finance');
    }
  }

  if (isTwelveData) {
    try {
      const { searchTickers } = await import('./twelvedata.js');
      return await searchTickers(query);
    } catch (e) {
      console.warn('TwelveData search failed, falling back to Yahoo Finance');
    }
  }

  // Default / Fallback: Yahoo Finance
  const result = await yf.search(query, { quotesCount: 10, newsCount: 0 });
  return (result.quotes || [])
    .filter((q: any) => q.symbol && q.quoteType !== 'OPTION')
    .slice(0, 8)
    .map((q: any) => ({
      symbol: q.symbol,
      name: q.longname || q.shortname || q.symbol,
      exchange: q.exchDisp || q.exchange || '',
      quoteType: q.quoteType || q.typeDisp || 'EQUITY',
    }));
}
