// ─── API Gateway Lambda Event Types ────────────────────────────────────────────

/** Incoming API Gateway v2 (HTTP API) event. */
export interface APIGatewayProxyEventV2 {
  readonly version: string;
  readonly routeKey: string;
  readonly rawPath: string;
  readonly rawQueryString: string;
  readonly headers: Record<string, string | undefined>;
  readonly queryStringParameters?: Record<string, string | undefined>;
  readonly pathParameters?: Record<string, string | undefined>;
  readonly body?: string;
  readonly isBase64Encoded: boolean;
  readonly requestContext: {
    readonly accountId: string;
    readonly apiId: string;
    readonly authorizer?: {
      readonly jwt?: {
        readonly claims: Record<string, string>;
        readonly scopes?: string[];
      };
    };
    readonly domainName: string;
    readonly domainPrefix: string;
    readonly http: {
      readonly method: string;
      readonly path: string;
      readonly protocol: string;
      readonly sourceIp: string;
      readonly userAgent: string;
    };
    readonly requestId: string;
    readonly routeKey: string;
    readonly stage: string;
    readonly time: string;
    readonly timeEpoch: number;
  };
}

/** Outgoing API Gateway v2 response. */
export interface APIGatewayProxyResultV2 {
  readonly statusCode: number;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly isBase64Encoded?: boolean;
}

// ─── DynamoDB Item Types ───────────────────────────────────────────────────────

/** Base shape for all DynamoDB items in the single-table design. */
export interface DynamoDBBaseItem {
  readonly pk: string;
  readonly sk: string;
}

/** A watchlist entry stored in DynamoDB. */
export interface WatchlistItem extends DynamoDBBaseItem {
  readonly symbol: string;
  readonly addedAt: string;
}

/** A saved chart configuration stored in DynamoDB. */
export interface ChartConfigItem extends DynamoDBBaseItem {
  readonly indicators: IndicatorConfig[];
  readonly updatedAt: string;
}

/** A cached data entry stored in DynamoDB with a TTL. */
export interface CacheItem extends DynamoDBBaseItem {
  readonly data: unknown;
  readonly ttl: number;
  readonly cachedAt: string;
}

// ─── Indicator / Chart Config Types ────────────────────────────────────────────

/** Configuration for a single chart indicator. */
export interface IndicatorConfig {
  /** Indicator type identifier, e.g. "SMA", "EMA", "RSI", "MACD", "BollingerBands". */
  readonly type: string;
  /** Whether this indicator is currently visible on the chart. */
  readonly enabled: boolean;
  /** Indicator-specific parameters (period, stdDev, etc.). */
  readonly params: Record<string, number | string | boolean>;
  /** Display colour (hex string). */
  readonly color?: string;
}

/** Payload accepted by the PUT /api/chart-config/:symbol endpoint. */
export interface ChartConfigPayload {
  readonly indicators: IndicatorConfig[];
}

// ─── Twelve Data API Response Types ────────────────────────────────────────────

/** Supported interval strings for the Twelve Data time series endpoint. */
export type TwelveDataInterval =
  | '1min'
  | '5min'
  | '15min'
  | '30min'
  | '1h'
  | '1day'
  | '1week'
  | '1month';

/** A single OHLCV bar returned by Twelve Data. */
export interface TwelveDataOHLCV {
  readonly datetime: string;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: string;
}

/** Twelve Data /time_series response shape. */
export interface TwelveDataTimeSeriesResponse {
  readonly meta?: {
    readonly symbol: string;
    readonly interval: string;
    readonly currency: string;
    readonly exchange_timezone: string;
    readonly exchange: string;
    readonly mic_code: string;
    readonly type: string;
  };
  readonly values?: TwelveDataOHLCV[];
  readonly status?: string;
  readonly code?: number;
  readonly message?: string;
}

/** Twelve Data /quote response shape. */
export interface TwelveDataQuoteResponse {
  readonly symbol?: string;
  readonly name?: string;
  readonly exchange?: string;
  readonly mic_code?: string;
  readonly currency?: string;
  readonly datetime?: string;
  readonly timestamp?: number;
  readonly open?: string;
  readonly high?: string;
  readonly low?: string;
  readonly close?: string;
  readonly volume?: string;
  readonly previous_close?: string;
  readonly change?: string;
  readonly percent_change?: string;
  readonly average_volume?: string;
  readonly is_market_open?: boolean;
  readonly fifty_two_week?: {
    readonly low: string;
    readonly high: string;
    readonly low_change: string;
    readonly high_change: string;
    readonly low_change_percent: string;
    readonly high_change_percent: string;
    readonly range: string;
  };
  readonly status?: string;
  readonly code?: number;
  readonly message?: string;
}

/** Twelve Data /profile response shape (subset of fields). */
export interface TwelveDataProfileResponse {
  readonly symbol?: string;
  readonly name?: string;
  readonly exchange?: string;
  readonly sector?: string;
  readonly industry?: string;
  readonly employees?: number;
  readonly website?: string;
  readonly description?: string;
  readonly type?: string;
  readonly CEO?: string;
  readonly address?: string;
  readonly city?: string;
  readonly zip?: string;
  readonly state?: string;
  readonly country?: string;
  readonly phone?: string;
  readonly status?: string;
  readonly code?: number;
  readonly message?: string;
}

// ─── Standardised API Response Types ───────────────────────────────────────────

/** A single OHLCV data point in the standardised format returned by our API. */
export interface OHLCVDataPoint {
  readonly datetime: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

/** Response payload for GET /api/market-data/:symbol. */
export interface MarketDataResponse {
  readonly symbol: string;
  readonly interval: string;
  readonly data: OHLCVDataPoint[];
}

/** Response payload for GET /api/quote/:symbol. */
export interface QuoteResponse {
  readonly symbol: string;
  readonly name: string;
  readonly price: number;
  readonly change: number;
  readonly changePercent: number;
}

/** Response payload for GET /api/watchlist. */
export interface WatchlistResponse {
  readonly items: WatchlistEntry[];
}

/** A single entry in the watchlist response. */
export interface WatchlistEntry {
  readonly symbol: string;
  readonly addedAt: string;
}

/** Response payload for GET / PUT /api/chart-config/:symbol. */
export interface ChartConfigResponse {
  readonly symbol: string;
  readonly indicators: IndicatorConfig[];
  readonly updatedAt: string;
}

// ─── Route Handler Signature ───────────────────────────────────────────────────

/** A route handler receives the raw event and returns a result. */
export type RouteHandler = (
  event: APIGatewayProxyEventV2,
) => Promise<APIGatewayProxyResultV2>;
