import { describe, it, expect, beforeAll } from 'vitest';
import { getQuoteSchwab, getPriceHistorySchwab } from '../../services/schwabService.js';
import { schwabFor } from '../../services/brokers/index.js';

describe('Schwab API Integration', () => {
  let hasValidToken = false;

  beforeAll(async () => {
    try {
      const token = await schwabFor().getAccessToken();
      if (token) hasValidToken = true;
    } catch (e) {
      console.warn('Could not get valid Schwab token for tests', e);
    }
  });

  it('should fetch quote for AAPL', async () => {
    // Skip if no token
    if (!hasValidToken) {
      console.warn('Skipping test: No valid Schwab token');
      return;
    }
    const quote = await getQuoteSchwab('AAPL');
    expect(quote).toBeDefined();
    // Assuming structure based on standard responses, at least it shouldn't throw
  });

  it('should fetch 30min price history for AAPL', async () => {
    if (!hasValidToken) {
      console.warn('Skipping test: No valid Schwab token');
      return;
    }
    const token = await schwabFor().getAccessToken();
    const endDate = Date.now();
    const startDate = endDate - 60 * 24 * 60 * 60 * 1000; // 60 days
    
    const url = `https://api.schwabapi.com/marketdata/v1/pricehistory?symbol=AAPL&periodType=day&frequencyType=minute&frequency=30&endDate=${endDate}&startDate=${startDate}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    
    expect(res.ok).toBe(true);
    expect(data.candles).toBeDefined();
    expect(data.candles.length).toBeGreaterThan(0);
  });
});
