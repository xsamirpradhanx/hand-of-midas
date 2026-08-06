import YahooFinance from 'yahoo-finance2';
import type { PolygonOptionsContract } from './polygon.js';

export const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

export async function getOptionsChainYahoo(symbol: string, expiryStr?: string): Promise<{ expirations: string[], contracts: PolygonOptionsContract[], quote?: any }> {
  try {
    const queryOpts = expiryStr ? { date: new Date(expiryStr) } : {};
    const result = await yf.options(symbol.toUpperCase(), queryOpts);
    
    const contracts: PolygonOptionsContract[] = [];

    // The root `options` array holds data for specific expirations.
    for (const expGroup of result.options) {
      const expirationDate = expGroup.expirationDate ? expGroup.expirationDate.toISOString().split('T')[0] : '';
      
      const mapContract = (c: any, type: 'call' | 'put'): PolygonOptionsContract => {
        return {
          ticker: c.contractSymbol,
          details: {
            strike_price: c.strike,
            expiration_date: expirationDate || c.expiration?.toISOString().split('T')[0] || '',
            contract_type: type,
            shares_per_contract: c.contractSize === 'REGULAR' ? 100 : 100,
          },
          day: {
            volume: c.volume || 0,
            open_interest: c.openInterest || 0,
          },
          greeks: {
            delta: 0,
            gamma: 0,
            theta: 0,
            vega: 0,
          },
          implied_volatility: c.impliedVolatility || 0,
          last_quote: {
            bid: c.bid || 0,
            ask: c.ask || 0,
            last: c.lastPrice || 0,
          }
        };
      };

      for (const call of expGroup.calls || []) {
        contracts.push(mapContract(call, 'call'));
      }
      for (const put of expGroup.puts || []) {
        contracts.push(mapContract(put, 'put'));
      }
    }

    const expirations = (result.expirationDates || []).map(d => d.toISOString().split('T')[0]);

    return { expirations, contracts, quote: result.quote };
  } catch (error) {
    console.error('Yahoo Finance options error:', error);
    throw new Error('Failed to fetch options chain from Yahoo Finance');
  }
}

export async function getTimeSeriesYahoo(symbol: string, interval: string, limit: number): Promise<any[]> {
  try {
    // interval mapping
    let yfInterval: '1m' | '2m' | '5m' | '15m' | '30m' | '60m' | '90m' | '1h' | '1d' | '5d' | '1wk' | '1mo' | '3mo' = '1d';
    if (interval === '1day' || interval === '1d') yfInterval = '1d';
    else if (interval === '1h' || interval === '60min' || interval === '60m') yfInterval = '1h';
    else if (interval === '1wk' || interval === '1w') yfInterval = '1wk';
    else if (interval === '1mo' || interval === '1m') yfInterval = '1mo';
    // If minutes are needed for predictive engine, map appropriately
    else if (interval === '15min' || interval === '15m') yfInterval = '15m';

    const toDate = new Date();
    const fromDate = new Date();
    
    // Approximate limit: 1d = limit days, 1h = limit hours (limit/7 days roughly), etc.
    // To be safe, fetch enough days to satisfy the limit
    let daysToFetch = limit;
    if ((yfInterval as string) === '1h' || (yfInterval as string) === '60m') daysToFetch = Math.ceil(limit / 7) + 5;
    if (yfInterval === '15m') daysToFetch = Math.ceil(limit / 28) + 5;
    
    // But yahoo-finance2 allows simple `chart` with `period1` and `period2`.
    // Actually, `chart` takes a simple object. Let's just fetch roughly enough days.
    // For predictive engine, it usually asks for '1d', 126 limit.
    if (yfInterval === '1d') {
      // 126 trading days is about 6 months, let's fetch 200 days to be safe.
      fromDate.setDate(toDate.getDate() - (limit * 1.5));
    } else {
      fromDate.setDate(toDate.getDate() - daysToFetch * 1.5);
    }

    const chart = await yf.chart(symbol.toUpperCase(), {
      period1: fromDate,
      period2: toDate,
      interval: yfInterval
    });

    if (!chart || !chart.quotes) {
      return [];
    }

    // Sort ascending, just in case
    const quotes = chart.quotes.sort((a, b) => a.date.getTime() - b.date.getTime());

    // Map to OHLCV format expected by factors
    const mapped = quotes.map(bar => ({
      datetime: bar.date.toISOString(),
      open: bar.open || bar.close, // Fallback if open missing
      high: bar.high || bar.close,
      low: bar.low || bar.close,
      close: bar.close,
      volume: bar.volume || 0,
    }));
    
    // If we fetched too many, just return the exact `limit` from the end (most recent).
    if (mapped.length > limit) {
      return mapped.slice(-limit);
    }
    
    return mapped;

  } catch (err: any) {
    console.error(`Yahoo Finance getTimeSeries error for ${symbol}:`, err.message);
    throw new Error(`Failed to fetch time series from Yahoo Finance for ${symbol}`);
  }
}

