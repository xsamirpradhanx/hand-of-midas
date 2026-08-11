import { describe, it, expect } from 'vitest';
import { getMarketDataProviderAware, getQuoteProviderAware } from '../../services/providerService.js';

describe('Provider Service Integration', () => {
  it('should fetch quotes for WULF via both polygon and yahoo providers', async () => {
    // Polygon tests will fail if no API key is provided, we catch it or check env
    if (process.env.POLYGON_API_KEY) {
      const q = await getQuoteProviderAware('WULF', 'polygon');
      expect(q.data).toBeDefined();
    }
    
    const q2 = await getQuoteProviderAware('WULF', 'yahoo');
    expect(q2.data).toBeDefined();
    expect(q2.data.symbol).toBe('WULF');
  });

  it('should fetch market data candles for AAPL (1day)', async () => {
    const result = await getMarketDataProviderAware('AAPL', '1day', true, 'yahoo');
    expect(result.data.length).toBeGreaterThan(0);
  });

  it('should fetch market data candles for WULF (1h, no extended hours)', async () => {
    const result = await getMarketDataProviderAware('WULF', '1h', false, 'yahoo');
    expect(result.data.length).toBeGreaterThan(0);
  });

  it('should fetch market data candles for WULF (1h, extended hours)', async () => {
    const result = await getMarketDataProviderAware('WULF', '1h', true, 'yahoo');
    expect(result.data.length).toBeGreaterThan(0);
  });
});
