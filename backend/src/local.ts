import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { handler } from './index.js';
import type { APIGatewayProxyEventV2 } from './types.js';
import { getJob, listJobs } from './localScheduler.js';

const app = express();
// Port 3000 is not guaranteed free — another project on this machine may already own
// it — so allow an override. Defaults to 3000 so existing setups are unchanged.
const port = Number(process.env.PORT) || 3000;

app.use(cors({
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Data-Provider'],
  exposedHeaders: ['X-Source-Provider']
}));
app.use(express.json());
app.use(express.text());
app.use(express.urlencoded({ extended: true }));

// ── Local-dev-only background job controls ──────────────────────────────
// Not part of the deployed Lambda/API — lets you toggle jobs like quant
// grading on/off while the dev server is running, without an AWS deploy.
//   curl http://localhost:3000/local/scheduler
//   curl -X POST http://localhost:3000/local/scheduler/evaluate-quant/start
//   curl -X POST http://localhost:3000/local/scheduler/evaluate-quant/stop
app.get('/local/scheduler', (_req, res) => {
  res.json(listJobs());
});
app.post('/local/scheduler/:job/start', (req, res) => {
  const job = getJob(req.params.job);
  if (!job) {
    res.status(404).json({ error: `Unknown job: ${req.params.job}` });
    return;
  }
  job.start();
  res.json({ ok: true, job: job.name, running: job.running });
});
app.post('/local/scheduler/:job/stop', (req, res) => {
  const job = getJob(req.params.job);
  if (!job) {
    res.status(404).json({ error: `Unknown job: ${req.params.job}` });
    return;
  }
  job.stop();
  res.json({ ok: true, job: job.name, running: job.running });
});

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
