import { handler } from './src/index.js';

async function run() {
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
  console.log(result);
}
run();
