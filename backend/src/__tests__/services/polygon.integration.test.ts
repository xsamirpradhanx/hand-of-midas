import { describe, it, expect, beforeAll } from 'vitest';
import { getQuote } from '../../services/polygon.js';
import { getQuoteProviderAware } from '../../services/providerService.js';

describe('Polygon API Integration', () => {
  let hasToken = false;

  beforeAll(() => {
    if (process.env.POLYGON_API_KEY) {
      hasToken = true;
    } else {
      console.warn('Could not find POLYGON_API_KEY in environment');
    }
  });

  it('should fetch raw quote for AAPL directly from polygon service', async () => {
    if (!hasToken) {
      console.warn('Skipping test: No POLYGON_API_KEY');
      return;
    }
    const data = await getQuote('AAPL');
    expect(data).toBeDefined();
    // Typical polygon quote structure has results
    if (data.results && data.results.length > 0) {
      expect(data.results[0].T).toBe('AAPL');
    }
  });

  it('should fetch quote for AAPL via provider service', async () => {
    if (!hasToken) {
      console.warn('Skipping test: No POLYGON_API_KEY');
      return;
    }
    const q = await getQuoteProviderAware('AAPL', 'polygon');
    expect(q.data).toBeDefined();
  });
});
