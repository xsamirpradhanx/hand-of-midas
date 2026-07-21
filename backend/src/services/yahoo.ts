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
