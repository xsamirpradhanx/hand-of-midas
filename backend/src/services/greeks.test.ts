import { describe, expect, it } from 'vitest';
import { blackScholes, computePortfolioGreeks, impliedVolatility } from './greeks.js';

describe('options valuation', () => {
  it('satisfies European put-call parity', () => {
    const S = 100;
    const K = 100;
    const T = 0.5;
    const r = 0.04;
    const call = blackScholes(S, K, T, r, 0.25, 'call');
    const put = blackScholes(S, K, T, r, 0.25, 'put');

    expect(call.price - put.price).toBeCloseTo(S - K * Math.exp(-r * T), 7);
  });

  it('recovers implied volatility from a Black-Scholes price', () => {
    const price = blackScholes(100, 105, 0.25, 0.04, 0.32, 'call').price;
    expect(impliedVolatility(price, 100, 105, 0.25, 0.04, 'call')).toBeCloseTo(0.32, 4);
  });

  it('reports portfolio delta in share equivalents, not dollar delta', () => {
    const result = computePortfolioGreeks([{
      symbol: 'XYZ', side: 'call', quantity: 1, multiplier: 100,
      underlyingPrice: 200, greeks: { price: 1, delta: 0.5, gamma: 0.01, theta: -0.1, vega: 0.2, rho: 0 },
    }], 500);

    expect(result.netDelta).toBe(50);
    expect(result.netGamma).toBe(1);
  });
});
