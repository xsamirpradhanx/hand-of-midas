import { SchwabAuth } from '../schwabAuth.js';
import type { PolygonOptionsContract } from './polygon.js';

const auth = new SchwabAuth();

function getSchwabSymbol(symbol: string): string {
  let schwabSymbol = symbol.toUpperCase();
  if (schwabSymbol === 'SPX' || schwabSymbol === 'NDX' || schwabSymbol === 'VIX' || schwabSymbol === 'RUT') {
    schwabSymbol = `$${schwabSymbol}`;
  }
  return schwabSymbol;
}

// Cache Schwab chains responses (which return ALL expirations) for 10 seconds 
// to prevent 14+ redundant API calls during optionsMetrics generation.
const chainsCache = new Map<string, { timestamp: number; promise: Promise<any> }>();
const CHAINS_CACHE_TTL = 10000;

export async function fetchOptionsChainSchwab(
  symbol: string,
  expiryStr?: string
): Promise<{ expirations: string[]; contracts: PolygonOptionsContract[]; quote?: any }> {
  const accessToken = await auth.getValidAccessToken();
  if (!accessToken) {
    throw new Error('Failed to obtain Schwab access token. User may need to authenticate.');
  }

  const schwabSymbol = getSchwabSymbol(symbol);
  const now = Date.now();
  let cacheEntry = chainsCache.get(schwabSymbol);

  if (!cacheEntry || now - cacheEntry.timestamp > CHAINS_CACHE_TTL) {
    const url = `https://api.schwabapi.com/marketdata/v1/chains?symbol=${schwabSymbol}&contractType=ALL`;
    const promise = fetch(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json'
      }
    }).then(async res => {
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Schwab API Error: ${res.status} ${errText}`);
      }
      return res.json();
    }).catch(err => {
      // Clear cache on failure so we don't return rejected promises
      chainsCache.delete(schwabSymbol);
      throw err;
    });

    cacheEntry = { timestamp: now, promise };
    chainsCache.set(schwabSymbol, cacheEntry);
  }

  const data = await cacheEntry.promise;

  const allContracts: PolygonOptionsContract[] = [];
  const expirationsSet = new Set<string>();

  const processMap = (map: Record<string, Record<string, any[]>>, type: 'call' | 'put') => {
    if (!map) return;
    
    for (const expKey of Object.keys(map)) {
      // expKey format is usually "YYYY-MM-DD:DaysToExpiry"
      const datePart = expKey.split(':')[0];
      if (expiryStr && datePart !== expiryStr) continue;
      
      expirationsSet.add(datePart);
      
      const strikesMap = map[expKey];
      for (const strikeStr of Object.keys(strikesMap)) {
        const optionArray = strikesMap[strikeStr];
        if (!optionArray || optionArray.length === 0) continue;
        
        const option = optionArray[0]; // Usually just one option here
        
        allContracts.push({
          ticker: option.symbol,
          details: {
            strike_price: option.strikePrice ?? parseFloat(strikeStr),
            expiration_date: datePart,
            contract_type: type,
            shares_per_contract: option.multiplier ?? 100,
          },
          day: {
            volume: option.totalVolume ?? 0,
            open_interest: option.openInterest ?? 0,
          },
          greeks: {
            delta: option.delta === 'NaN' || option.delta === null ? 0 : option.delta,
            gamma: option.gamma === 'NaN' || option.gamma === null ? 0 : option.gamma,
            theta: option.theta === 'NaN' || option.theta === null ? 0 : option.theta,
            vega: option.vega === 'NaN' || option.vega === null ? 0 : option.vega,
          },
          implied_volatility: option.volatility === 'NaN' || option.volatility === null ? 0 : (option.volatility / 100), // Schwab returns IV as % (e.g., 29.5 for 29.5%), we need decimal for bs
          last_quote: {
            bid: option.bid ?? 0,
            ask: option.ask ?? 0,
            last: option.last ?? 0,
          },
        });
      }
    }
  };

  processMap(data.callExpDateMap, 'call');
  processMap(data.putExpDateMap, 'put');

  const expirations = Array.from(expirationsSet).sort();
  
  // Create a mock quote object to return the underlying price
  const quote = {
    regularMarketPrice: data.underlyingPrice ?? 0,
  };

  return { expirations, contracts: allContracts, quote };
}

export async function getQuoteSchwab(symbol: string): Promise<any> {
  const accessToken = await auth.getValidAccessToken();
  if (!accessToken) {
    throw new Error('Failed to obtain Schwab access token. User may need to authenticate.');
  }

  const schwabSymbol = getSchwabSymbol(symbol);
  const url = `https://api.schwabapi.com/marketdata/v1/${schwabSymbol}/quotes`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Schwab API Error: ${response.status} ${errText}`);
  }

  const data = await response.json() as any;
  const quoteData = data[schwabSymbol]?.quote;
  const regularMarketLastPrice = quoteData?.lastPrice ?? data[schwabSymbol]?.reference?.mark ?? 0;

  return {
    symbol,
    price: regularMarketLastPrice,
    regularMarketPrice: regularMarketLastPrice,
    change: quoteData?.netChange ?? 0,
    changePercent: quoteData?.netPercentChange ?? 0,
    volume: quoteData?.totalVolume ?? 0,
  };
}

export async function getPriceHistorySchwab(symbol: string, interval: string, extendedHours: boolean = false): Promise<any[]> {
  const accessToken = await auth.getValidAccessToken();
  if (!accessToken) {
    throw new Error('Failed to obtain Schwab access token. User may need to authenticate.');
  }

  const schwabSymbol = getSchwabSymbol(symbol);
  
  // Map our intervals (1min, 5min, 15min, 30min, 1h, 1day, 1week, 1month) to Schwab's parameters
  let periodType = 'day';
  let period = '1';
  let frequencyType = 'minute';
  let frequency = '1';

  switch (interval) {
    case '1min':
      periodType = 'day'; period = '2'; frequencyType = 'minute'; frequency = '1'; break;
    case '5min':
      periodType = 'day'; period = '5'; frequencyType = 'minute'; frequency = '5'; break;
    case '15min':
      periodType = 'day'; period = '10'; frequencyType = 'minute'; frequency = '15'; break;
    case '30min':
      periodType = 'day'; period = '10'; frequencyType = 'minute'; frequency = '30'; break;
    case '1h':
      periodType = 'day'; period = '10'; frequencyType = 'minute'; frequency = '30'; break; // Schwab doesn't have 60min, approximate with 30min or daily
    case '1day':
      periodType = 'month'; period = '6'; frequencyType = 'daily'; frequency = '1'; break;
    case '1week':
      periodType = 'year'; period = '2'; frequencyType = 'weekly'; frequency = '1'; break;
    case '1month':
      periodType = 'year'; period = '5'; frequencyType = 'monthly'; frequency = '1'; break;
    default:
      periodType = 'month'; period = '6'; frequencyType = 'daily'; frequency = '1';
  }

  // Explicitly set endDate to now so we get live data for intraday intervals, not just historical complete days
  const endDate = Date.now();
  const url = `https://api.schwabapi.com/marketdata/v1/pricehistory?symbol=${schwabSymbol}&periodType=${periodType}&period=${period}&frequencyType=${frequencyType}&frequency=${frequency}&needExtendedHoursData=${extendedHours}&endDate=${endDate}`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Schwab API Error: ${response.status} ${errText}`);
  }

  const data = await response.json() as any;
  if (!data.candles) return [];

  return data.candles.map((c: any) => ({
    timestamp: c.datetime, // Epoch ms
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume
  }));
}
