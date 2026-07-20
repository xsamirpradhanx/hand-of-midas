import { handler } from './src/index.js';

async function run() {
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
  console.log(result);
}
run();
