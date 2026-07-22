import express from 'express';
import cors from 'cors';
import { handler } from './index.js';
import type { APIGatewayProxyEventV2 } from './types.js';

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());
app.use(express.text());
app.use(express.urlencoded({ extended: true }));

// Simulate AWS API Gateway payload
app.use(async (req, res) => {
  console.log('Local request', req.method, req.path, 'url=', req.url, 'query=', req.query);
  try {
    const event: APIGatewayProxyEventV2 = {
      version: '2.0',
      routeKey: `$default`,
      rawPath: req.path,
      rawQueryString: req.url.split('?')[1] || '',
      headers: req.headers as Record<string, string>,
      queryStringParameters: req.query as Record<string, string>,
      requestContext: {
        accountId: '123456789012',
        apiId: 'local',
        domainName: 'localhost',
        domainPrefix: 'localhost',
        http: {
          method: req.method,
          path: req.path,
          protocol: req.protocol,
          sourceIp: req.ip || '127.0.0.1',
          userAgent: req.get('user-agent') || '',
        },
        requestId: Math.random().toString(36).substring(7),
        routeKey: '$default',
        stage: '$default',
        time: new Date().toISOString(),
        timeEpoch: Date.now(),
        // Mock authorization based on header for testing, or just use a fixed ID
        authorizer: {
          jwt: {
            claims: {
              // For local testing, we hardcode the user ID to match the real one from Cognito
              sub: '117b8500-e081-70a5-3881-9511d3bd4c24' // From the user's logs
            },
            scopes: []
          }
        }
      },
      body: req.body ? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body)) : undefined,
      isBase64Encoded: false,
    };

    const result = await handler(event) as any;

    if (result && result.headers) {
      for (const [key, value] of Object.entries(result.headers)) {
        if (value !== undefined && value !== null) {
          res.setHeader(key, value.toString());
        }
      }
    }

    res.status(result?.statusCode || 200).send(result?.body);
  } catch (error) {
    console.error('Local Server Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.listen(port, () => {
  console.log(`Local backend running at http://localhost:${port}`);
  console.log(`Mocking requests as user: 117b8500-e081-70a5-3881-9511d3bd4c24`);
});
