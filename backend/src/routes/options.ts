import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from '../types.js';
import { jsonResponse } from '../utils/response.js';
import { getHistoricalRealizedVol as fetchHistoricalIV } from '../services/polygon.js';
import { fetchOptionsChainWithFallback } from '../services/optionsFallback.js';
import { fetchOptionsChainSchwab } from '../services/schwabService.js';
import { blackScholes, americanProxy, impliedVolatility , getRiskFreeRate } from '../services/greeks.js';
import { getDTE, getCalendarDTE, getTimeToExpiryYears } from '../services/tradingCalendar.js';
import { getUnusualActivity, scoreContract, getBaseline, computeWhaleScore } from '../services/unusualActivity.js';
import { getCachedData, setCachedData } from '../services/cache.js';
import { withCoalescing } from '../utils/inflight.js';

export interface OptionsContract {
  ticker: string;
  symbol: string;
  strike: number;
  expiry: string;
  dte: number;
  calendarDTE: number;
  type: 'call' | 'put';
  bid: number;
  ask: number;
  mid: number;
  last: number;
  volume: number;
  openInterest: number;
  volumeOIRatio: number;
  impliedVolatility: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
  intrinsicValue: number;
  timeValue: number;
  itm: boolean;
  whaleScore: number | null;
}

export async function getOptionsChain(
  event: APIGatewayProxyEventV2,
  params: Record<string, string>,
): Promise<APIGatewayProxyResultV2> {
  const symbol = params['symbol']?.toUpperCase();
  if (!symbol) {
    return jsonResponse(400, { error: '"symbol" is required' });
  }

  const expiryParam = event.queryStringParameters?.['expiry'];
  const providerHeader = event.headers?.['x-data-provider']?.toLowerCase();
  const isSchwab = providerHeader === 'schwab';
  const cacheKey = `OPTIONS_CHAIN_V4#${isSchwab ? 'SCHWAB' : 'DEFAULT'}#${symbol}${expiryParam ? `#${expiryParam}` : ''}`;
  
  const cached = await getCachedData<any>(cacheKey);
  if (cached) {
    return jsonResponse(200, cached, { 'X-Source-Provider': cached.source || 'cache' });
  }

  try {
    const providerHeader = event.headers?.['x-data-provider']?.toLowerCase();
    const isSchwab = providerHeader === 'schwab';
    
    let source = 'yahoo';
    let rawChain: any[] = [];
    let availableExpirations: string[] = [];
    let schwabQuote: any = null;

    if (isSchwab) {
      try {
        const res = await fetchOptionsChainSchwab(symbol, expiryParam);
        rawChain = res.contracts;
        availableExpirations = res.expirations;
        schwabQuote = res.quote;
        source = 'schwab';
      } catch (err) {
        console.warn(`Schwab options fetch failed for ${symbol}: ${err instanceof Error ? err.message : String(err)}. Falling back to default pipeline...`);
        // Fallthrough to default
      }
    }

    // Default pipeline (Polygon -> Yahoo)
    if (source !== 'schwab') {
      const fetchKey = `FETCH_OPTIONS#DEFAULT#${symbol}${expiryParam ? `#${expiryParam}` : ''}`;
      const res = await withCoalescing(fetchKey, () => fetchOptionsChainWithFallback(symbol, expiryParam));
      rawChain = res.contracts;
      availableExpirations = res.expirations;
      schwabQuote = res.quote;
      source = res.source || 'yahoo';
    }
    
    // Process chain
    const processedChain: Record<string, OptionsContract[]> = {};
    
    // Fetch real underlying price to use for intrinsic calculations
    let underlyingPrice = schwabQuote?.regularMarketPrice || 0;
    if (!underlyingPrice) {
      try {
        const { yf } = await import('../services/yahoo.js');
        const underlyingQuote = await yf.quote(symbol);
        underlyingPrice = underlyingQuote?.regularMarketPrice || 0;
      } catch (err) {
        console.error('Failed to fetch underlying price from Yahoo Finance:', err);
      }
    }

    for (const contract of rawChain) {
      const expiry = contract.details?.expiration_date || '';
      if (!expiry) continue;

      if (!processedChain[expiry]) {
        processedChain[expiry] = [];
      }

      const dte = await getDTE(expiry);
      const calendarDTE = await getCalendarDTE(expiry);
      const type = contract.details?.contract_type === 'call' ? 'call' : 'put';
      const strike = contract.details?.strike_price || 0;
      const bid = contract.last_quote?.bid || 0;
      const ask = contract.last_quote?.ask || 0;
      const last = contract.last_quote?.last || 0;
      const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : (last > 0 ? last : (bid || ask));
      const volume = contract.day?.volume || 0;
      const openInterest = contract.day?.open_interest || 0;
      const volumeOIRatio = openInterest > 0 ? volume / openInterest : 0;
      
      const itm = type === 'call' ? underlyingPrice > strike : underlyingPrice < strike;
      const intrinsicValue = Math.max(0, type === 'call' ? underlyingPrice - strike : strike - underlyingPrice);
      const timeValue = Math.max(0, mid - intrinsicValue);
      
      const iv = contract.implied_volatility || 0;
      let calculatedGreeks: Record<string, number> = (contract.greeks as any) || { delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0 };
      
      if (calculatedGreeks.delta === 0 && iv > 0 && underlyingPrice > 0 && dte >= 0) {
        const bs = blackScholes(underlyingPrice, strike, Math.max(1 / 365, getTimeToExpiryYears(expiry)), getRiskFreeRate(), iv, type);
        calculatedGreeks = { ...bs, rho: bs.rho };
      }

      const whaleScore = computeWhaleScore({
        volume,
        openInterest,
        price: mid,
        dte,
      });
      
      const contractData: OptionsContract = {
        ticker: contract.ticker || '',
        symbol,
        strike,
        expiry,
        dte,
        calendarDTE,
        type,
        bid,
        ask,
        mid,
        last,
        volume,
        openInterest,
        volumeOIRatio,
        impliedVolatility: iv,
        delta: calculatedGreeks.delta || 0,
        gamma: calculatedGreeks.gamma || 0,
        theta: calculatedGreeks.theta || 0,
        vega: calculatedGreeks.vega || 0,
        rho: (calculatedGreeks as any).rho || 0,
        intrinsicValue,
        timeValue,
        itm,
        whaleScore,
      };
      
      processedChain[expiry].push(contractData);
    }
    
    for (const expiry in processedChain) {
      processedChain[expiry].sort((a, b) => a.strike - b.strike);
    }
    
    const responseData = {
      symbol,
      underlyingPrice,
      expirations: availableExpirations.length > 0 ? availableExpirations : Object.keys(processedChain).sort(),
      chain: processedChain,
      source,
    };
    
    // Cache TTL: 5 min during market hours, 4 hours after close. For simplicity, just use 5 mins here.
    const actualCacheKey = `OPTIONS_CHAIN_V4#${source.toUpperCase()}#${symbol}${expiryParam ? `#${expiryParam}` : ''}`;
    try {
      await setCachedData(actualCacheKey, responseData, 300);
    } catch (cacheErr) {
      console.warn(`Failed to cache options chain for ${symbol} (possibly too large):`, cacheErr);
    }
    
    return jsonResponse(200, responseData, { 'X-Source-Provider': source });
  } catch (err: any) {
    return jsonResponse(500, { error: err.message });
  }
}

export async function getUnusualActivityFeed(
  event: APIGatewayProxyEventV2,
  params: Record<string, string>,
): Promise<APIGatewayProxyResultV2> {
  try {
    const symbol = event.queryStringParameters?.['symbol'];
    const minSigma = parseFloat(event.queryStringParameters?.['minSigma'] || '2.0');
    const minPremium = parseFloat(event.queryStringParameters?.['minPremium'] || '100000');
    const side = event.queryStringParameters?.['side'] as 'call' | 'put' | undefined;
    const dteMax = event.queryStringParameters?.['dteMax'] ? parseInt(event.queryStringParameters?.['dteMax'], 10) : undefined;
    const provider = event.headers?.['x-data-provider']?.toLowerCase();

    // Fetch underlying quote to surface stock % change alongside whale flow rows.
    // Non-fatal — the feed still works without it.
    let stockChangePercent: number | undefined;
    if (symbol) {
      try {
        const { getQuoteProviderAware } = await import('../services/providerService.js');
        const quoteRes = await getQuoteProviderAware(symbol, provider);
        stockChangePercent = quoteRes.data.changePercent / 100; // normalize to decimal (e.g. -10% → -0.10)
      } catch {
        // ignore — changePercent just won't be populated
      }
    }

    const feedResult = await getUnusualActivity({ symbol, minSigma, minPremium, side, dteMax, stockChangePercent, provider });
    return jsonResponse(200, { data: feedResult.data }, { 'X-Source-Provider': feedResult.source });
  } catch (err: any) {
    return jsonResponse(500, { error: err.message });
  }
}

export async function getRealizedVolatilityHistory(
  event: APIGatewayProxyEventV2,
  params: Record<string, string>,
): Promise<APIGatewayProxyResultV2> {
  const symbol = params['symbol']?.toUpperCase();
  if (!symbol) {
    return jsonResponse(400, { error: '"symbol" is required' });
  }

  try {
    const history = await fetchHistoricalIV(symbol, 365);
    return jsonResponse(200, history);
  } catch (err: any) {
    return jsonResponse(500, { error: err.message });
  }
}
