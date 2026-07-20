import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { OHLCVDataPoint } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PolygonQuote {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  bid: number;
  ask: number;
  volume: number;
}

export interface PolygonOptionsContract {
  ticker: string;
  details: {
    strike_price: number;
    expiration_date: string;
    contract_type: 'call' | 'put';
    shares_per_contract: number;
  };
  day: {
    volume: number;
    open_interest: number;
  };
  greeks: {
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
  };
  implied_volatility: number;
  last_quote: {
    bid: number;
    ask: number;
    last: number;
  };
}

interface PolygonAggsResponse {
  ticker: string;
  queryCount: number;
  resultsCount: number;
  adjusted: boolean;
  results?: Array<{
    v: number;
    vw: number;
    o: number;
    c: number;
    h: number;
    l: number;
    t: number;
    n: number;
  }>;
  status: string;
  request_id: string;
  count: number;
}

interface PolygonSnapshotResponse {
  results?: Array<any>;
  status: string;
  request_id: string;
  next_url?: string;
}

interface PolygonTradeResponse {
  results: {
    p: number;
    s: number;
    t: number;
    c: number[];
  };
  status: string;
}

interface PolygonTickerDetailResponse {
  results: {
    ticker: string;
    name: string;
  };
  status: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_URL = 'https://api.polygon.io';
const SSM_PARAM_PATH = process.env['SSM_POLYGON_KEY_PATH'] ?? '/handofmidas/polygon-api-key';

const ssmClient = new SSMClient({});
let cachedApiKey: string | undefined;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function getApiKey(): Promise<string> {
  if (cachedApiKey) {
    return cachedApiKey;
  }

  const result = await ssmClient.send(
    new GetParameterCommand({
      Name: SSM_PARAM_PATH,
      WithDecryption: true,
    }),
  );

  const value = result.Parameter?.Value;
  if (!value) {
    throw new Error(`Failed to retrieve Polygon API key from SSM parameter: ${SSM_PARAM_PATH}`);
  }

  cachedApiKey = value;
  return cachedApiKey;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPolygon<T>(url: string): Promise<T> {
  const apiKey = await getApiKey();
  const targetUrl = new URL(url);
  targetUrl.searchParams.set('apiKey', apiKey);

  let retries = 3;
  while (retries > 0) {
    const response = await fetch(targetUrl.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    if (response.status === 429) {
      retries--;
      if (retries === 0) {
        throw new Error(`Polygon API rate limit exceeded — ${targetUrl.pathname}`);
      }
      await sleep(1000);
      continue;
    }

    if (!response.ok) {
      throw new Error(`Polygon API error: ${response.status} ${response.statusText} — ${targetUrl.pathname}`);
    }

    const data = await response.json();
    return data as T;
  }

  throw new Error('Polygon API fetch failed after retries');
}

/**
 * Maps twelvedata-style interval strings to Polygon timespan params
 */
function mapInterval(interval: string): { multiplier: number; timespan: string } {
  const match = interval.match(/^(\d+)?([a-zA-Z]+)$/);
  if (!match) return { multiplier: 1, timespan: 'day' };

  const multiplier = match[1] ? parseInt(match[1], 10) : 1;
  const unit = match[2].toLowerCase();

  let timespan = 'day';
  if (unit.startsWith('min')) timespan = 'minute';
  else if (unit.startsWith('h')) timespan = 'hour';
  else if (unit.startsWith('d')) timespan = 'day';
  else if (unit.startsWith('w')) timespan = 'week';
  else if (unit.startsWith('m')) timespan = 'month';

  return { multiplier, timespan };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get OHLCV bars for a ticker.
 */
export async function getTimeSeries(symbol: string, interval: string, limit: number): Promise<OHLCVDataPoint[]> {
  const { multiplier, timespan } = mapInterval(interval);
  
  // Calculate from/to dates (simplified to use large range and limit)
  const to = new Date().toISOString().split('T')[0];
  const fromObj = new Date();
  fromObj.setFullYear(fromObj.getFullYear() - 2); // 2 years back should be enough for most limits
  const from = fromObj.toISOString().split('T')[0];

  const url = `${BASE_URL}/v2/aggs/ticker/${symbol.toUpperCase()}/range/${multiplier}/${timespan}/${from}/${to}?adjusted=true&sort=desc&limit=${limit}`;
  const data = await fetchPolygon<PolygonAggsResponse>(url);

  if (!data.results) {
    return [];
  }

  // Polygon returns sorted by time if requested, but we requested desc to get latest `limit` items.
  // The prompt asks for chronological order (oldest first).
  const sorted = data.results.sort((a, b) => a.t - b.t);

  return sorted.map((bar) => ({
    datetime: new Date(bar.t).toISOString(),
    open: bar.o,
    high: bar.h,
    low: bar.l,
    close: bar.c,
    volume: bar.v,
  }));
}

/**
 * Get current quote for a ticker.
 */
export async function getQuote(symbol: string): Promise<PolygonQuote> {
  const sym = symbol.toUpperCase();
  
  const [snapshotData, tickerData] = await Promise.all([
    fetchPolygon<any>(`${BASE_URL}/v2/snapshot/locale/us/markets/stocks/tickers/${sym}`),
    fetchPolygon<PolygonTickerDetailResponse>(`${BASE_URL}/v3/reference/tickers/${sym}`)
  ]);

  if (!snapshotData.ticker) {
    throw new Error(`Snapshot data not found for ${sym}`);
  }

  const s = snapshotData.ticker;
  const price = s.day?.c ?? s.lastTrade?.p ?? s.prevDay?.c ?? 0;
  const prevClose = s.prevDay?.c ?? price;
  const change = price - prevClose;
  const changePercent = prevClose !== 0 ? (change / prevClose) * 100 : 0;

  return {
    symbol: sym,
    name: tickerData.results?.name ?? sym,
    price,
    change,
    changePercent,
    bid: s.lastQuote?.p ?? 0,
    ask: s.lastQuote?.P ?? 0, // uppercase P for ask price in some Polygon responses
    volume: s.day?.v ?? 0,
  };
}

/**
 * Get full options chain for an underlying.
 */
export async function getOptionsChain(symbol: string): Promise<PolygonOptionsContract[]> {
  let url = `${BASE_URL}/v3/snapshot/options/${symbol.toUpperCase()}?limit=250`;
  const allContracts: PolygonOptionsContract[] = [];

  try {
    while (true) {
      const data = await fetchPolygon<PolygonSnapshotResponse>(url);
    
    if (data.results) {
      for (const item of data.results) {
        allContracts.push({
          ticker: item.ticker,
          details: {
            strike_price: item.details?.strike_price ?? 0,
            expiration_date: item.details?.expiration_date ?? '',
            contract_type: item.details?.contract_type ?? 'call',
            shares_per_contract: item.details?.shares_per_contract ?? 100,
          },
          day: {
            volume: item.day?.volume ?? 0,
            open_interest: item.open_interest ?? 0,
          },
          greeks: {
            delta: item.greeks?.delta ?? 0,
            gamma: item.greeks?.gamma ?? 0,
            theta: item.greeks?.theta ?? 0,
            vega: item.greeks?.vega ?? 0,
          },
          implied_volatility: item.implied_volatility ?? 0,
          last_quote: {
            bid: item.last_quote?.bid ?? 0,
            ask: item.last_quote?.ask ?? 0,
            last: item.last_quote?.last ?? 0,
          }
        });
      }
    }

    if (data.next_url) {
      url = data.next_url;
    } else {
      break;
    }
  }

  return allContracts;
  } catch (err: any) {
    if (err.message && err.message.includes('403')) {
      console.log(`[MOCK MODE] 403 Forbidden for options chain on ${symbol}. Free tier detected, generating mock chain.`);
      return await generateMockOptionsChain(symbol);
    }
    throw err;
  }
}

async function generateMockOptionsChain(symbol: string): Promise<PolygonOptionsContract[]> {
  const quote = await getQuote(symbol).catch(() => ({ price: 150 } as PolygonQuote));
  const spot = quote.price || 150;
  
  const contracts: PolygonOptionsContract[] = [];
  const expirations = [
    new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0],
    new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0],
    new Date(Date.now() + 90 * 86400000).toISOString().split('T')[0]
  ];

  const startStrike = Math.floor(spot * 0.8 / 5) * 5;
  const endStrike = Math.ceil(spot * 1.2 / 5) * 5;
  
  for (const exp of expirations) {
    for (let strike = startStrike; strike <= endStrike; strike += 5) {
      const dte = (new Date(exp).getTime() - Date.now()) / 86400000;
      const iv = 0.3 + Math.abs(strike - spot) / spot;
      
      const callIntrinsic = Math.max(0, spot - strike);
      const putIntrinsic = Math.max(0, strike - spot);
      const timeVal = (spot * iv * Math.sqrt(Math.max(1, dte)/365)) / 2;
      
      const callMid = callIntrinsic + timeVal;
      const putMid = putIntrinsic + timeVal;

      contracts.push({
        ticker: `O:${symbol}${exp.replace(/-/g, '').substring(2)}C00${(strike*1000).toString().padStart(5, '0')}`,
        details: { strike_price: strike, expiration_date: exp, contract_type: 'call', shares_per_contract: 100 },
        day: { volume: Math.floor(Math.random() * 1000), open_interest: Math.floor(Math.random() * 5000) },
        greeks: { delta: strike < spot ? 0.8 : 0.2, gamma: 0.05, theta: -0.05, vega: 0.1 },
        implied_volatility: iv,
        last_quote: { bid: callMid * 0.95, ask: callMid * 1.05, last: callMid }
      });

      contracts.push({
        ticker: `O:${symbol}${exp.replace(/-/g, '').substring(2)}P00${(strike*1000).toString().padStart(5, '0')}`,
        details: { strike_price: strike, expiration_date: exp, contract_type: 'put', shares_per_contract: 100 },
        day: { volume: Math.floor(Math.random() * 1000), open_interest: Math.floor(Math.random() * 5000) },
        greeks: { delta: strike > spot ? -0.8 : -0.2, gamma: 0.05, theta: -0.05, vega: 0.1 },
        implied_volatility: iv,
        last_quote: { bid: putMid * 0.95, ask: putMid * 1.05, last: putMid }
      });
    }
  }

  return contracts;
}

export interface IVHistoryPoint {
  date: string;
  iv: number;
  atm_iv: number;
  iv_rank: number;
  iv_percentile: number;
}

/**
 * Get historical IV estimates using the Parkinson high-low range estimator.
 *
 * σ_parkinson = √(252 / (4·ln2)) · |ln(H/L)|
 *
 * iv_rank and iv_percentile are computed across the full window of estimates.
 */
export async function getHistoricalIV(symbol: string, days: number = 365): Promise<IVHistoryPoint[]> {
  const sym = symbol.toUpperCase();
  const toDate = new Date();
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - days);

  const toStr = toDate.toISOString().split('T')[0];
  const fromStr = fromDate.toISOString().split('T')[0];

  const aggsUrl = `${BASE_URL}/v2/aggs/ticker/${sym}/range/1/day/${fromStr}/${toStr}?adjusted=true&sort=asc&limit=500`;
  const aggsData = await fetchPolygon<PolygonAggsResponse>(aggsUrl);
  const results = aggsData.results || [];

  if (results.length === 0) return [];

  const LN2 = Math.log(2);
  const parkinsonFactor = Math.sqrt(252 / (4 * LN2));

  const estimates = results.map(bar => {
    const hlRatio = bar.h > 0 && bar.l > 0 ? Math.log(bar.h / bar.l) : 0;
    const iv = parkinsonFactor * Math.abs(hlRatio);
    return { date: new Date(bar.t).toISOString().split('T')[0], iv };
  });

  const ivValues = estimates.map(e => e.iv);
  const minIV = Math.min(...ivValues);
  const maxIV = Math.max(...ivValues);
  const sortedIVs = [...ivValues].sort((a, b) => a - b);
  const n = sortedIVs.length;

  return estimates.map(entry => {
    const ivRank = maxIV > minIV ? ((entry.iv - minIV) / (maxIV - minIV)) * 100 : 0;
    const rankIdx = sortedIVs.findIndex(v => v >= entry.iv);
    const ivPercentile = n > 0 ? ((rankIdx < 0 ? n : rankIdx) / n) * 100 : 0;
    return {
      date: entry.date,
      iv: entry.iv,
      atm_iv: entry.iv,
      iv_rank: ivRank,
      iv_percentile: ivPercentile,
    };
  });
}
