# 🏛️ Hand of Midas

**Personal Stock Watchlist & Charting App** — TradingView-style interactive charts with configurable
technical indicators, built on serverless AWS infrastructure for near-zero idle cost.

---

## ✨ Features

- **Watchlist Management** — Add/remove tickers (stocks, ETFs), view live prices & % change
- **Interactive Charts** — Candlestick/OHLC charts powered by TradingView's
  [lightweight-charts](https://github.com/nickolasburr/lightweight-charts) v5
- **Technical Indicators**:
  - **Overlays**: SMA, EMA (configurable periods: 7, 21, 50, 200+), Bollinger Bands, VWAP
  - **Sub-charts**: RSI, MACD, Volume
  - Add/remove/reconfigure indicators per chart without page reloads
- **Multiple Timeframes** — 1 Day, 1 Week, 1 Month, 3 Month, 6 Month, 1 Year, All
- **Persistent Configuration** — Watchlists and chart indicator configs saved per user
- **Authentication** — Secure sign-up/sign-in via Amazon Cognito
- **Dark Theme** — Premium financial app aesthetic

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Frontend (S3 + CloudFront)                                     │
│  React + Vite + lightweight-charts + Client-side Indicators     │
└──────────────────────────┬──────────────────────────────────────┘
                           │ JWT Auth
┌──────────────────────────▼──────────────────────────────────────┐
│  API Gateway (HTTP API) + Cognito JWT Authorizer                │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│  Lambda (Node.js 20, ARM64)                                     │
│  Routes: /watchlist, /market-data, /quote, /chart-config        │
└─────────┬──────────────────────────────────┬────────────────────┘
          │                                  │
┌─────────▼─────────┐            ┌───────────▼──────────┐
│  DynamoDB          │            │  Twelve Data API      │
│  (On-Demand)       │            │  (Free Tier)          │
│  • Watchlists      │            └────────────────────────┘
│  • Chart configs   │
│  • Data cache      │
└────────────────────┘
```

### Why Serverless?

| Service          | Idle Cost  | Notes                              |
|-----------------|------------|-------------------------------------|
| S3 + CloudFront | ~$0.03/mo  | Static hosting, 1TB free transfer  |
| API Gateway     | $0.00      | Pay per request only               |
| Lambda          | $0.00      | 1M free requests/month             |
| DynamoDB        | ~$0.25/mo  | On-demand billing, pay per R/W     |
| Cognito         | $0.00      | Free for < 50K MAUs                |
| SSM Parameter   | $0.00      | Standard params are free           |
| **Total**       | **~$0.30** | **Effectively free for personal use** |

## 📋 Prerequisites

- **Node.js** ≥ 20.0.0
- **AWS CLI** configured with credentials (`aws configure`)
- **AWS CDK CLI** (`npm install -g aws-cdk`)
- **Twelve Data API key** — Free at [twelvedata.com](https://twelvedata.com/pricing)

## 🚀 Quick Start

### 1. Clone & Install

```bash
git clone <repo-url> handofmidas
cd handofmidas
npm install
```

### 2. Set Up Environment Variables

Create `frontend/.env.local`:

```env
# After deploying, fill these from CDK stack outputs
VITE_API_URL=https://<api-id>.execute-api.<region>.amazonaws.com/api
VITE_COGNITO_USER_POOL_ID=<from CDK output>
VITE_COGNITO_CLIENT_ID=<from CDK output>
VITE_AWS_REGION=us-east-1
```

### 3. Local Development

```bash
# Run frontend dev server
npm run dev

# Run indicator tests
npm run test:indicators
```

### 4. Deploy to AWS

```bash
# First time: bootstrap CDK in your AWS account
cd infra
npm install
npx cdk bootstrap

# Deploy everything
npx cdk deploy
```

After deployment, CDK outputs will show:
- `CloudFrontURL` — your app URL
- `ApiURL` — API endpoint
- `UserPoolId` — Cognito User Pool ID
- `UserPoolClientId` — Cognito Client ID

### 5. Set Your API Key

```bash
# Replace the placeholder with your Twelve Data API key
aws ssm put-parameter \
  --name "/handofmidas/twelvedata-api-key" \
  --value "YOUR_TWELVE_DATA_API_KEY" \
  --type String \
  --overwrite
```

### 6. Update Frontend Config & Redeploy

Update `frontend/.env.local` with the CDK outputs, then:

```bash
cd frontend
npm run build
cd ../infra
npx cdk deploy  # Redeploys frontend to S3/CloudFront
```

## 💰 Estimated Monthly Cost

### Light Personal Use (1 user, ~20 tickers)

| Service          | Estimated   | Calculation                           |
|-----------------|-------------|----------------------------------------|
| S3 Storage       | $0.03       | ~10MB static assets                   |
| CloudFront       | $0.00       | Within 1TB/month free tier            |
| API Gateway      | $0.01       | ~1,000 requests × $1/million          |
| Lambda           | $0.00       | ~1,000 invocations (free tier: 1M)    |
| DynamoDB         | $0.25       | ~1,000 reads + 500 writes/day         |
| Cognito          | $0.00       | Free tier: 50,000 MAUs                |
| SSM Parameter    | $0.00       | Standard parameters are free          |
| EventBridge      | $0.00       | Free tier: 14M events/month           |
| **Monthly Total** | **~$0.30** |                                       |

### Moderate Use (10 users, 100 tickers)

| Service          | Estimated   |
|-----------------|-------------|
| S3 + CloudFront  | $0.10       |
| API Gateway      | $0.10       |
| Lambda           | $0.00       |
| DynamoDB         | $1.50       |
| **Monthly Total** | **~$2.00** |

### When Paid Tiers Kick In

| Service       | Free Tier Limit         | Beyond Free Tier             |
|--------------|-------------------------|-------------------------------|
| Lambda       | 1M requests/month       | $0.20 per 1M requests        |
| API Gateway  | (no free tier for HTTP) | $1.00 per million requests   |
| DynamoDB     | 25 WCU + 25 RCU (prov.) | On-demand: $1.25/M writes    |
| Cognito      | 50,000 MAUs             | $0.0055/MAU after that       |
| Twelve Data  | 800 API calls/day       | Plans from $29/month         |

## 🧮 Technical Indicators

All indicator calculations are performed **client-side** in the browser for:
- Zero backend compute cost
- Instant indicator toggling without API round-trips
- Easy testability with unit tests

The indicator engine is at `frontend/src/lib/indicators/` and includes:

| Indicator       | Implementation Details                                        |
|----------------|---------------------------------------------------------------|
| SMA            | Sliding window sum, configurable period                       |
| EMA            | Recursive formula, SMA-seeded first value                     |
| RSI            | Wilder's smoothing (14-period default)                        |
| MACD           | Fast EMA(12) - Slow EMA(26), Signal EMA(9), Histogram        |
| Bollinger Bands| 20-SMA ± 2σ, configurable period and std dev multiplier       |
| VWAP           | Cumulative (H+L+C)/3 × Volume / ΣVolume, daily reset         |

## 📁 Project Structure

```
handofmidas/
├── frontend/                 # React SPA (Vite + TypeScript)
│   ├── src/
│   │   ├── lib/
│   │   │   ├── indicators/   # Technical indicator calculations
│   │   │   ├── api.ts        # API client with JWT auth
│   │   │   └── chartHelpers.ts
│   │   ├── components/
│   │   │   ├── Auth/         # Login/Register
│   │   │   ├── Chart/        # ChartContainer, TimeframeBar
│   │   │   ├── Watchlist/    # WatchlistPanel, AddTickerModal
│   │   │   ├── Indicators/   # IndicatorPanel, IndicatorConfig
│   │   │   └── Layout/       # AppLayout
│   │   ├── contexts/         # AuthContext
│   │   ├── pages/            # Dashboard, Login
│   │   └── config.ts
│   └── package.json
├── backend/                  # Lambda API (Node.js 20)
│   ├── src/
│   │   ├── index.ts          # Handler + route dispatcher
│   │   ├── routes/           # watchlist, marketdata, quote, chartConfig
│   │   └── services/         # dynamodb, twelvedata, cache
│   └── package.json
├── infra/                    # AWS CDK (TypeScript)
│   ├── bin/app.ts
│   ├── lib/handofmidas-stack.ts
│   └── package.json
├── package.json              # Root workspace
└── README.md                 # This file
```

## 🗑️ Teardown

To completely remove all AWS resources and stop all charges:

```bash
cd infra
npx cdk destroy
```

This removes:
- S3 bucket and all objects
- CloudFront distribution
- Cognito User Pool and all users
- DynamoDB table and all data
- Lambda function
- API Gateway
- SSM Parameter
- EventBridge rule
- All associated IAM roles and policies

> ⚠️ **Warning**: This is irreversible. All user data, watchlists, and cached market data will be
> permanently deleted.

## 🔮 Future Roadmap

- [ ] Custom indicator scripting (mini DSL, Pine Script–like)
- [ ] Price alerts via SNS/SES when a ticker crosses a moving average
- [ ] Multi-chart layouts / saved workspaces
- [ ] Mobile-responsive layout / PWA wrapper
- [ ] WebSocket streaming for real-time price updates
- [ ] Drawing tools (trend lines, Fibonacci retracements)

## 📄 License

MIT
