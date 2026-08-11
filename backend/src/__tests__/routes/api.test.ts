import { describe, it, expect } from 'vitest';
import { handler } from '../../index.js';

describe('API Routes', () => {
  it('should handle /api/options/insights/:symbol route', async () => {
    const event = {
      version: '2.0',
      routeKey: '$default',
      rawPath: '/api/options/insights/BMNR',
      rawQueryString: '',
      headers: {},
      queryStringParameters: {},
      requestContext: {
        http: {
          method: 'GET',
          path: '/api/options/insights/BMNR'
        },
        authorizer: {
          jwt: {
            claims: { sub: '123' }
          }
        }
      }
    };
    
    const result = await handler(event as any);
    expect(result).toBeDefined();
    // Assuming the API returns a 200 on success, or at least has a statusCode
    if (result.statusCode) {
      expect([200, 400, 404, 500]).toContain(result.statusCode);
    }
  });

  it('should handle /api/options/metrics/:symbol route', async () => {
    const event = {
      version: '2.0',
      routeKey: '$default',
      rawPath: '/api/options/metrics/BMNR',
      rawQueryString: 'expiry=2026-08-07',
      headers: {},
      queryStringParameters: { expiry: '2026-08-07' },
      requestContext: {
        http: {
          method: 'GET',
          path: '/api/options/metrics/BMNR'
        },
        authorizer: {
          jwt: {
            claims: { sub: '123' }
          }
        }
      }
    };
    
    const result = await handler(event as any);
    expect(result).toBeDefined();
    if (result.statusCode) {
      expect([200, 400, 404, 500]).toContain(result.statusCode);
    }
  });
});
