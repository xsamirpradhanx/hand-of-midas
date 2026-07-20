import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type {
  TwelveDataInterval,
  TwelveDataTimeSeriesResponse,
  TwelveDataQuoteResponse,
  TwelveDataProfileResponse,
} from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_URL = 'https://api.twelvedata.com';
const SSM_PARAM_PATH = '/handofmidas/twelvedata-api-key';

/** Default number of OHLCV bars to return. */
const DEFAULT_OUTPUT_SIZE = 200;

/** Maximum output size accepted by Twelve Data. */
const MAX_OUTPUT_SIZE = 5000;

// ---------------------------------------------------------------------------
// SSM client — initialised outside the handler for reuse.
// ---------------------------------------------------------------------------

const ssmClient = new SSMClient({});

/**
 * In-memory cache for the API key.
 * Populated on first invocation and reused across warm Lambda starts.
 */
let cachedApiKey: string | undefined;

/**
 * Fetch the Twelve Data API key from SSM Parameter Store.
 * The value is cached in module-level memory so subsequent calls on
 * the same warm Lambda instance skip the SSM round-trip.
 *
 * @returns The decrypted API key string.
 * @throws If the parameter cannot be retrieved.
 */
async function getApiKey(): Promise<string> {
  if (cachedApiKey) {
    return cachedApiKey;
  }

  const result = await ssmClient.send(
    new GetParameterCommand({
      Name: SSM_PARAM_PATH,
      WithDecryption: true,
    }),
  );

  const value = result.Parameter?.Value;
  if (!value) {
    throw new Error(
      `Failed to retrieve Twelve Data API key from SSM parameter: ${SSM_PARAM_PATH}`,
    );
  }

  cachedApiKey = value;
  return cachedApiKey;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a full Twelve Data URL with query parameters.
 */
function buildUrl(
  path: string,
  params: Record<string, string | number>,
): string {
  const url = new URL(path, BASE_URL);
  for (const [key, val] of Object.entries(params)) {
    url.searchParams.set(key, String(val));
  }
  return url.toString();
}

/**
 * Execute an authenticated GET request against the Twelve Data API.
 * Throws a descriptive error when the API returns a non-OK status or
 * the response body contains an error payload.
 */
async function fetchTwelveData<T extends { status?: string; code?: number; message?: string }>(
  path: string,
  params: Record<string, string | number>,
): Promise<T> {
  const apiKey = await getApiKey();
  const url = buildUrl(path, { ...params, apikey: apiKey });

  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(
      `Twelve Data API error: ${response.status} ${response.statusText} — ${url}`,
    );
  }

  const data = (await response.json()) as T;

  // Twelve Data sometimes returns 200 with an error body.
  if (data.status === 'error' || data.code !== undefined) {
    throw new Error(
      `Twelve Data API error (code ${data.code ?? 'unknown'}): ${data.message ?? 'Unknown error'}`,
    );
  }

  return data;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch OHLCV time-series data for a given symbol.
 *
 * @param symbol     - Ticker symbol (e.g. "AAPL").
 * @param interval   - Bar interval.
 * @param outputsize - Number of data points (1–5000, default 200).
 * @returns The raw Twelve Data time-series response.
 */
export async function getTimeSeries(
  symbol: string,
  interval: TwelveDataInterval = '1day',
  outputsize: number = DEFAULT_OUTPUT_SIZE,
): Promise<TwelveDataTimeSeriesResponse> {
  const clampedSize = Math.min(Math.max(1, outputsize), MAX_OUTPUT_SIZE);

  return fetchTwelveData<TwelveDataTimeSeriesResponse>('/time_series', {
    symbol,
    interval,
    outputsize: clampedSize,
  });
}

/**
 * Fetch a real-time quote for a given symbol.
 *
 * @param symbol - Ticker symbol (e.g. "AAPL").
 * @returns The raw Twelve Data quote response.
 */
export async function getQuote(
  symbol: string,
): Promise<TwelveDataQuoteResponse> {
  return fetchTwelveData<TwelveDataQuoteResponse>('/quote', { symbol });
}

/**
 * Fetch the company profile for a given symbol.
 *
 * @param symbol - Ticker symbol (e.g. "AAPL").
 * @returns The raw Twelve Data profile response.
 */
export async function getProfile(
  symbol: string,
): Promise<TwelveDataProfileResponse> {
  return fetchTwelveData<TwelveDataProfileResponse>('/profile', { symbol });
}
