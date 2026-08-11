import { describe, it, expect } from 'vitest';
import { runScreener } from '../../services/screenerService.js';

describe('Screener Service Integration', () => {
  it('should run predefined premarket screener', async () => {
    const results = await runScreener('premarket');
    expect(results).toBeDefined();
    expect(Array.isArray(results)).toBe(true);
  });

  it('should run direct fetch for most_active_penny_stocks', async () => {
    const res = await fetch('https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=false&lang=en-US&region=US&scrIds=most_active_penny_stocks&count=5');
    const data = await res.json();
    expect(res.ok).toBe(true);
    expect(data.finance.result[0].quotes).toBeDefined();
    expect(data.finance.result[0].quotes.length).toBeGreaterThan(0);
  });

  it('should test various screener ids', async () => {
    const ids = [
      'recent_52_week_lows',
      'recent_52_week_highs',
      'morningstar_5_star_stocks'
    ];

    for (const id of ids) {
      const res = await fetch(`https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=false&lang=en-US&region=US&scrIds=${id}&count=2`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.finance.result[0]).toBeDefined();
    }
  });

  it('should test screener with different counts', async () => {
    const counts = [100, 250];
    for (const count of counts) {
      const res = await fetch(`https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=false&lang=en-US&region=US&scrIds=most_active_penny_stocks&count=${count}`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.finance.result[0].quotes).toBeDefined();
    }
  });
});
