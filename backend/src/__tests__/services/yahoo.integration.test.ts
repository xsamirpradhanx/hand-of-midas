import { describe, it, expect } from 'vitest';
import { yf } from '../../services/yahoo.js';
import { getMarketDataProviderAware } from '../../services/providerService.js';
import { buildActiveMarketUniverse } from '../../services/universeService.js';

describe('Yahoo Finance Integration', () => {
  it('should fetch chart data for AAPL', async () => {
    const toDate = new Date();
    const fromDate = new Date();
    fromDate.setDate(toDate.getDate() - 10);
    
    const chart = await yf.chart('AAPL', {
      period1: fromDate,
      period2: toDate,
      interval: '1d'
    });
    expect(chart.quotes.length).toBeGreaterThan(0);
  });

  it('should fetch single quote for AAPL', async () => {
    const quote = await yf.quote('AAPL');
    expect(quote).toBeDefined();
    expect(quote.symbol).toBe('AAPL');
  });

  it('should fetch quotes with floatShares and marketCap for multiple symbols', async () => {
    const symbols = ['AAPL', 'SSCKT', 'JJWEL'];
    const q = await yf.quote(symbols);
    expect(Array.isArray(q)).toBe(true);
    expect(q.length).toBeGreaterThan(0);
    const apple = q.find((x: any) => x.symbol === 'AAPL');
    expect(apple).toBeDefined();
    expect(apple?.marketCap).toBeDefined();
  });

  it('should fetch 5min data using provider wrapper (WULF)', async () => {
    const result = await getMarketDataProviderAware('WULF', '5min', true, 'yahoo');
    expect(result.data.length).toBeGreaterThan(0);
  });

  it('should fetch 60m data with and without extended hours (WULF)', async () => {
    const period1 = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    
    const yfData = await yf.chart('WULF', {
      interval: '60m',
      period1,
      includePrePost: false
    });
    expect(yfData.quotes.length).toBeGreaterThan(0);

    const yfDataExt = await yf.chart('WULF', {
      interval: '60m',
      period1,
      includePrePost: true
    });
    expect(yfDataExt.quotes.length).toBeGreaterThan(0);
    // Usually extended hours has more quotes
    expect(yfDataExt.quotes.length).toBeGreaterThanOrEqual(yfData.quotes.length);
  });

  it('should fetch batch quotes for active market universe', async () => {
    const universe = await buildActiveMarketUniverse();
    expect(universe.length).toBeGreaterThan(0);
    
    // We only fetch a slice to avoid giant batch requests in a unit test
    const batch = await yf.quote(universe.slice(0, 5));
    expect(Array.isArray(batch) ? batch.length : 1).toBeGreaterThan(0);
  });
});
