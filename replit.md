# Hand of Midas

**Personal Stock Watchlist & Charting App** with TradingView-style interactive charts, technical indicators, and a golden Greek mythology aesthetic.

## Stack

- **Frontend**: React + Vite + TypeScript, `lightweight-charts` v5 for candlestick/OHLC charts
- **Backend**: Node.js 20, designed for AWS Lambda (local dev via Express wrapper in `backend/src/local.ts`)
- **Infra**: AWS CDK (TypeScript) — deploys Lambda, API Gateway, Cognito, DynamoDB, S3/CloudFront
- **Auth**: Amazon Cognito (JWT-gated API)
- **Data**: Yahoo Finance (`yahoo-finance2`) + optional Twelve Data API

## Running locally on Replit

The frontend runs on port 5000 via the **Start application** workflow (`cd frontend && npm install && npm run dev`).

The backend requires AWS credentials and environment variables (see below). Without them, the app renders the login page but auth actions will fail.

### Required environment variables (for full functionality)

Set these in the Secrets panel:

| Variable | Description |
|---|---|
| `VITE_COGNITO_USER_POOL_ID` | AWS Cognito User Pool ID |
| `VITE_COGNITO_CLIENT_ID` | AWS Cognito App Client ID |
| `VITE_API_URL` | API Gateway base URL (e.g. `https://xxx.execute-api.us-east-1.amazonaws.com`) |
| `VITE_AWS_REGION` | AWS region (default: `us-east-1`) |

### Running the backend locally

```bash
cd backend && npm install && npm run dev
```
Starts an Express server on port 3000 that simulates the Lambda handler. Requires AWS credentials configured in the environment (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION`).

## Project structure

```
frontend/   React + Vite SPA
backend/    Lambda handler + routes + services
infra/      AWS CDK stack
```

## Deploying to AWS

```bash
cd infra && npx cdk deploy
```

Requires `aws configure` credentials with permissions to create Lambda, API Gateway, Cognito, DynamoDB, S3, CloudFront, SSM, IAM, and EventBridge resources.

## User preferences

- Golden Greek aesthetic: Cinzel font for headings/branding, rich amber/gold color palette
- Dark deep-navy/near-black background
- Watchlist items show price, % change, and $ change together
